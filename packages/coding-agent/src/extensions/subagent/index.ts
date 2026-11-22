/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses RPC subprocesses to retain worker conversations between prompts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { formatReadLineRange } from "../../core/tools/render-utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "../../core/tools/truncate.ts";
import { getMarkdownTheme, type Theme, type ThemeColor } from "../../modes/interactive/theme/theme.ts";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { captureSubagentContext, turnSchema } from "./context.ts";
import { createSubagentDispatch, dropBlankSelections, type ModelChoice, reasoningEffortSchema } from "./dispatch.ts";
import { registerModelSearch } from "./model-search.ts";
import { type ModelTier, modelTierSchema } from "./model-tiers.ts";
import {
	aggregateUsage,
	cacheHitRate,
	type DispatchDefaults,
	emptyUsage,
	getFinalOutput,
	type OnUpdateCallback,
	type ResolvedAgent,
	type SingleResult,
	type SubagentDetails,
} from "./runner.ts";
import { type SessionPanelResult, SubagentSessionPanel } from "./session-panel.ts";
import { DELEGATION_TOOLS, getWorkerTeam, registerTeamTools, revealTools } from "./team.ts";
import { classifyTiers, type TierOverride, type TierRequest, withRating } from "./tier-classifier.ts";
import { registerWorkerCache } from "./worker-cache.ts";
import { connectWorkerChannel } from "./worker-channel.ts";
import { registerWorkerPrompt, WORKER_FLAG } from "./worker-prompt.ts";
import { showWorkerView } from "./worker-view.ts";

const MAX_PARALLEL_TASKS = 8;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const TRUNCATION_NOTICE_RESERVE = 256;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatPercent(rate: number): string {
	return `${(rate * 100).toFixed(1)}%`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		firstCacheHitRate?: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	// A rate of 0% is the signal of a missed cache, so it is shown whenever prompt tokens were counted.
	if (usage.input + usage.cacheRead + usage.cacheWrite > 0) {
		const first = usage.firstCacheHitRate === undefined ? "" : ` (first ${formatPercent(usage.firstCacheHitRate)})`;
		parts.push(`CH${formatPercent(cacheHitRate(usage))}${first}`);
	}
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset, args.limit);
			let text = themeFg("accent", filePath);
			if (lineRange) {
				text += themeFg("warning", lineRange);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function isFailedResult(result: SingleResult): boolean {
	return result.status === "failed" || result.status === "aborted";
}

function getFailureEvidence(result: SingleResult): string {
	const evidence: string[] = [];
	const seen = new Set<string>();
	const add = (label: string, value: string | undefined) => {
		const text = value?.trim();
		if (!text || seen.has(text)) return;
		seen.add(text);
		evidence.push(`${label}: ${text}`);
	};

	add("Error", result.errorMessage);
	add("Signal", result.terminationSignal);
	add("stderr", result.stderr);
	add("Assistant output", getFinalOutput(result.messages));
	return evidence.join("\n\n") || "(no output)";
}

function getFailureSummary(result: SingleResult): string {
	return (
		result.errorMessage?.trim() ||
		(result.terminationSignal ? `Terminated by signal ${result.terminationSignal}` : "") ||
		result.stderr.trim() ||
		getFinalOutput(result.messages) ||
		"(no output)"
	);
}

function getResultOutput(result: SingleResult): string {
	const output = isFailedResult(result)
		? getFailureEvidence(result)
		: getFinalOutput(result.messages) || "(no output)";
	return result.workerId ? `Worker ${result.workerId}\n${output}` : output;
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function truncateModelOutput(output: string): string {
	const initial = truncateHead(output);
	if (!initial.truncated) return output;

	const body = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES - 2,
		maxBytes: DEFAULT_MAX_BYTES - TRUNCATION_NOTICE_RESERVE,
	});
	const omittedBytes = initial.totalBytes - body.outputBytes;
	const notice = `[Output truncated: ${omittedBytes} bytes omitted. Full output preserved in tool details.]`;
	return body.content ? `${body.content}\n\n${notice}` : notice;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function resolveAgent(defaultCwd: string, scope: AgentScope, name: string, cwd?: string): ResolvedAgent<AgentConfig> {
	const effectiveCwd = path.resolve(defaultCwd, cwd ?? ".");
	const discovery = discoverAgents(effectiveCwd, scope);
	return {
		agent: discovery.agents.find((candidate) => candidate.name === name),
		available: discovery.agents,
		cwd: effectiveCwd,
	};
}

const dispatchProperties = {
	model: Type.Optional(
		Type.String({
			description:
				"Model ID, unique name, or family alias such as sol, opus or flash (newest of that family) on the current account. Use search_models to discover models. An explicit provider/model ID opts into that route. Overrides the agent profile model.",
		}),
	),
	tier: Type.Optional(modelTierSchema),
	reasoningEffort: Type.Optional(reasoningEffortSchema),
	turn: Type.Optional(turnSchema),
};

const TaskItem = Type.Object({
	...dispatchProperties,
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	...dispatchProperties,
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	...dispatchProperties,
	background: Type.Optional(
		Type.Boolean({ description: "Run single or parallel tasks in the background and return job IDs immediately." }),
	),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

interface CallRenderState {
	call?: Text;
	modelChoices?: ModelChoice[];
}

function modelBadge(choice: ModelChoice | undefined, theme: Theme): string {
	if (!choice) return "";
	const parts = [choice.method === "explicit" ? "explicit model" : "auto model"];
	if (choice.decision) {
		const outcome =
			choice.decision.outcome === "rated tier" && choice.method !== "auto"
				? "tier unavailable"
				: choice.decision.outcome;
		parts.push(`decision: ${choice.decision.modelId}${outcome === "rated tier" ? "" : ` (${outcome})`}`);
	}
	if (choice.tier)
		parts.push(
			`${choice.method === "explicit tier" ? "explicit tier" : choice.method === "auto" ? "tier" : "default tier"}: ${choice.tier}`,
		);
	else if (choice.method === "profile" || choice.method === "inherited") parts.push(choice.method);
	parts.push(choice.modelId, `${choice.explicitEffort ? "explicit effort" : "effort"}: ${choice.effort}`);
	return theme.fg("muted", ` [${parts.join(" · ")}]`);
}

function formatCall(
	args: Static<typeof SubagentParams>,
	state: CallRenderState,
	expanded: boolean,
	theme: Theme,
): string {
	const title = theme.fg("toolTitle", theme.bold("subagent "));
	const scope = theme.fg("muted", ` [${args.agentScope ?? "user"}]`);
	const chain = args.chain?.length ? args.chain : undefined;
	const items = chain ?? args.tasks;
	if (items?.length) {
		const mode = chain ? `chain (${items.length} steps)` : `parallel (${items.length} tasks)`;
		let text = title + theme.fg("accent", mode) + scope;
		const count = expanded ? items.length : Math.min(items.length, 3);
		for (let i = 0; i < count; i++) {
			const item = items[i];
			// Arguments may still be streaming before execution starts.
			const task = chain ? item.task?.replace(/\{previous\}/g, "").trim() : item.task;
			const prefix = chain ? `${theme.fg("muted", `${i + 1}.`)} ` : "";
			const preview = task && task.length > 40 ? `${task.slice(0, 40)}...` : (task ?? "...");
			text += `\n  ${prefix}${theme.fg("accent", item.agent || "...")}${modelBadge(state.modelChoices?.[i], theme)}${theme.fg("dim", ` ${preview}`)}`;
		}
		if (count < items.length) text += `\n  ${theme.fg("muted", `... +${items.length - count} more`)}`;
		return text;
	}
	const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
	return (
		title +
		theme.fg("accent", args.agent || "...") +
		modelBadge(state.modelChoices?.[0], theme) +
		scope +
		`\n  ${theme.fg("dim", preview)}`
	);
}

// Calls that start workers; the first one on a branch reveals DELEGATION_TOOLS.
const DELEGATING_TOOLS = new Set(["subagent", "assign_tasks", "assign_task"]);
// The subagent tool's loadout change until the branch delegates: requests leave out the follow-up tools.
const HIDE_DELEGATION_TOOLS = { hiddenDeclarations: DELEGATION_TOOLS };

export default function (pi: ExtensionAPI) {
	const dispatch = createSubagentDispatch(pi);
	registerModelSearch(pi, dispatch);
	// A worker's system prompt is its agent prompt and its tools are its agent's tools plus messaging,
	// so workers of one agent type and model share a request head with each other, not with main.
	const requestParent = connectWorkerChannel(pi);
	registerTeamTools(pi, requestParent, dispatch);
	registerWorkerPrompt(pi);
	registerWorkerCache(pi, requestParent);
	pi.registerCommand("subagents", {
		description: "Open worker sessions, list them without a UI, or cancel <id>|all",
		handler: async (args, ctx) => {
			const jobs = getWorkerTeam(pi, ctx);
			const parts = args.trim().split(/\s+/);
			if (parts[0] === "cancel") {
				const ids = parts[1] === "all" ? jobs.list().map((job) => job.id) : parts[1] ? [parts[1]] : [];
				if (!ids.length) {
					ctx.ui.notify("Usage: /subagents cancel <id>|all", "info");
					return;
				}
				const statuses = await Promise.all(ids.map(async (id) => `${id}: ${await jobs.cancel(id)}`));
				ctx.ui.notify(statuses.join("\n"), "info");
				return;
			}
			if (!args.trim() && ctx.mode === "tui") {
				const choice = await ctx.ui.custom<SessionPanelResult>(
					(tui, uiTheme, keybindings, done) => new SubagentSessionPanel(tui, uiTheme, keybindings, jobs, done),
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: "94%", maxHeight: "90%" },
						blocked: { kind: "question", message: "View subagent sessions" },
					},
				);
				if (choice.kind === "worker") showWorkerView(ctx.ui, jobs, choice.workerId);
				else if (choice.kind === "main") ctx.ui.setMainView(undefined);
				return;
			}
			ctx.ui.notify(
				jobs
					.list()
					.map((job) => `${job.id}: ${job.status}, ${job.name}`)
					.join("\n") || "No workers.",
				"info",
			);
		},
	});
	// Whether this branch has delegated. Read from the branch so resume and /tree keep it.
	let delegated = false;
	const syncDelegated = (_event: unknown, ctx: ExtensionContext) => {
		const next = ctx.sessionManager
			.getBranch()
			.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					DELEGATING_TOOLS.has(entry.message.toolName),
			);
		if (next === delegated) return;
		delegated = next;
		pi.setActiveTools(pi.getActiveTools());
	};
	pi.on("session_start", syncDelegated);
	pi.on("session_tree", syncDelegated);
	pi.on("tool_result", (event) => {
		if (!DELEGATING_TOOLS.has(event.toolName)) return;
		// The first delegation, even a failed one, reveals the follow-up tools, so an unknown model can be looked up.
		let revealed: string | undefined;
		if (!delegated) {
			delegated = true;
			revealed = revealTools(pi, DELEGATION_TOOLS, "Here are the relevant tools for subagents:");
		}
		// Tool execute results cannot set runtime error state directly, so patch it through the result hook.
		const isError = event.toolName === "subagent" && (event.details as SubagentDetails | undefined)?.isError;
		if (!revealed && !isError) return;
		return {
			...(isError && { isError: true }),
			...(revealed && { content: [...event.content, { type: "text" as const, text: revealed }] }),
		};
	});

	pi.registerTool<typeof SubagentParams, SubagentDetails, CallRenderState>({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Bundled agents: explorer (read-only codebase search), worker (multi-step tasks), critic (review of finished changes), crazy (extremely hard problems and deep research). User and project definitions can override these names.",
			"The harness picks each agent's model and reasoning effort from its tier, so a call needs only agent and task. Set tier, model or reasoningEffort only to override that: tier when a task is clearly easier or harder than its agent assumes, model or reasoningEffort when the user asks for one. search_models lists what the account serves when a named model does not resolve.",
			"Use background: true for independent work while you continue, then receive each result automatically. Use foreground execution when your next step needs the result immediately.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Relevant subagent tools will be declared after your first call.",
			"Overrides and turn apply at the top level or per task or chain step. turn: 0 starts fresh with only the task, -1 also gives the subagent a copy of the conversation so far with tool outputs shortened, and a positive turn number gives that copy up to a checkpoint from get_subagent_context, including task completions or reviewed milestones. The copy is captured at submission. Use list_agents, send_agent_message, interrupt_agent, continue_agent, steer_agent, and change_agent_model to coordinate workers by ID. change_agent_model changes an idle or interrupted worker's model without losing its conversation; interrupt active workers first.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,
		prepareArguments: dropBlankSelections,
		prepareLoadout: () => (delegated ? undefined : HIDE_DELEGATION_TOOLS),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (pi.getFlag(WORKER_FLAG))
				return {
					content: [{ type: "text", text: "Subagent workers cannot delegate further tasks." }],
					details: { mode: "single", results: [], usage: emptyUsage(), isError: true },
				};
			const team = getWorkerTeam(pi, ctx);
			const notifyResult = (result: SingleResult, workerId: string) => {
				const usage = formatUsageStats(result.usage, result.model);
				pi.sendMessage(
					{
						customType: "subagent-result",
						display: true,
						content: `Subagent ${workerId} (${result.agent}): ${result.status}\n\n${getResultOutput(result)}${usage ? `\n\nUsage: ${usage}` : ""}`,
						details: { workerId, result },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			};
			const runForeground = async (
				defaults: DispatchDefaults,
				resolved: ResolvedAgent,
				name: string,
				task: string,
				step: number | undefined,
				runSignal: AbortSignal | undefined,
				update: OnUpdateCallback | undefined,
				details: (results: SingleResult[]) => SubagentDetails,
			) => {
				let firstRun = true;
				const worker = team.spawn({
					name,
					task,
					defaults,
					resolved,
					step,
					onUpdate: update,
					makeDetails: details,
					onResult(result, workerId) {
						if (!firstRun) notifyResult(result, workerId);
						firstRun = false;
					},
				});
				const cancel = () => {
					void team.cancel(worker.id);
				};
				if (runSignal?.aborted) cancel();
				else runSignal?.addEventListener("abort", cancel, { once: true });
				try {
					return await worker.result;
				} finally {
					runSignal?.removeEventListener("abort", cancel);
				}
			};
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			let modelChoices: ModelChoice[] | undefined;
			const makeDetails =
				(mode: "single" | "parallel" | "chain", forceError = false) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					...(modelChoices && { modelChoices }),
					results,
					usage: aggregateUsage(results),
					isError: forceError || results.some(isFailedResult),
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single", true)([]),
				};
			}

			const resolvedChain = (params.chain ?? []).map((step) =>
				resolveAgent(ctx.cwd, agentScope, step.agent, step.cwd),
			);
			const resolvedTasks = (params.tasks ?? []).map((task) =>
				resolveAgent(ctx.cwd, agentScope, task.agent, task.cwd),
			);
			const resolvedSingle = params.agent ? resolveAgent(ctx.cwd, agentScope, params.agent, params.cwd) : undefined;
			const captureDefaults = (
				selection: {
					model?: string;
					tier?: typeof params.tier;
					reasoningEffort?: typeof params.reasoningEffort;
					turn?: number;
				},
				resolved: ResolvedAgent<AgentConfig>,
				rating: TierOverride | undefined,
			) => ({
				...dispatch.resolveWithChoice(
					{
						model: selection.model ?? params.model,
						tier: selection.tier ?? params.tier,
						reasoningEffort: selection.reasoningEffort ?? params.reasoningEffort,
					},
					ctx,
					// The rated tier replaces the profile's tier, and the rated effort the effort of its tier row;
					// neither is a choice of the caller, so an explicit model, tier or reasoningEffort still wins.
					withRating(resolved.agent, rating),
				),
				context: captureSubagentContext(selection.turn ?? params.turn, ctx),
				extraArgs: ["--subagent-worker", "--planning-worker"],
			});
			const tierRequest = (
				item: { task?: string; model?: string; tier?: ModelTier },
				resolved: ResolvedAgent<AgentConfig> | undefined,
			): TierRequest | undefined =>
				resolved?.agent && item.task !== undefined
					? {
							agent: resolved.agent,
							work: { kind: "task", task: item.task },
							model: item.model ?? params.model,
							tier: item.tier ?? params.tier,
						}
					: undefined;

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				let selectedAgents: ResolvedAgent<AgentConfig>[] = [];
				if (hasChain) selectedAgents = resolvedChain;
				else if (hasTasks) selectedAgents = resolvedTasks;
				else if (resolvedSingle) selectedAgents = [resolvedSingle];
				const projectAgentsByPath = new Map<string, AgentConfig>();
				for (const resolved of selectedAgents) {
					if (resolved.agent?.source === "project") {
						projectAgentsByPath.set(resolved.agent.filePath, resolved.agent);
					}
				}

				const trustedProjectAgentsDir =
					ctx.isProjectTrusted() && discovery.projectAgentsDir
						? fs.realpathSync(discovery.projectAgentsDir)
						: undefined;
				const projectAgentsRequested = Array.from(projectAgentsByPath.values()).filter(
					(agent) =>
						!trustedProjectAgentsDir || fs.realpathSync(path.dirname(agent.filePath)) !== trustedProjectAgentsDir,
				);
				if (projectAgentsRequested.length > 0) {
					const sources = projectAgentsRequested.map((agent) => `- ${agent.name}: ${agent.filePath}`).join("\n");
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Sources:\n${sources}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
					}
				}
			}

			// The classifier sees the tasks only once the call is approved, and rates all of them at once.
			const [chainTiers, taskTiers, singleTiers] = await Promise.all([
				classifyTiers(
					pi,
					dispatch,
					(params.chain ?? []).map((step, index) => tierRequest(step, resolvedChain[index])),
					ctx,
					signal,
				),
				classifyTiers(
					pi,
					dispatch,
					(params.tasks ?? []).map((task, index) => tierRequest(task, resolvedTasks[index])),
					ctx,
					signal,
				),
				classifyTiers(pi, dispatch, [tierRequest(params, resolvedSingle)], ctx, signal),
			]);
			// Resolve every control before any job is submitted or any chain step starts.
			const chainDefaults = (params.chain ?? []).map((step, index) =>
				captureDefaults(step, resolvedChain[index], chainTiers[index]),
			);
			const taskDefaults = (params.tasks ?? []).map((task, index) =>
				captureDefaults(task, resolvedTasks[index], taskTiers[index]),
			);
			const singleDefaults = resolvedSingle ? captureDefaults(params, resolvedSingle, singleTiers[0]) : undefined;

			if (params.background) {
				if (hasChain)
					return {
						content: [{ type: "text", text: "Background execution supports single and parallel modes only." }],
						details: makeDetails("chain", true)([]),
					};
				if (signal?.aborted)
					return {
						content: [{ type: "text", text: "Background dispatch cancelled." }],
						details: makeDetails(hasTasks ? "parallel" : "single", true)([]),
					};
				const tasks = hasTasks ? params.tasks! : [{ agent: params.agent!, task: params.task! }];
				if (tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` },
						],
						details: makeDetails("parallel", true)([]),
					};
				const resolved = hasTasks ? resolvedTasks : [resolvedSingle!];
				const defaults = hasTasks ? taskDefaults : [singleDefaults!];
				if (resolved.some((item) => !item.agent))
					return {
						content: [{ type: "text", text: "Unknown agent. No background jobs were started." }],
						details: makeDetails(hasTasks ? "parallel" : "single", true)([]),
					};
				modelChoices = defaults.map((item) => item.modelChoice);
				const jobIds = tasks.map(
					(task, index) =>
						team.spawn({
							name: task.agent,
							task: task.task,
							resolved: resolved[index],
							defaults: defaults[index],
							onResult: notifyResult,
						}).id,
				);
				const configurations = defaults.map((item, index) => ({
					jobId: jobIds[index],
					model: item.model,
					reasoningEffort: item.thinkingLevel,
					turn: (hasTasks ? params.tasks?.[index].turn : params.turn) ?? params.turn ?? 0,
				}));
				return {
					content: [
						{
							type: "text",
							text: `Background jobs started: ${jobIds.join(", ")}. Results will arrive automatically. Use /subagents to list jobs or /subagents cancel <id>|all.\n${JSON.stringify(configurations)}`,
						},
					],
					details: { ...makeDetails(hasTasks ? "parallel" : "single")([]), jobIds, configurations },
				};
			}

			if (params.chain && params.chain.length > 0) {
				modelChoices = chainDefaults.map((item) => item.modelChoice);
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runForeground(
						chainDefaults[i],
						resolvedChain[i],
						step.agent,
						taskWithContext,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{
									type: "text",
									text: truncateModelOutput(`Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`),
								},
							],
							details: makeDetails("chain")(results),
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [
						{
							type: "text",
							text: truncateModelOutput(getResultOutput(results[results.length - 1])),
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel", true)([]),
					};

				modelChoices = taskDefaults.map((item) => item.modelChoice);
				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						status: "pending",
						exitCode: null,
						messages: [],
						stderr: "",
						usage: emptyUsage(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((result) => result.status === "running").length;
						const pending = allResults.filter((result) => result.status === "pending").length;
						const done = allResults.length - running - pending;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running, ${pending} pending...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await Promise.all(
					params.tasks.map(async (t, index) => {
						const result = await runForeground(
							taskDefaults[index],
							resolvedTasks[index],
							t.agent,
							t.task,
							undefined,
							signal,
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
						);
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					}),
				);

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status =
						isFailedResult(r) && r.stopReason && r.stopReason !== "end"
							? `${r.status} (${r.stopReason})`
							: r.status;
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task && resolvedSingle && singleDefaults) {
				modelChoices = [singleDefaults.modelChoice];
				const result = await runForeground(
					singleDefaults,
					resolvedSingle,
					params.agent,
					params.task,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: truncateModelOutput(`Agent ${result.stopReason || result.status}: ${errorMsg}`),
							},
						],
						details: makeDetails("single")([result]),
					};
				}
				return {
					content: [
						{
							type: "text",
							text: truncateModelOutput(getResultOutput(result)),
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single", true)([]),
			};
		},

		renderCall(args, theme, { state, expanded }) {
			state.call ??= new Text("", 0, 0);
			state.call.setText(formatCall(args, state, expanded, theme));
			return state.call;
		},

		renderResult(result, { expanded }, theme, { state, args }) {
			const details = result.details;
			// The call renderer runs first, including on session replay. Update that same header before it is drawn.
			if (details?.modelChoices && details.modelChoices !== state.modelChoices) {
				state.modelChoices = details.modelChoices;
				state.call?.setText(formatCall(args, state, expanded, theme));
			}
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const resultIcon = (child: SingleResult): string => {
				if (child.status === "pending" || child.status === "running") {
					return theme.fg("warning", "[running]");
				}
				if (isFailedResult(child)) return theme.fg("error", "[failed]");
				return theme.fg("success", "[done]");
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const isRunning = r.status === "pending" || r.status === "running";
				const icon = resultIcon(r);
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isRunning) header += ` ${theme.fg("warning", `[${r.status}]`)}`;
					else if (isError) header += ` ${theme.fg("error", `[${r.stopReason ?? r.status}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					if (r.terminationSignal)
						container.addChild(new Text(theme.fg("error", `Signal: ${r.terminationSignal}`), 0, 0));
					if (r.stderr.trim()) container.addChild(new Text(theme.fg("error", `stderr: ${r.stderr.trim()}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isRunning) text += ` ${theme.fg("warning", `[${r.status}]`)}`;
				else if (isError) text += ` ${theme.fg("error", `[${r.stopReason ?? r.status}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "chain") {
				const successCount = details.results.filter((result) => result.status === "completed").length;
				const hasActive = details.results.some(
					(result) => result.status === "pending" || result.status === "running",
				);
				let icon = theme.fg("error", "[failed]");
				if (hasActive) icon = theme.fg("warning", "[running]");
				else if (successCount === details.results.length) icon = theme.fg("success", "[done]");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = resultIcon(r);
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (isFailedResult(r) && r.errorMessage)
							container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
						if (r.terminationSignal)
							container.addChild(new Text(theme.fg("error", `Signal: ${r.terminationSignal}`), 0, 0));
						if (r.stderr.trim())
							container.addChild(new Text(theme.fg("error", `stderr: ${r.stderr.trim()}`), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = resultIcon(r);
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) {
						const failed = isFailedResult(r);
						const summary = failed ? getFailureSummary(r) : "(no output)";
						text += `\n${theme.fg(failed ? "error" : "muted", summary)}`;
					} else {
						text += `\n${renderDisplayItems(displayItems, 5)}`;
					}
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((result) => result.status === "running").length;
				const pending = details.results.filter((result) => result.status === "pending").length;
				const successCount = details.results.filter((result) => result.status === "completed").length;
				const failCount = details.results.filter(isFailedResult).length;
				const isRunning = running > 0 || pending > 0;
				let icon = theme.fg("success", "[done]");
				if (isRunning) icon = theme.fg("warning", "[running]");
				else if (failCount > 0) icon = theme.fg("warning", "[partial]");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running, ${pending} pending`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = resultIcon(r);
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (isFailedResult(r) && r.errorMessage)
							container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
						if (r.terminationSignal)
							container.addChild(new Text(theme.fg("error", `Signal: ${r.terminationSignal}`), 0, 0));
						if (r.stderr.trim())
							container.addChild(new Text(theme.fg("error", `stderr: ${r.stderr.trim()}`), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon = resultIcon(r);
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) {
						const failed = isFailedResult(r);
						let summary = "(no output)";
						if (r.status === "pending") summary = "(pending...)";
						else if (r.status === "running") summary = "(running...)";
						else if (failed) summary = getFailureSummary(r);
						text += `\n${theme.fg(failed ? "error" : "muted", summary)}`;
					} else {
						text += `\n${renderDisplayItems(displayItems, 5)}`;
					}
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
