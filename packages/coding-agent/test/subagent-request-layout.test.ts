import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	getInitialSystemMessage,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { discoverBundledAgents } from "../src/extensions/subagent/agents.ts";
import { captureSubagentContext } from "../src/extensions/subagent/context.ts";
import { createSubagentDispatch } from "../src/extensions/subagent/dispatch.ts";
import { renderParentConversation } from "../src/extensions/subagent/parent-conversation.ts";
import { registerTeamTools } from "../src/extensions/subagent/team.ts";
import {
	registerWorkerPrompt,
	WORKER_CONVERSATION_ENV,
	WORKER_FLAG,
} from "../src/extensions/subagent/worker-prompt.ts";
import { workerTools } from "../src/extensions/subagent/worker-tools.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const sampleHistory: AgentMessage[] = [
	{ role: "system", content: "Main system prompt", timestamp: 1 },
	{ role: "user", content: "Read the route.\nKeep the response shape.", timestamp: 2 },
	fauxAssistantMessage([
		fauxThinking("Private reasoning"),
		fauxText("I will read the route first."),
		fauxToolCall("read", { path: "src/route.ts" }, { id: "read-call" }),
	]),
	{
		role: "toolResult",
		toolCallId: "read-call",
		toolName: "read",
		content: [{ type: "text", text: "0123456789".repeat(21) }],
		isError: false,
		timestamp: 3,
	},
	fauxAssistantMessage("The route returns all rows.\nI will add pagination."),
];

describe("subagent request layout", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	function temporaryDirectory(): string {
		const directory = mkdtempSync(join(tmpdir(), "pi-worker-layout-"));
		directories.push(directory);
		return directory;
	}

	async function worker(cwd: string, conversation?: string): Promise<Harness> {
		const conversationPath = join(cwd, "conversation.txt");
		if (conversation !== undefined) writeFileSync(conversationPath, conversation);
		vi.stubEnv(WORKER_CONVERSATION_ENV, conversation === undefined ? "" : conversationPath);
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				registerWorkerPrompt(pi);
				registerTeamTools(pi, async () => [], createSubagentDispatch(pi));
			},
			createToolSearchExtension(),
			(pi) => {
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.sections.main_only = "Main agent instructions";
				});
			},
		]);
		extensionsResult.runtime.flagValues.set(WORKER_FLAG, true);
		const agent = discoverBundledAgents().find((candidate) => candidate.name === "worker")!;
		const tools = workerTools(agent.tools);
		const harness = await createHarness({
			cwd,
			initialActiveToolNames: tools,
			allowedToolNames: tools,
			resourceLoader: {
				...createTestResourceLoader({ extensionsResult }),
				getSystemPrompt: () => agent.systemPrompt,
				getAppendSystemPrompt: () => ["Main append prompt"],
				getAgentsFiles: () => ({ agentsFiles: [{ path: join(cwd, "AGENTS.md"), content: "Project rules" }] }),
				getSkills: () => ({
					skills: [
						{
							name: "main-skill",
							description: "Main skill",
							filePath: join(cwd, "skill.md"),
							baseDir: cwd,
							sourceInfo: createSyntheticSourceInfo(join(cwd, "skill.md"), { source: "test" }),
							disableModelInvocation: false,
						},
					],
					diagnostics: [],
				}),
			},
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	function capture(harness: Harness): TranscriptContext[] {
		const requests: TranscriptContext[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		return requests;
	}

	it("renders the exact stripped reference and preserves full user and assistant text", () => {
		expect(renderParentConversation(sampleHistory)).toBe(
			[
				'<parent_conversation note="The main agent\'s conversation, given for reference. Tool outputs are shortened.">',
				"[user] Read the route.\nKeep the response shape.",
				"[assistant] I will read the route first.",
				'[tool call] read {"path":"src/route.ts"}',
				`[tool result] ${"0123456789".repeat(20)} … [10 characters cut]`,
				"[assistant] The route returns all rows.\nI will add pagination.",
				"</parent_conversation>",
			].join("\n"),
		);
	});

	it("bounds canonical arguments and counts cut Unicode characters without splitting them", () => {
		const history: AgentMessage[] = [
			{ role: "user", content: "u".repeat(700), timestamp: 0 },
			fauxAssistantMessage([
				fauxText(" \n"),
				fauxText("a".repeat(700)),
				fauxToolCall("write", { z: "z".repeat(600), a: { z: 1, a: 2 } }),
			]),
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "write",
				content: [{ type: "text", text: "𝒜".repeat(201) }],
				isError: false,
				timestamp: 0,
			},
		];
		const rendered = renderParentConversation(history);
		expect(rendered).toContain(`[user] ${"u".repeat(700)}`);
		expect(rendered).toContain("[assistant]  \n");
		expect(rendered).toContain(`[assistant] ${"a".repeat(700)}`);
		expect(rendered).toContain('[tool call] write {"a":{"a":2,"z":1},"z":"');
		expect(rendered).toContain("… [126 characters cut]");
		expect(rendered).toContain(`[tool result] ${"𝒜".repeat(200)} … [1 characters cut]`);
	});

	it.each([false, true])(
		"sends its own system prompt and tools with inherited conversation: %s",
		async (inherited) => {
			const cwd = temporaryDirectory();
			const reference = inherited ? renderParentConversation(sampleHistory) : undefined;
			const harness = await worker(cwd, reference);
			const requests = capture(harness);
			await harness.session.prompt("Implement pagination.");
			const request = requests[0];
			const head = getInitialSystemMessage(request.messages)!;
			const prompt = getSystemMessageText(head);
			const agent = discoverBundledAgents().find((candidate) => candidate.name === "worker")!;
			expect(prompt.startsWith(agent.systemPrompt)).toBe(true);
			expect(prompt).toContain("<project_context>\nProject-specific instructions and guidelines:");
			expect(prompt).toContain("Project rules");
			expect(prompt.endsWith(`<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`)).toBe(true);
			expect(prompt).not.toMatch(/Main agent instructions|Main append prompt|main-skill|Pi documentation/);
			expect(head.toolsAdded?.map((tool) => tool.name)).toEqual(workerTools(agent.tools));
			expect(request.messages.map((message) => message.role)).toEqual(["system", "user"]);
			expect(request.messages[1]).toMatchObject({
				role: "user",
				content: inherited
					? [
							{ type: "text", text: reference },
							{ type: "text", text: "Implement pagination." },
						]
					: [{ type: "text", text: "Implement pagination." }],
			});
		},
	);

	it("keeps the complete shared request prefix byte identical for siblings given the same parent cutoff", async () => {
		const cwd = temporaryDirectory();
		const parent = await createHarness({ cwd });
		harnesses.push(parent);
		parent.setResponses([fauxAssistantMessage("parent answer")]);
		await parent.session.prompt("parent question");
		// Context capture only reads the session manager from the extension context.
		const context = { sessionManager: parent.sessionManager } as unknown as ExtensionContext;
		const prefixes: string[] = [];
		for (const task of ["first task", "second task"]) {
			const snapshot = captureSubagentContext(2, context);
			if (snapshot.mode === "fresh") throw new Error("Expected inherited context");
			const harness = await worker(cwd, snapshot.conversation);
			const requests = capture(harness);
			await harness.session.prompt(task);
			const firstUser = requests[0].messages.find((message) => message.role === "user")!;
			const head = getInitialSystemMessage(requests[0].messages)!;
			prefixes.push(
				JSON.stringify({
					system: getSystemMessageText(head),
					tools: head.toolsAdded,
					reference: firstUser.content[0],
				}),
			);
		}
		expect(prefixes[0]).toBe(prefixes[1]);
	});

	it("projects the reference once per request without adding it to the worker transcript", async () => {
		const reference = renderParentConversation(sampleHistory);
		const harness = await worker(temporaryDirectory(), reference);
		for (const task of ["first task", "next task"]) {
			const requests = capture(harness);
			await harness.session.prompt(task);
			const firstUser = requests[0].messages.find((message) => message.role === "user")!;
			expect(firstUser.content).toEqual([
				{ type: "text", text: reference },
				{ type: "text", text: "first task" },
			]);
			expect(JSON.stringify(requests[0].messages).split("<parent_conversation")).toHaveLength(2);
			expect(JSON.stringify(harness.session.messages)).not.toContain("<parent_conversation");
		}
	});

	it("sorts custom restrictions and keeps every delegation or planning tool undeclared", () => {
		expect(workerTools(undefined)).toEqual([
			"bash",
			"edit",
			"list_agents",
			"read",
			"send_agent_message",
			"tool_search",
			"write",
		]);
		expect(
			workerTools([
				"read",
				"bash",
				"read",
				"subagent",
				"get_plan",
				"assign_tasks",
				"interrupt_agent",
				"continue_agent",
				"steer_agent",
				"change_agent_model",
				"create_plan",
				"revise_plan",
				"task_update",
				"cancel_tasks",
				"get_subagent_context",
				"checkpoint_context",
				"mcp__docs__search",
				"*",
				"read_mcp_resource",
			]),
		).toEqual(["bash", "list_agents", "read", "send_agent_message"]);
	});
});
