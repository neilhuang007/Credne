// Runs persistent isolated Pi RPC workers with private sessions and parent messaging.
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type Message, type Model, type Usage, uuidv7 } from "@earendil-works/pi-ai";
import { ToolCallArgumentsStream } from "@earendil-works/pi-ai/utils/streaming-json";
import { Value } from "typebox/value";
import { APP_NAME, getRuntimePackageDir, isBunBinary, USES_BROKER_AUTH } from "../../config.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "../../core/session-manager.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { createUsageTotals, type UsageTotals } from "../../core/usage-totals.ts";
import type { JsonAgentSessionEvent } from "../../modes/json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../../modes/rpc/jsonl.ts";
import type { RpcCommand, RpcResponse } from "../../modes/rpc/rpc-types.ts";
import type { SubagentContextSnapshot } from "./context.ts";
import type { ModelChoice } from "./dispatch.ts";
import { PrefixWarmup, type ReleaseWarmup } from "./prefix-warmup.ts";
import { type WorkerChannel, type WorkerRequest, workerEnvelopeSchema } from "./worker-channel.ts";
import { WORKER_CONVERSATION_ENV, WORKER_FLAG } from "./worker-prompt.ts";
import { workerTools } from "./worker-tools.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Share of prompt tokens read from the provider cache: cacheRead / (input + cacheRead + cacheWrite). */
	cacheHitRate: number;
	/**
	 * The same share for the first request alone. It shows whether a run started from a cache entry
	 * written by a sibling; later requests mostly read the run's own entries.
	 */
	firstCacheHitRate?: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

type ChildStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface SingleResult {
	agent: string;
	agentSource: "builtin" | "user" | "project" | "unknown";
	workerId?: string;
	task: string;
	status: ChildStatus;
	exitCode: number | null;
	messages: Message[];
	streamingMessage?: AssistantMessage;
	stderr: string;
	/** Provider usage during this run, including active refreshes; later idle refreshes stay in the private session. */
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	terminationSignal?: NodeJS.Signals;
	step?: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	/** Resolved launch choices in argument order, including background jobs that return no results here. */
	modelChoices?: ModelChoice[];
	results: SingleResult[];
	/** Usage summed over `results`. */
	usage: UsageStats;
	isError: boolean;
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** Called with a worker's cumulative billable usage, including costs outside active runs. */
export type OnUsageCallback = (usage: UsageTotals) => void;

export interface DispatchDefaults {
	context: SubagentContextSnapshot;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	extraArgs?: string[];
}

export interface SubagentConfig {
	name: string;
	description?: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "builtin" | "user" | "project";
}

export interface ResolvedAgent<TAgent extends SubagentConfig = SubagentConfig> {
	agent?: TAgent;
	available: TAgent[];
	cwd: string;
}

export interface WorkerSession {
	run(
		task: string,
		step: number | undefined,
		signal: AbortSignal | undefined,
		onUpdate: OnUpdateCallback | undefined,
		makeDetails: (results: SingleResult[]) => SubagentDetails,
	): Promise<SingleResult>;
	send(message: string, mode: "steer" | "followUp"): Promise<boolean>;
	setModel(model: Model<Api>, thinkingLevel: ThinkingLevel): Promise<void>;
	dispose(): Promise<void>;
}

interface ActiveRun {
	result: SingleResult;
	toolArguments: Map<number, ToolCallArgumentsStream>;
	/** Set while siblings wait for this run's first response to start streaming. */
	releaseWarmup?: ReleaseWarmup;
	cacheKey?: string;
	warmupAdmission?: Promise<void>;
	warmupController: AbortController;
	accepting: boolean;
	aborted: boolean;
	settled: boolean;
	deliveries: number;
	resolve: (result: SingleResult) => void;
	update: () => void;
	cleanup: () => void;
}

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
}

/** Returns all text blocks from the final assistant message. */
export function getFinalOutput(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

/** Usage of a run that has made no request. */
export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHitRate: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Sums the usage of several runs. Context size and first request rate belong to one run and are left out. */
export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const { usage } of results) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
		total.turns += usage.turns;
	}
	total.cacheHitRate = cacheHitRate(total);
	return total;
}

/**
 * Share of prompt tokens read from the provider cache, 0 when no prompt tokens were counted.
 */
export function cacheHitRate(usage: { input: number; cacheRead: number; cacheWrite: number }): number {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? usage.cacheRead / promptTokens : 0;
}

/**
 * Creates an isolated worker whose private process and session survive between runs. Of the workers
 * that share `warmup` and a system prompt, one sends its first request alone and the rest wait for
 * its first streamed event.
 */
export function createWorkerSession(
	defaults: DispatchDefaults,
	resolved: ResolvedAgent,
	agentName: string,
	channel: WorkerChannel,
	warmup: PrefixWarmup,
	onUsage?: OnUsageCallback,
): WorkerSession {
	return new ProcessWorker(defaults, resolved, agentName, channel, warmup, onUsage);
}

/** Runs one disposable worker while preserving the existing single invocation API. */
export async function runSingleAgent(
	defaults: DispatchDefaults,
	resolved: ResolvedAgent,
	agentName: string,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const worker = createWorkerSession(
		defaults,
		resolved,
		agentName,
		{
			id: uuidv7(),
			async request() {
				throw new Error("This worker has no team coordinator");
			},
		},
		new PrefixWarmup(),
	);
	try {
		return await worker.run(task, step, signal, onUpdate, makeDetails);
	} finally {
		await worker.dispose();
	}
}

class ProcessWorker implements WorkerSession {
	private defaults: DispatchDefaults;
	private resolved: ResolvedAgent;
	private agentName: string;
	private channel: WorkerChannel;
	private warmup: PrefixWarmup;
	private onUsage?: OnUsageCallback;
	private lifetimeUsage = createUsageTotals();
	private process?: ChildProcess;
	private processClosed = true;
	private tempDir?: string;
	private initialization?: Promise<void>;
	private disposal?: Promise<void>;
	private disposed = false;
	private failure?: Error;
	private active?: ActiveRun;
	private starting = false;
	private sequence = 0;
	private pending = new Map<string, PendingRequest>();
	private stopReading?: () => void;
	private stderr = "";
	private closed?: Promise<void>;
	private resolveClosed?: () => void;
	private delivery: Promise<unknown> = Promise.resolve();

	constructor(
		defaults: DispatchDefaults,
		resolved: ResolvedAgent,
		agentName: string,
		channel: WorkerChannel,
		warmup: PrefixWarmup,
		onUsage?: OnUsageCallback,
	) {
		this.defaults = defaults;
		this.resolved = resolved;
		this.agentName = agentName;
		this.channel = channel;
		this.warmup = warmup;
		this.onUsage = onUsage;
	}

	async run(
		task: string,
		step: number | undefined,
		signal: AbortSignal | undefined,
		onUpdate: OnUpdateCallback | undefined,
		makeDetails: (results: SingleResult[]) => SubagentDetails,
	): Promise<SingleResult> {
		const result = this.createResult(task, step);
		if (this.starting || this.active) throw new Error("Worker already has an active run");
		if (signal?.aborted)
			return { ...result, status: "aborted", errorMessage: "Subagent was aborted before starting" };
		this.starting = true;
		try {
			await this.ensureStarted();
		} catch (error) {
			// Transport failure retains admission until the child has actually closed.
			if (this.failure && !this.processClosed) await this.closed;
			return { ...result, status: "failed", errorMessage: errorText(error) };
		} finally {
			this.starting = false;
		}
		if (signal?.aborted || this.disposed) {
			return signal?.aborted
				? { ...result, status: "aborted", errorMessage: "Subagent was aborted before starting" }
				: { ...result, status: "failed", errorMessage: "Worker was disposed" };
		}
		const completed = Promise.withResolvers<SingleResult>();
		const abort = () => {
			void this.abortRun();
		};
		const active: ActiveRun = {
			result,
			toolArguments: new Map(),
			warmupController: new AbortController(),
			accepting: true,
			aborted: false,
			settled: false,
			deliveries: 0,
			resolve: completed.resolve,
			update: () =>
				onUpdate?.({
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
					details: makeDetails([result]),
				}),
			cleanup: () => signal?.removeEventListener("abort", abort),
		};
		this.active = active;
		signal?.addEventListener("abort", abort, { once: true });
		active.update();
		void this.command({ type: "prompt", message: task })
			.then((response) => {
				if (this.active !== active) return;
				if (response.success && response.command === "prompt" && response.data.disposition === "handled")
					this.finish("completed");
			})
			.catch((error: unknown) => {
				if (this.active === active) this.finish("failed", errorText(error));
			});
		return completed.promise;
	}

	async send(message: string, mode: "steer" | "followUp"): Promise<boolean> {
		const active = this.active;
		if (!active?.accepting || this.failure || this.disposed) return false;
		active.deliveries++;
		const delivered = this.delivery.then(async () => {
			if (this.active !== active || !active.accepting) return false;
			await this.command({ type: mode === "steer" ? "steer" : "follow_up", message });
			if (active.accepting) return true;
			// Settlement can race acknowledgement. Only redeliver input still in the idle queue.
			const response = await this.command({ type: "clear_queue" });
			return (
				response.success &&
				response.command === "clear_queue" &&
				![...response.data.steering, ...response.data.followUp].includes(message)
			);
		});
		this.delivery = delivered.catch(() => {});
		try {
			return await delivered;
		} finally {
			active.deliveries--;
			if (this.active === active && active.settled && !active.aborted && active.deliveries === 0)
				this.finishResult();
		}
	}

	async setModel(model: Model<Api>, thinkingLevel: ThinkingLevel): Promise<void> {
		if (this.starting || this.active) throw new Error("Interrupt the worker and wait before changing its model");
		if (this.disposed) throw new Error("Worker was disposed");
		if (this.initialization) {
			await this.ensureStarted();
			await this.command({ type: "set_model", provider: model.provider, modelId: model.id });
			this.defaults.model = `${model.provider}/${model.id}`;
			try {
				await this.command({ type: "set_thinking_level", level: thinkingLevel });
			} catch (error) {
				const state = await this.command({ type: "get_state" }).catch(() => undefined);
				if (state?.success && state.command === "get_state") this.defaults.thinkingLevel = state.data.thinkingLevel;
				throw error;
			}
		}
		this.defaults.model = `${model.provider}/${model.id}`;
		this.defaults.thinkingLevel = thinkingLevel;
	}

	dispose(): Promise<void> {
		this.disposal ??= this.stop();
		return this.disposal;
	}

	private createResult(task: string, step: number | undefined): SingleResult {
		return {
			agent: this.agentName,
			agentSource: this.resolved.agent?.source ?? "unknown",
			workerId: this.channel.id,
			task,
			step,
			status: "running",
			exitCode: null,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
			model: this.defaults.model ?? this.resolved.agent?.model,
		};
	}

	private ensureStarted(): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("Worker was disposed"));
		if (this.failure)
			return Promise.reject(new Error(`Worker process stopped and cannot resume: ${this.failure.message}`));
		this.initialization ??= this.start();
		return this.initialization;
	}

	private async start(): Promise<void> {
		if (!this.resolved.agent)
			throw new Error(
				`Unknown agent: ${this.agentName}. Available agents: ${this.resolved.available.map((agent) => agent.name).join(", ") || "none"}`,
			);
		// Agent files are an external declaration boundary; an empty body must not select Pi's main prompt.
		if (!this.resolved.agent.systemPrompt.trim())
			throw new Error(`Agent ${this.agentName} has an empty system prompt`);
		this.tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: uuidv7(),
			timestamp: new Date().toISOString(),
			cwd: this.resolved.cwd,
		};
		const context = this.defaults.context;
		// The worker starts with an empty session of its own; it never replays the parent's transcript.
		const sessionPath = path.join(this.tempDir, "session.jsonl");
		// The agent prompt goes through a file: prompts can exceed the Windows command line limit.
		const promptPath = path.join(this.tempDir, "agent-prompt.md");
		const conversationPath = path.join(this.tempDir, "parent-conversation.md");
		const files: [string, string][] = [
			[sessionPath, serializeJsonLine(header)],
			[promptPath, this.resolved.agent.systemPrompt],
			...(context.mode === "fresh" ? [] : [[conversationPath, context.conversation] as [string, string]]),
		];
		await Promise.all(
			files.map(([file, content]) =>
				withFileMutationQueue(file, () => fs.promises.writeFile(file, content, { encoding: "utf8", mode: 0o600 })),
			),
		);
		if (this.disposed) throw new Error("Worker was disposed");
		const args = [
			"--mode",
			"rpc",
			"--session",
			sessionPath,
			"--system-prompt",
			promptPath,
			"--no-skills",
			`--${WORKER_FLAG}`,
			"--planning-worker",
		];
		args.push("--tools", workerTools(this.resolved.agent.tools).join(","));
		const model = this.defaults.model ?? this.resolved.agent.model;
		if (model) args.push("--model", model);
		if (this.defaults.thinkingLevel) args.push("--thinking", this.defaults.thinkingLevel);
		args.push(...(this.defaults.extraArgs ?? []));
		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: this.resolved.cwd,
			windowsHide: true,
			shell: false,
			stdio: ["pipe", "pipe", "pipe", "ipc"],
			env: {
				...process.env,
				PI_SUBAGENT_WORKER_ID: this.channel.id,
				PI_SUBAGENT_AGENT_NAME: this.resolved.agent.name,
				// Fresh workers must not inherit a parent's conversation file through their environment.
				[WORKER_CONVERSATION_ENV]: context.mode === "fresh" ? undefined : conversationPath,
			},
		});
		this.process = child;
		this.processClosed = false;
		this.closed = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
		this.stopReading = attachJsonlLineReader(child.stdout!, (line) => this.handleLine(line));
		child.stderr?.on("data", (data: Buffer) => {
			const text = data.toString();
			this.stderr += text;
			if (this.active) this.active.result.stderr += text;
		});
		child.on("message", (message: unknown) => {
			void this.handleRequest(message);
		});
		child.once("error", (error) => this.fail(error));
		child.stdin?.on("error", (error) => this.fail(error));
		child.once("close", (code, signal) => {
			this.processClosed = true;
			if (this.active) {
				this.active.result.exitCode = code;
				this.active.result.terminationSignal = signal ?? undefined;
			}
			this.fail(
				this.failure ??
					new Error(`Subagent exited with code ${code}${signal ? ` (${signal})` : ""}. ${this.stderr}`),
			);
			this.resolveClosed?.();
		});
		await this.command({ type: "get_state" });
	}

	private command(command: RpcCommand): Promise<RpcResponse> {
		const stdin = this.process?.stdin;
		if (this.failure) return Promise.reject(this.failure);
		if (!stdin?.writable || stdin.destroyed) {
			const error = new Error("Worker stdin is unavailable");
			this.fail(error);
			return Promise.reject(error);
		}
		const id = String(++this.sequence);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.fail(new Error(`Worker command timed out: ${command.type}`));
			}, 30000);
			this.pending.set(id, {
				resolve: (response) => {
					clearTimeout(timer);
					if (!response.success) reject(new Error(response.error));
					else resolve(response);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			stdin.write(serializeJsonLine({ ...command, id }), (error) => {
				if (error) this.fail(error);
			});
		});
	}

	private handleLine(line: string): void {
		let event: JsonAgentSessionEvent | RpcResponse;
		try {
			event = JSON.parse(line) as JsonAgentSessionEvent | RpcResponse;
		} catch {
			return;
		}
		if (event.type === "response") {
			if (!event.id) return;
			const request = this.pending.get(event.id);
			this.pending.delete(event.id);
			request?.resolve(event);
			return;
		}
		const active = this.active;
		if (event.type === "entry_appended") {
			const entry = event.entry;
			const usage =
				entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction"
					? entry.usage
					: undefined;
			if (usage) {
				this.recordBillableUsage(usage, active);
				active?.update();
			}
			return;
		}
		if (!active) return;
		if (event.type === "agent_settled") {
			active.accepting = false;
			active.settled = true;
			if (!active.aborted && active.deliveries === 0) this.finishResult();
			return;
		}
		if (event.type === "message_start" && event.message.role === "assistant") {
			active.result.streamingMessage = event.message;
			active.toolArguments.clear();
			active.update();
			return;
		}
		if (event.type === "message_update") {
			updateStreamingMessage(active, event);
			return;
		}
		if (event.type !== "message_end") return;
		const message = event.message;
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return;
		active.result.messages.push(message);
		if (message.role === "assistant") {
			active.result.streamingMessage = undefined;
			active.toolArguments.clear();
			recordAssistant(active.result, message);
			this.recordBillableUsage(message.usage);
		} else if (message.role === "toolResult" && message.usage) {
			this.recordBillableUsage(message.usage, active);
		}
		active.update();
	}

	private recordBillableUsage(usage: Usage, active?: ActiveRun): void {
		if (active) recordUsage(active.result.usage, usage);
		if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite && !usage.cost.total) return;
		this.lifetimeUsage.input += usage.input;
		this.lifetimeUsage.output += usage.output;
		this.lifetimeUsage.cacheRead += usage.cacheRead;
		this.lifetimeUsage.cacheWrite += usage.cacheWrite;
		this.lifetimeUsage.cost += usage.cost.total;
		this.onUsage?.({ ...this.lifetimeUsage });
	}

	private endWarmup(active: ActiveRun, isWarm: boolean): void {
		active.releaseWarmup?.(isWarm);
		active.releaseWarmup = undefined;
	}

	private async handleRequest(message: unknown): Promise<void> {
		// Child IPC is a wire boundary; sender identity comes only from this channel.
		if (!Value.Check(workerEnvelopeSchema, message)) return;
		try {
			const request = message.request;
			const data =
				request.type === "cache_wait" || request.type === "cache_ready"
					? await this.handleCacheRequest(request)
					: await this.channel.request(request);
			this.reply({ type: "pi_worker_response", id: message.id, success: true, data });
		} catch (error) {
			this.reply({ type: "pi_worker_response", id: message.id, success: false, error: errorText(error) });
		}
	}

	private async handleCacheRequest(
		request: Extract<WorkerRequest, { type: "cache_wait" | "cache_ready" }>,
	): Promise<null> {
		const active = this.active;
		if (!active || active.aborted) throw new Error("Worker cache request has no active run");
		if (request.type === "cache_ready") {
			if (active.cacheKey === request.key) this.endWarmup(active, true);
			return null;
		}
		if (active.cacheKey !== undefined && active.cacheKey !== request.key) {
			// Provider retries may rebuild strict tool schemas, making the previous cold prefix irrelevant.
			active.warmupController.abort();
			this.endWarmup(active, false);
			active.warmupController = new AbortController();
			active.warmupAdmission = undefined;
		}
		active.cacheKey = request.key;
		active.warmupAdmission ??= this.waitForCache(active, request);
		await active.warmupAdmission;
		// IPC omits undefined fields, but the worker response schema requires a data property.
		return null;
	}

	private async waitForCache(
		active: ActiveRun,
		request: Extract<WorkerRequest, { type: "cache_wait" }>,
	): Promise<void> {
		const signal = active.warmupController.signal;
		const release = await this.warmup.enter(request.key, signal, request.sharedKey);
		if (this.active !== active || signal.aborted) {
			release?.(false);
			throw new Error("Worker cache wait was aborted");
		}
		active.releaseWarmup = release;
	}

	private reply(message: object): void {
		if (!this.process?.connected) return;
		this.process.send?.(message, () => {});
	}

	private async abortRun(): Promise<void> {
		const active = this.active;
		if (!active || active.aborted) return;
		active.aborted = true;
		active.accepting = false;
		active.warmupController.abort();
		const timer = setTimeout(() => {
			this.fail(new Error("Worker ignored abort"));
		}, 5000);
		try {
			await Promise.all([this.command({ type: "abort" }), this.command({ type: "clear_queue" })]);
			if (this.active === active) this.finish("aborted", "Subagent was aborted");
		} catch (error) {
			this.fail(new Error(errorText(error)));
		} finally {
			clearTimeout(timer);
		}
	}

	private finishResult(): void {
		const result = this.active?.result;
		if (!result) return;
		if (result.stopReason === "aborted") {
			this.finish("aborted");
			return;
		}
		if (result.stopReason === "error") {
			this.finish("failed");
			return;
		}
		if (!result.messages.some((message) => message.role === "assistant") || result.stopReason === "toolUse") {
			this.finish("failed", "Subagent settled without a final assistant response");
			return;
		}
		this.finish("completed");
	}

	private finish(status: "completed" | "failed" | "aborted", error?: string): void {
		const active = this.active;
		if (!active) return;
		// Request rejection and settlement events may arrive during forced termination.
		// Keep the worker's admission slot until close confirms the process is gone.
		if ((this.failure || this.disposed) && !this.processClosed) return;
		this.active = undefined;
		active.cleanup();
		active.warmupController.abort();
		this.endWarmup(active, false);
		active.result.status = active.aborted ? "aborted" : status;
		active.result.errorMessage = error ?? active.result.errorMessage;
		active.result.exitCode = status === "completed" ? 0 : active.result.exitCode;
		active.resolve(active.result);
	}

	private fail(error: Error): void {
		this.failure ??= error;
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
		if (!this.processClosed) {
			if (this.active) this.active.accepting = false;
			this.process?.kill("SIGKILL");
			return;
		}
		this.finish("failed", this.failure.message);
	}

	private async stop(): Promise<void> {
		this.disposed = true;
		const child = this.process;
		if (child && !this.processClosed) {
			const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
			child.kill("SIGTERM");
			await this.closed;
			clearTimeout(timer);
		}
		await this.initialization?.catch(() => {});
		this.stopReading?.();
		this.fail(new Error("Worker was disposed"));
		if (this.tempDir) await fs.promises.rm(this.tempDir, { recursive: true, force: true });
	}
}

function updateStreamingMessage(
	active: ActiveRun,
	event: Extract<JsonAgentSessionEvent, { type: "message_update" }>,
): void {
	const message = active.result.streamingMessage;
	if (!message) return;
	message.usage = event.usage;
	const delta = event.assistantMessageEvent;
	switch (delta.type) {
		case "text_start":
			message.content[delta.contentIndex] = { type: "text", text: "" };
			break;
		case "text_delta": {
			const content = message.content[delta.contentIndex];
			if (content?.type === "text") content.text += delta.delta;
			break;
		}
		case "text_end":
			message.content[delta.contentIndex] = { type: "text", text: delta.content };
			break;
		case "thinking_start":
			message.content[delta.contentIndex] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta": {
			const content = message.content[delta.contentIndex];
			if (content?.type === "thinking") content.thinking += delta.delta;
			break;
		}
		case "thinking_end":
			message.content[delta.contentIndex] = { type: "thinking", thinking: delta.content };
			break;
		case "toolcall_start":
			message.content[delta.contentIndex] = { type: "toolCall", id: delta.id, name: delta.toolName, arguments: {} };
			active.toolArguments.set(delta.contentIndex, new ToolCallArgumentsStream());
			break;
		case "toolcall_delta": {
			const content = message.content[delta.contentIndex];
			const args = active.toolArguments.get(delta.contentIndex);
			if (content?.type === "toolCall" && args) content.arguments = args.append(delta.delta);
			break;
		}
		case "toolcall_end":
			message.content[delta.contentIndex] = delta.toolCall;
			active.toolArguments.delete(delta.contentIndex);
			break;
		case "done":
			active.result.streamingMessage = delta.message;
			break;
		case "error":
			active.result.streamingMessage = delta.error;
			break;
	}
	active.update();
}

function recordAssistant(result: SingleResult, message: Extract<Message, { role: "assistant" }>): void {
	result.usage.turns++;
	recordUsage(result.usage, message.usage);
	// A failed request reports no tokens, so the first request that reports some sets the first rate.
	if (message.usage.input + message.usage.cacheRead + message.usage.cacheWrite > 0)
		result.usage.firstCacheHitRate ??= cacheHitRate(message.usage);
	result.usage.contextTokens = message.usage.totalTokens;
	result.model ||= message.model;
	result.stopReason = message.stopReason;
	result.errorMessage = message.errorMessage;
}

function recordUsage(total: UsageStats, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.cost += usage.cost.total;
	total.cacheHitRate = cacheHitRate(total);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	if (USES_BROKER_AUTH) {
		// SDK callers may start from an unrelated entry script; never spawn that or a native Pi from PATH.
		return {
			command: process.execPath,
			args: isBunBinary ? args : [path.join(getRuntimePackageDir(), "dist", "bundle", "cli.js"), ...args],
		};
	}
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript))
		return { command: process.execPath, args: [currentScript, ...args] };
	if (!/^(node|bun)(\.exe)?$/.test(path.basename(process.execPath).toLowerCase()))
		return { command: process.execPath, args };
	return { command: APP_NAME, args };
}
