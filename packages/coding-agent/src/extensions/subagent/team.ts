// Coordinates persistent workers through a shared session queue and authenticated message routing.
import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { SubagentRecord } from "../../core/compaction/subagent-card.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { SUBAGENT_USAGE_ENTRY, type SubagentUsageSnapshot } from "../../core/session-usage.ts";
import type { UsageTotals } from "../../core/usage-totals.ts";
import type { ThemeColor } from "../../modes/interactive/theme/theme-tokens.ts";
import { type BackgroundJob, BackgroundJobManager } from "./background-job-manager.ts";
import {
	type DispatchResolution,
	type DispatchSelection,
	reasoningEffortSchema,
	type SubagentDispatch,
} from "./dispatch.ts";
import { PrefixWarmup } from "./prefix-warmup.ts";
import {
	aggregateUsage,
	createWorkerSession,
	type DispatchDefaults,
	emptyUsage,
	getFinalOutput,
	type OnUpdateCallback,
	type ResolvedAgent,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
	type WorkerSession,
} from "./runner.ts";
import { SubagentSection, SubagentWidget, sharedWorkerSpinner } from "./widget.ts";
import type { RequestParent, WorkerRequest } from "./worker-channel.ts";
import { workerColorAt } from "./worker-color.ts";
import { showWorkerView } from "./worker-view.ts";

export interface AssignmentInput {
	task: string;
	beforeStart?: () => string;
	onResult?: (result: SingleResult, workerId: string) => void | Promise<void>;
	beforeResume?: () => void;
}

export interface SpawnInput extends AssignmentInput {
	name: string;
	defaults: DispatchDefaults;
	resolved: ResolvedAgent;
	step?: number;
	onUpdate?: OnUpdateCallback;
	makeDetails?: (results: SingleResult[]) => SubagentDetails;
}

export interface WorkerSummary {
	id: string;
	name: string;
	task: string;
	status: "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
	inboxCount: number;
	assignmentCount: number;
	model?: string;
	reasoningEffort?: ThinkingLevel;
}

export interface WorkerView extends WorkerSummary {
	/** Stable for the life of the team; assigned in spawn order. */
	color: ThemeColor;
	agentType: string;
	cwd: string;
	usage: UsageStats;
	elapsedMs: number;
	runs: SingleResult[];
}

/** What the panel sections need to name a worker: cheap to look up, unlike a full view. */
export type WorkerIdentity = Pick<WorkerView, "id" | "name" | "color">;

interface Worker {
	id: string;
	color: ThemeColor;
	input: SpawnInput;
	session: WorkerSession;
	status: WorkerSummary["status"];
	inbox: string[];
	assignments: WorkerRun[];
	run?: WorkerRun;
	cancellation?: Promise<void>;
	modelChange?: Promise<DispatchResolution>;
	hasStarted: boolean;
	runs: SingleResult[];
	elapsedMs: number;
	startedAt?: number;
}

interface WorkerRun {
	worker: Worker;
	input: SpawnInput;
	kind: "assignment" | "continuation";
	task: string;
	queueId?: string;
	resolve: (result: SingleResult) => void;
	result: Promise<SingleResult>;
	isInitial: boolean;
	resultIndex: number;
}

interface TeamOwner {
	team?: WorkerTeam;
	sessionId?: string;
}

const owners = new WeakMap<ReadonlySessionManager, TeamOwner>();
const registeredTools = new WeakSet<ExtensionAPI>();

/** Returns the shared worker team for the current parent session. */
export function getWorkerTeam(pi: ExtensionAPI, ctx: ExtensionContext): WorkerTeam {
	const owner = getOwner(pi, ctx);
	const sessionId = ctx.sessionManager.getSessionId();
	if (!owner.team || owner.sessionId !== sessionId) {
		void owner.team?.dispose();
		owner.sessionId = sessionId;
		owner.team = new WorkerTeam(pi, ctx.sessionManager);
		if (ctx.hasUI) {
			const team = owner.team;
			const spinnerFor = sharedWorkerSpinner();
			const openSession = (workerId: string | undefined) => {
				if (workerId) showWorkerView(ctx.ui, team, workerId);
				else ctx.ui.setMainView(undefined);
			};
			ctx.ui.setWidget(
				"subagents",
				(tui, theme) => new SubagentWidget(team, tui, theme, openSession, spinnerFor(tui, theme)),
				{ placement: "belowEditor" },
			);
			// A disposed team has no workers, so a section left behind by a closed session renders nothing.
			ctx.ui.setSidePanelSection(
				"subagents",
				(tui, theme) => new SubagentSection(team, tui, theme, spinnerFor(tui, theme), openSession),
				{ order: 10 },
			);
		}
	}
	return owner.team;
}

/** Returns the worker team of the current parent session when one was created, without creating one. */
export function findWorkerTeam(ctx: Pick<ExtensionContext, "sessionManager">): WorkerTeam | undefined {
	const owner = owners.get(ctx.sessionManager);
	return owner?.sessionId === ctx.sessionManager.getSessionId() ? owner.team : undefined;
}

function getOwner(pi: ExtensionAPI, ctx: ExtensionContext): TeamOwner {
	const cached = owners.get(ctx.sessionManager);
	if (cached) return cached;
	const owner: TeamOwner = {};
	owners.set(ctx.sessionManager, owner);
	const reset = async () => {
		const previous = owner.team;
		owner.team = undefined;
		owner.sessionId = undefined;
		await previous?.dispose();
	};
	pi.on("session_shutdown", reset);
	pi.on("session_before_switch", reset);
	pi.on("session_before_fork", reset);
	pi.on("session_before_tree", reset);
	return owner;
}
/** Owns worker identities, retained sessions, and all queued runs for one parent session. */
export class WorkerTeam {
	private readonly pi: ExtensionAPI;
	private readonly sessionManager?: ReadonlySessionManager;
	private readonly sessionId?: string;
	private readonly workers = new Map<string, Worker>();
	private readonly listeners = new Set<() => void>();
	private readonly jobs: BackgroundJobManager<WorkerRun, SingleResult>;
	private readonly warmup = new PrefixWarmup();
	private readonly foregroundWaits = new Set<() => void>();
	private isDisposed = false;
	private disposal?: Promise<void>;

	constructor(pi: ExtensionAPI, sessionManager?: ReadonlySessionManager) {
		this.pi = pi;
		this.sessionManager = sessionManager;
		this.sessionId = sessionManager?.getSessionId();
		this.jobs = new BackgroundJobManager(
			(run, signal) => this.execute(run, signal),
			(job) => this.settle(job),
		);
	}

	/** Waits on behalf of the parent until the work completes or the user backgrounds it. */
	async waitInForeground<Result>(
		signal: AbortSignal | undefined,
		run: (signal: AbortSignal) => Promise<Result>,
		onBackground: () => void,
	): Promise<Result | undefined> {
		const controller = new AbortController();
		const released = Promise.withResolvers<undefined>();
		const detach = () => {
			onBackground();
			signal?.removeEventListener("abort", abort);
			this.foregroundWaits.delete(detach);
			released.resolve(undefined);
		};
		const abort = () => {
			this.foregroundWaits.delete(detach);
			controller.abort(signal?.reason);
		};
		if (signal?.aborted) abort();
		else {
			this.foregroundWaits.add(detach);
			signal?.addEventListener("abort", abort, { once: true });
		}
		try {
			return await Promise.race([run(controller.signal), released.promise]);
		} finally {
			this.foregroundWaits.delete(detach);
			signal?.removeEventListener("abort", abort);
		}
	}

	/** Releases this session's foreground tool calls without cancelling their workers. */
	backgroundForegroundWorkers(): boolean {
		if (this.isDisposed || !this.foregroundWaits.size) return false;
		for (const detach of this.foregroundWaits) detach();
		return true;
	}

	/** Creates a stable worker identity and queues its first run. */
	spawn(input: SpawnInput): { id: string; result: Promise<SingleResult> } {
		this.assertActive();
		const id = randomUUID();
		const defaults = {
			...input.defaults,
			requestedThinkingLevel: input.defaults.requestedThinkingLevel ?? input.defaults.thinkingLevel,
		};
		const worker: Worker = {
			id,
			// Workers are never removed from the map, so its size is the spawn order.
			color: workerColorAt(this.workers.size),
			input: { ...input, defaults },
			status: "queued",
			inbox: [],
			assignments: [],
			hasStarted: false,
			runs: [],
			elapsedMs: 0,
			session: createWorkerSession(
				defaults,
				input.resolved,
				input.name,
				{
					id,
					request: (request) => this.request(id, request),
				},
				this.warmup,
				(usage) => this.recordWorkerUsage(id, usage),
			),
		};
		this.workers.set(id, worker);
		return { id, result: this.enqueue(worker, input.task) };
	}

	/** Queues an assignment notification for an existing worker without replacing its conversation. */
	assign(id: string, assignment: AssignmentInput): { id: string; result: Promise<SingleResult> } {
		this.assertActive();
		const worker = this.getWorker(id);
		if (worker.status === "cancelled") throw new Error(`Worker ${id} is cancelled`);
		const input = { ...worker.input, ...assignment, step: undefined, onUpdate: undefined, makeDetails: undefined };
		const run = this.createRun(worker, input, "assignment");
		worker.assignments.push(run);
		if (!worker.run) this.startAssignment(worker);
		this.notify();
		return { id, result: run.result };
	}

	/** Lists workers with their stable identities and pending message counts. */
	list(): WorkerSummary[] {
		return [...this.workers.values()].map((worker) => ({
			id: worker.id,
			name: worker.input.name,
			task: worker.input.task.slice(0, 500),
			status: worker.status,
			inboxCount: worker.inbox.length,
			assignmentCount: worker.assignments.length,
			model: worker.input.defaults.model ?? worker.input.resolved.agent?.model,
			reasoningEffort: worker.input.defaults.thinkingLevel,
		}));
	}

	/**
	 * Describes each running or queued worker for compaction: every prompt it was given (its runs' tasks, which include
	 * queued assignments, follow-ups and messages delivered when a run starts, then messages still waiting in its inbox)
	 * and the final output of each finished run, in order. Idle workers are left out.
	 */
	subagentRecords(): SubagentRecord[] {
		if (this.isDisposed) return [];
		const active = [...this.workers.values()].filter(
			(worker) => worker.status === "running" || worker.status === "queued",
		);
		return active.map((worker) => ({
			id: worker.id,
			agent: worker.input.resolved.agent?.name ?? worker.input.name,
			status: worker.status,
			prompts: [...worker.runs.map((run) => run.task), ...worker.inbox],
			messages: worker.runs.flatMap((run) => {
				if (run.status === "pending" || run.status === "running") return [];
				const output = getFinalOutput(run.messages) || run.errorMessage;
				return output ? [output] : [];
			}),
		}));
	}

	/** Counts the workers without building their views. */
	count(): number {
		return this.isDisposed ? 0 : this.workers.size;
	}

	/** Looks a worker up by ID in constant time; undefined when it is unknown or the team is disposed. */
	getIdentity(id: string): WorkerIdentity | undefined {
		const worker = this.isDisposed ? undefined : this.workers.get(id);
		return worker && { id, name: worker.input.name, color: worker.color };
	}

	/** Supplies live display data without switching away from the parent session. */
	getViews(): WorkerView[] {
		if (this.isDisposed) return [];
		return this.list().map((summary) => {
			const worker = this.workers.get(summary.id)!;
			const latest = worker.runs[worker.run?.resultIndex ?? worker.runs.length - 1];
			return {
				...summary,
				color: worker.color,
				agentType: worker.input.resolved.agent?.name ?? worker.input.name,
				cwd: worker.input.resolved.cwd,
				model: summary.model ?? latest?.model,
				usage: {
					...aggregateUsage(worker.runs),
					contextTokens: latest?.usage.contextTokens ?? 0,
					firstCacheHitRate: latest?.usage.firstCacheHitRate,
				},
				elapsedMs: worker.elapsedMs + (worker.startedAt === undefined ? 0 : Date.now() - worker.startedAt),
				runs: worker.runs,
			};
		});
	}

	/** Subscribes to worker state and transcript updates. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private recordWorkerUsage(workerId: string, usage: UsageTotals): void {
		if (this.isDisposed || (this.sessionManager && this.sessionManager.getSessionId() !== this.sessionId)) return;
		const snapshot: SubagentUsageSnapshot = { workerId, usage };
		this.pi.appendEntry(SUBAGENT_USAGE_ENTRY, snapshot);
		this.notify();
	}

	/** Permanently cancels a worker and releases its retained session. */
	async cancel(id: string): Promise<string> {
		const worker = this.getWorker(id);
		if (this.disposal) {
			await this.disposal;
			return "cancelled";
		}
		if (worker.status === "cancelled") {
			await worker.cancellation;
			return "already_cancelled";
		}
		worker.status = "cancelled";
		worker.inbox.length = 0;
		this.notify();
		worker.cancellation = this.cancelWorker(worker);
		await worker.cancellation;
		return "cancelled";
	}

	/** Pauses a worker while retaining its conversation and pending messages. */
	async interrupt(id: string): Promise<string> {
		const worker = this.getWorker(id);
		if (worker.status === "cancelled") return "cancelled";
		worker.status = "interrupted";
		this.notify();
		const run = worker.run;
		if (run?.queueId) {
			await this.jobs.cancel(run.queueId);
			await run.result;
		}
		return "interrupted";
	}

	/** Resumes a settled worker with an explicit prompt through the shared queue. */
	async continue(id: string, prompt: string): Promise<string> {
		this.assertActive();
		if (!prompt.trim()) throw new Error("A continuation prompt is required");
		const worker = this.getWorker(id);
		if (worker.status === "cancelled") return "cancelled";
		if (worker.run) return "already_active";
		worker.input.beforeResume?.();
		this.enqueue(worker, prompt);
		return worker.status;
	}

	/** Changes an idle worker's model and effort without replacing its retained conversation. */
	async changeModel(
		id: string,
		selection: DispatchSelection,
		dispatch: SubagentDispatch,
		ctx: ExtensionContext,
	): Promise<DispatchResolution> {
		this.assertActive();
		const worker = this.getWorker(id);
		if (worker.status === "cancelled") throw new Error(`Worker ${id} is cancelled; spawn a new worker instead.`);
		if (worker.run)
			throw new Error(
				`Worker ${id} is active. Call interrupt_agent and wait for it to finish before change_agent_model.`,
			);
		if (worker.modelChange)
			throw new Error(`Worker ${id} already has a model change in progress. Wait for it to finish.`);
		const defaults = worker.input.defaults;
		const {
			model: reference,
			thinkingLevel,
			requestedThinkingLevel,
		} = dispatch.resolveWithChoice(selection, {
			...ctx,
			thinkingLevel: defaults.requestedThinkingLevel ?? ctx.thinkingLevel,
		});
		const model = ctx.modelRegistry
			.getAvailable()
			.find((candidate) => `${candidate.provider}/${candidate.id}` === reference)!;
		worker.modelChange = (async () => {
			try {
				await worker.session.setModel(model, thinkingLevel);
				defaults.requestedThinkingLevel = requestedThinkingLevel;
				return { model: reference, thinkingLevel };
			} finally {
				this.notify();
			}
		})();
		try {
			return await worker.modelChange;
		} finally {
			worker.modelChange = undefined;
		}
	}

	/** Adds an instruction to the active run without interrupting it. */
	async steer(id: string, prompt: string): Promise<string> {
		this.assertActive();
		if (!prompt.trim()) throw new Error("A steering prompt is required");
		const worker = this.getWorker(id);
		if (worker.status !== "running") return "not_running";
		return (await worker.session.send(`Message from main:\n${prompt}`, "steer")) ? "delivered" : "not_running";
	}

	/** Delivers a message while preserving the coordinator authenticated sender. */
	async send(to: string, message: string, from = "main"): Promise<string> {
		this.assertActive();
		const sender = from === "main" ? "main" : `${this.getWorker(from).input.name} (${from})`;
		if (to === from) throw new Error("Cannot send a message to yourself");
		if (to === "main") {
			this.pi.sendMessage(
				{
					customType: "agent-message",
					content: `Message from ${sender}:\n${message}`,
					display: true,
					details: { sender: from },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
			return "queued";
		}
		return this.deliverToWorker(to, `Message from ${sender}:\n${message}`);
	}

	/** Sends editor input to the worker as the user, outside the parent agent's conversation. */
	sendUserMessage(to: string, message: string): Promise<string> {
		return this.deliverToWorker(to, message);
	}

	private async deliverToWorker(to: string, content: string): Promise<string> {
		this.assertActive();
		const worker = this.getWorker(to);
		if (worker.status === "cancelled") return "cancelled";
		if (worker.status === "running" && (await worker.session.send(content, "steer"))) return "delivered";
		this.assertActive();
		if (this.getWorker(to).status === "cancelled") return "cancelled";
		worker.inbox.push(content);
		this.notify();
		if (worker.status === "interrupted") return "queued_until_continue";
		if (worker.run) return "queued";
		try {
			worker.input.beforeResume?.();
			this.enqueue(worker, "Process the pending messages.");
			return "queued";
		} catch (error) {
			return `retained_until_continue: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	/** Stops all work and suppresses callbacks belonging to the previous parent session. */
	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.isDisposed = true;
		this.notify();
		this.listeners.clear();
		this.warmup.dispose();
		for (const worker of this.workers.values()) {
			worker.status = "cancelled";
		}
		this.disposal = this.disposeWorkers();
		return this.disposal;
	}

	/** Releases all worker sessions and queued work. */
	shutdown(): Promise<void> {
		return this.dispose();
	}

	private async cancelWorker(worker: Worker): Promise<void> {
		const queued = worker.assignments.splice(0);
		for (const assignment of queued) {
			const result = this.emptyResult(
				worker,
				assignment.task,
				"aborted",
				"Worker cancelled before assignment started",
			);
			worker.runs[assignment.resultIndex] = result;
			this.notify();
			try {
				await assignment.input.onResult?.(result, worker.id);
			} catch {
				/* Result delivery cannot prevent cancellation of the remaining assignments. */
			} finally {
				assignment.resolve(result);
			}
		}
		const run = worker.run;
		if (run?.queueId) {
			await this.jobs.cancel(run.queueId);
			await run.result;
		}
		await worker.session.dispose();
	}

	private async disposeWorkers(): Promise<void> {
		await this.jobs.shutdown();
		for (const worker of this.workers.values()) {
			for (const assignment of worker.assignments.splice(0))
				assignment.resolve(this.emptyResult(worker, assignment.task, "aborted", "Parent session changed"));
			if (worker.run)
				worker.run.resolve(this.emptyResult(worker, worker.run.task, "aborted", "Parent session changed"));
		}
		await Promise.all([...this.workers.values()].map((worker) => worker.cancellation ?? worker.session.dispose()));
	}

	private enqueue(worker: Worker, task: string): Promise<SingleResult> {
		const run = this.createRun(worker, { ...worker.input, task }, worker.hasStarted ? "continuation" : "assignment");
		worker.status = "queued";
		worker.run = run;
		run.queueId = this.jobs.enqueue(run);
		this.notify();
		return run.result;
	}

	private createRun(worker: Worker, input: SpawnInput, kind: WorkerRun["kind"]): WorkerRun {
		let resolveResult!: (result: SingleResult) => void;
		const result = new Promise<SingleResult>((resolve) => {
			resolveResult = resolve;
		});
		const run: WorkerRun = {
			worker,
			input,
			kind,
			task: input.task,
			result,
			resolve: resolveResult,
			isInitial: !worker.hasStarted,
			resultIndex: worker.runs.length,
		};
		worker.runs.push(this.emptyResult(worker, input.task, "pending", ""));
		worker.hasStarted = true;
		return run;
	}

	private startAssignment(worker: Worker): void {
		const run = worker.assignments.shift();
		if (!run) return;
		worker.input = run.input;
		worker.status = "queued";
		worker.run = run;
		run.queueId = this.jobs.enqueue(run);
		this.notify();
	}

	private async execute(run: WorkerRun, signal: AbortSignal): Promise<SingleResult> {
		const { worker } = run;
		if (worker.modelChange) await worker.modelChange;
		if (signal.aborted) return this.emptyResult(worker, run.task, "aborted", "Worker run interrupted");
		worker.status = "running";
		worker.startedAt = Date.now();
		this.notify();
		const assignment = run.input.beforeStart?.();
		if (assignment !== undefined)
			run.task = run.kind === "assignment" ? assignment : `${assignment}\n\nFollow up instruction:\n${run.task}`;
		const pending = worker.inbox.splice(0);
		const task = pending.length ? `${run.task}\n\n${pending.join("\n\n")}` : run.task;
		const details: (results: SingleResult[]) => SubagentDetails =
			(run.isInitial ? run.input.makeDetails : undefined) ??
			((results) => ({
				mode: "single",
				results,
				usage: aggregateUsage(results),
				isError: results.some((result) => result.status === "failed" || result.status === "aborted"),
			}));
		return worker.session.run(
			task,
			run.input.step,
			signal,
			(partial) => {
				const result = partial.details?.results[0];
				if (result) worker.runs[run.resultIndex] = result;
				this.notify();
				if (run.isInitial) run.input.onUpdate?.(partial);
			},
			details,
		);
	}

	private async settle(job: BackgroundJob<WorkerRun, SingleResult>): Promise<void> {
		const { worker } = job.input;
		const result =
			job.state.status === "completed" || job.state.status === "cancelled" ? job.state.result : undefined;
		const settled =
			result ??
			this.emptyResult(
				worker,
				job.input.task,
				job.state.status === "failed" ? "failed" : "aborted",
				job.state.status === "failed" ? job.state.error : "Worker run interrupted",
			);
		settled.workerId = worker.id;
		worker.runs[job.input.resultIndex] = settled;
		if (worker.startedAt !== undefined) {
			worker.elapsedMs += Date.now() - worker.startedAt;
			worker.startedAt = undefined;
		}
		if (worker.status !== "cancelled" && worker.status !== "interrupted") {
			worker.status =
				settled.status === "aborted" ? "interrupted" : settled.status === "failed" ? "failed" : "completed";
		}
		this.notify();
		if (this.isDisposed) {
			job.input.resolve(settled);
			return;
		}
		try {
			await job.input.input.onResult?.(settled, worker.id);
		} catch {
			/* Result delivery cannot stall the shared queue. */
		}
		worker.run = undefined;
		job.input.resolve(settled);
		if (
			!this.isDisposed &&
			worker.status !== "cancelled" &&
			worker.status !== "interrupted" &&
			worker.assignments.length
		) {
			this.startAssignment(worker);
			return;
		}
		if (
			this.isDisposed ||
			worker.run ||
			worker.status === "cancelled" ||
			worker.status === "interrupted" ||
			!worker.inbox.length
		)
			return;
		try {
			worker.input.beforeResume?.();
			this.enqueue(worker, "Process the pending messages.");
		} catch {
			/* Preserve messages until the owner permits continuation. */
		}
	}

	private request(from: string, request: WorkerRequest): Promise<unknown> {
		this.assertActive();
		if (request.type === "list")
			return Promise.resolve([{ id: "main", name: "main", status: "parent" }, ...this.list()]);
		if (request.type !== "send") throw new Error("Cache coordination belongs to the worker process");
		return this.send(request.to, request.message, from);
	}

	private getWorker(id: string): Worker {
		const worker = this.workers.get(id);
		if (!worker) throw new Error(`Unknown worker: ${id}`);
		return worker;
	}

	private assertActive(): void {
		if (this.isDisposed) throw new Error("Worker team belongs to a closed parent session");
	}

	private emptyResult(
		worker: Worker,
		task: string,
		status: SingleResult["status"],
		errorMessage: string,
	): SingleResult {
		return {
			agent: worker.input.name,
			agentSource: worker.input.resolved.agent?.source ?? "unknown",
			workerId: worker.id,
			task,
			status,
			exitCode: null,
			messages: [],
			stderr: "",
			errorMessage,
			step: worker.input.step,
			usage: emptyUsage(),
		};
	}
}

/**
 * Tools whose declarations main leaves out of requests until its first delegation: worker
 * coordination, model discovery and context checkpoints. They stay active and callable meanwhile.
 */
export const DELEGATION_TOOLS = [
	"list_agents",
	"send_agent_message",
	"interrupt_agent",
	"continue_agent",
	"steer_agent",
	"change_agent_model",
	"search_models",
	"get_subagent_context",
	"checkpoint_context",
];

/**
 * Re-runs the `prepareLoadout` hooks, so tools a hook stopped hiding are declared from the model's
 * next call, and lists the active ones among `names` under `heading` for the tool result that revealed them.
 */
export function revealTools(pi: ExtensionAPI, names: readonly string[], heading: string): string | undefined {
	const active = pi.getActiveTools();
	pi.setActiveTools(active);
	const lines = pi
		.getAllTools()
		.filter((tool) => names.includes(tool.name) && active.includes(tool.name))
		.map((tool) => `- ${tool.name}: ${tool.description.trim().split(/\r?\n/)[0]}`);
	return lines.length > 0 ? `${heading}\n${lines.join("\n")}` : undefined;
}

/**
 * Registers the coordination tools once for an extension API. In a worker, listing and messaging
 * go to main's coordinator through `requestParent`, and the controls that only main may use are
 * not registered.
 */
export function registerTeamTools(
	pi: ExtensionAPI,
	requestParent: RequestParent | undefined,
	dispatch: SubagentDispatch,
): void {
	if (registeredTools.has(pi)) return;
	registeredTools.add(pi);

	pi.registerTool({
		name: "list_agents",
		label: "List agents",
		description:
			"List the workers of the current parent session with their IDs, states, current models, and reasoning efforts. Called by a worker, the list also names main.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _update, ctx) {
			const agents = requestParent ? await requestParent({ type: "list" }, signal) : getWorkerTeam(pi, ctx).list();
			return { content: [{ type: "text", text: JSON.stringify(agents) }], details: { agents } };
		},
	});
	pi.registerTool({
		name: "send_agent_message",
		label: "Send agent message",
		description:
			'Send a message to a worker by its ID from list_agents. A worker can also send to "main". Active workers receive it during their run. Settled workers resume through the shared queue. Interrupted workers retain it until continue_agent.',
		executionMode: "sequential",
		parameters: Type.Object({ to: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }) }),
		async execute(_id, params, signal, _update, ctx) {
			const status = requestParent
				? JSON.stringify(await requestParent({ type: "send", ...params }, signal))
				: await getWorkerTeam(pi, ctx).send(params.to, params.message);
			return { content: [{ type: "text", text: status }], details: { status } };
		},
	});
	if (requestParent) return;
	pi.registerTool({
		name: "change_agent_model",
		label: "Change agent model",
		description:
			"Change an idle or interrupted worker's model and optional reasoning effort, retaining its conversation and pending messages. Does not resume the worker. For active or queued workers, call interrupt_agent and wait first, then change_agent_model, then continue_agent. Use search_models to select an available model; an explicit provider/model ID changes routes. Omitted effort preserves the worker's current effort, clamped to the new model's supported levels.",
		executionMode: "sequential",
		parameters: Type.Object({
			agentId: Type.String({ minLength: 1 }),
			model: Type.String({ minLength: 1 }),
			reasoningEffort: Type.Optional(reasoningEffortSchema),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const configuration = await getWorkerTeam(pi, ctx).changeModel(params.agentId, params, dispatch, ctx);
			const details = {
				agentId: params.agentId,
				model: configuration.model,
				reasoningEffort: configuration.thinkingLevel,
			};
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
	pi.registerTool({
		name: "interrupt_agent",
		label: "Interrupt agent",
		description:
			"Pause a worker and wait for its active run to settle. Retain its conversation and pending messages for an explicit continue_agent prompt.",
		executionMode: "sequential",
		parameters: Type.Object({ agentId: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const status = await getWorkerTeam(pi, ctx).interrupt(params.agentId);
			return { content: [{ type: "text", text: status }], details: { status } };
		},
	});
	for (const name of ["continue_agent", "steer_agent"] as const) {
		pi.registerTool({
			name,
			label: name,
			description:
				name === "continue_agent"
					? "Resume a settled or interrupted worker with a required prompt, retaining its conversation, model, and effort. The run uses the shared worker queue."
					: "Steer a running worker with a required prompt at its next message boundary. Does not start or resume an idle worker.",
			executionMode: "sequential",
			parameters: Type.Object({ agentId: Type.String(), prompt: Type.String({ minLength: 1 }) }),
			async execute(_id, params, _signal, _update, ctx) {
				const team = getWorkerTeam(pi, ctx);
				const status =
					name === "continue_agent"
						? await team.continue(params.agentId, params.prompt)
						: await team.steer(params.agentId, params.prompt);
				return { content: [{ type: "text", text: status }], details: { status } };
			},
		});
	}
}
