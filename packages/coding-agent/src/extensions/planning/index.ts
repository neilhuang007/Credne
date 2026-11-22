// Coordinates persisted plans and background workers with automatic task completion.
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "../../core/extensions/types.ts";
import { MAIN_AGENT_PROMPT } from "../../core/main-agent-prompt.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import { type AgentConfig, discoverBundledAgents } from "../subagent/agents.ts";
import { captureSubagentContext, listSubagentContext, turnSchema } from "../subagent/context.ts";
import { createSubagentDispatch, dropBlankSelections, reasoningEffortSchema } from "../subagent/dispatch.ts";
import { type ModelTier, modelTierSchema } from "../subagent/model-tiers.ts";
import { type DispatchDefaults, getFinalOutput, type SingleResult } from "../subagent/runner.ts";
import { type AssignmentInput, getWorkerTeam, revealTools, type WorkerTeam } from "../subagent/team.ts";
import { classifyTiers, type TierRequest, withRating } from "../subagent/tier-classifier.ts";
import {
	completeTask,
	createPlan,
	failTask,
	type Plan,
	queueTasks,
	reopenTask,
	revisePlan,
	selectReadyTasks,
	startQueuedTask,
	startTasks,
	type TaskSpec,
	updateTask,
	validatePersistedPlan,
} from "./graph.ts";
import { PLANNING_GUIDANCE } from "./guidance.ts";
import { planSchema, taskCreateSchema, taskRevisionSchema, taskUpdateSchema } from "./schema.ts";
import { PlanningSection, PlanningWidget, sharedTaskSpinner } from "./widget.ts";

const toolNames = [
	"enter_plan_mode",
	"create_plan",
	"task_create",
	"task_update",
	"revise_plan",
	"get_plan",
	"assign_tasks",
	"assign_task",
	"cancel_tasks",
	"get_subagent_context",
	"checkpoint_context",
];
// Active and callable from the start, but left out of requests until the branch enters planning.
const PLAN_MODE_TOOLS = [
	"create_plan",
	"task_create",
	"task_update",
	"revise_plan",
	"get_plan",
	"assign_tasks",
	"assign_task",
	"cancel_tasks",
];
// enter_plan_mode's loadout change until the branch enters planning.
const HIDE_PLAN_MODE_TOOLS = { hiddenDeclarations: PLAN_MODE_TOOLS };
const revisionSchema = Type.Integer({ minimum: 1, description: "Current plan revision returned by get_plan." });
// Codex rejects uniqueItems in tool declarations. Validate distinct IDs before changing worker state.
const taskIdsSchema = Type.Array(Type.String(), { minItems: 1, maxItems: 4, description: "Distinct task IDs." });

interface WorkerJob {
	id: string;
	team: WorkerTeam;
	result: Promise<SingleResult>;
}

/** Registers the default planning workflow for the main agent. */
export default function planningExtension(pi: ExtensionAPI): void {
	const dispatch = createSubagentDispatch(pi);
	let plan: Plan | undefined;
	// Whether this branch entered planning or has a plan; restore() reads it from the branch.
	let planOpen = false;
	let generation = 0;
	let isTransitioning = false;
	const jobs = new Map<string, WorkerJob>();
	const workerPlans = new Map<string, string>();
	const isWorker = () => pi.getFlag("planning-worker") === true;

	pi.registerFlag("planning-worker", {
		type: "boolean",
		default: false,
		description: "Internal planning worker session",
	});
	pi.registerFlag("planning-model", {
		type: "string",
		description: "Default planning worker model ID or unique name",
	});

	function requireMain(): void {
		if (isWorker()) throw new Error("Planning workers cannot invoke planning tools");
		if (isTransitioning) throw new Error("Session transition in progress");
	}

	function requirePlan(revision?: number): Plan {
		requireMain();
		if (!plan) throw new Error("Create a plan first");
		if (revision !== undefined && revision !== plan.revision)
			throw new Error(
				`Stale revision ${revision}; current revision is ${plan.revision}. Get the current plan and retry.`,
			);
		return plan;
	}

	function snapshot(taskId?: string) {
		const selected = taskId ? requirePlan().tasks.find((task) => task.spec.id === taskId) : undefined;
		if (taskId && !selected) throw new Error(`Unknown task ${taskId}`);
		const details = {
			plan: selected ? { ...plan, tasks: [selected] } : plan,
			readyTaskIds: plan ? selectReadyTasks(plan).map((task) => task.spec.id) : [],
			workers: [...jobs].map(([taskId, job]) => ({ taskId, workerId: job.id })),
		};
		return { content: [{ type: "text" as const, text: bounded(JSON.stringify(details, null, 2)) }], details };
	}

	function save(next: Plan, ctx: ExtensionContext): void {
		plan = next;
		pi.appendEntry("planning-state", next);
		if (ctx.hasUI) showPlan(next, ctx.ui);
		// A plan made by calling create_plan directly also needs the tools that change it.
		openPlanMode();
	}

	/** Reveals the plan tools on the first call; returns their listing for the revealing result. */
	function openPlanMode(): string | undefined {
		if (planOpen) return undefined;
		planOpen = true;
		return revealTools(pi, PLAN_MODE_TOOLS, "Here are the relevant tools for planning:");
	}

	// The widget above the input box and the side panel section show the same plan; the widget
	// renders nothing while the panel is open.
	function showPlan(next: Plan, ui: ExtensionUIContext): void {
		const spinnerFor = sharedTaskSpinner(next);
		const workerOf = (taskId: string) => {
			const job = jobs.get(taskId);
			return job?.team.getIdentity(job.id);
		};
		ui.setWidget(
			"planning",
			(tui, theme) => new PlanningWidget(next, tui, theme, spinnerFor(tui, theme), () => ui.isSidePanelOpen()),
			{ placement: "aboveEditor" },
		);
		ui.setSidePanelSection(
			"planning",
			(tui, theme) => new PlanningSection(next, theme, spinnerFor(tui, theme), workerOf),
			{ order: 0 },
		);
	}

	async function drainWorkers(): Promise<void> {
		generation++;
		const stopping = [...jobs.values()];
		await Promise.all(stopping.map((job) => job.team.cancel(job.id)));
		jobs.clear();
		workerPlans.clear();
	}

	async function stopWorkers(_event: unknown, ctx: ExtensionContext): Promise<void> {
		isTransitioning = true;
		try {
			await drainWorkers();
			if (!plan) return;
			let stopped = plan;
			for (const task of stopped.tasks) {
				if (task.state.status === "running" || task.state.status === "queued")
					stopped = failTask(
						stopped,
						task.spec.id,
						"Worker stopped for session transition; inspect files before retrying",
					);
			}
			if (stopped !== plan) save(stopped, ctx);
		} finally {
			isTransitioning = false;
		}
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		isTransitioning = true;
		try {
			// Replacement context already belongs to the new branch; never persist the previous plan here.
			await drainWorkers();
			plan = undefined;
		} finally {
			isTransitioning = false;
		}
		if (ctx.hasUI) {
			ctx.ui.setWidget("planning", undefined);
			ctx.ui.setSidePanelSection("planning", undefined);
		}
		// A worker has no plan of its own; its tool allowlist leaves the planning tools undeclared.
		if (isWorker()) return;
		const branch = ctx.sessionManager.getBranch();
		const opened = branch.some(
			(entry) =>
				(entry.type === "custom" && entry.customType === "planning-state") ||
				(entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "enter_plan_mode" &&
					!entry.message.isError),
		);
		if (opened !== planOpen) {
			planOpen = opened;
			pi.setActiveTools(pi.getActiveTools());
		}
		const entry = branch.findLast((entry) => entry.type === "custom" && entry.customType === "planning-state");
		if (!entry || entry.type !== "custom") return;
		// Session entries are a disk input boundary and must pass the persisted schema.
		if (!Value.Check(planSchema, entry.data)) {
			if (ctx.hasUI) ctx.ui.notify("Ignored invalid persisted planning state", "warning");
			return;
		}
		let restored: Plan = entry.data;
		// Validate task invariants as well as the serialized shape before trusting disk state.
		try {
			validatePersistedPlan(restored);
			for (const task of restored.tasks) {
				if (task.state.status === "running" || task.state.status === "queued")
					restored = failTask(
						restored,
						task.spec.id,
						"Worker interrupted by session transition or restart; review files before retrying",
					);
			}
			save(restored, ctx);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Ignored invalid planning state: ${String(error)}`, "warning");
		}
	}

	function launch(
		spec: TaskSpec,
		target: { kind: "new"; agent: AgentConfig; defaults: DispatchDefaults } | { kind: "existing"; workerId: string },
		execution: "background" | "foreground",
		ctx: ExtensionContext,
	): WorkerJob {
		const workerGeneration = generation;
		let hasReturned = false;
		const team = getWorkerTeam(pi, ctx);
		let workerId: string;
		const assignment: AssignmentInput = {
			task: spec.name,
			beforeStart() {
				const current = requirePlan();
				const task = current.tasks.find((task) => task.spec.id === spec.id);
				if (
					workerGeneration !== generation ||
					jobs.get(spec.id)?.id !== workerId ||
					!task ||
					JSON.stringify(task.spec) !== JSON.stringify(spec)
				)
					throw new Error("This worker assignment is no longer current");
				if (task.state.status === "queued") save(startQueuedTask(current, spec.id), ctx);
				else if (task.state.status !== "running") throw new Error(`Task ${spec.id} is not assigned`);
				const active = requirePlan();
				const definition = {
					objective: active.objective,
					tasks: active.tasks.filter((task) => task.state.status !== "superseded").map((task) => task.spec),
				};
				const fingerprint = JSON.stringify(definition);
				const context = workerPlans.get(workerId) === fingerprint ? undefined : definition;
				workerPlans.set(workerId, fingerprint);
				return renderAssignment(active, spec, context);
			},
			beforeResume() {
				const current = requirePlan();
				const task = current.tasks.find((task) => task.spec.id === spec.id);
				if (
					workerGeneration !== generation ||
					jobs.get(spec.id)?.id !== workerId ||
					!task ||
					JSON.stringify(task.spec) !== JSON.stringify(spec) ||
					task.state.status === "superseded"
				)
					throw new Error("This worker assignment is no longer current. Assign a ready task again.");
				const reopened =
					task.state.status === "done"
						? reopenTask(current, spec.id, "Main agent requested further worker discussion or implementation")
						: current;
				save(startTasks(reopened, [spec.id]), ctx);
			},
			onResult(result, resultWorkerId) {
				if (workerGeneration !== generation || !plan || jobs.get(spec.id)?.id !== resultWorkerId) return;
				const status = plan.tasks.find((task) => task.spec.id === spec.id)?.state.status;
				if (status !== "running" && status !== "queued") return;
				if (result.status !== "completed") workerPlans.delete(resultWorkerId);
				const output =
					getFinalOutput(result.messages) || result.errorMessage || result.stderr || "Worker returned no output";
				const triggerTurn = execution === "background" || hasReturned;
				hasReturned = true;
				save(
					result.status !== "completed" ? failTask(plan, spec.id, output) : completeTask(plan, spec.id, output),
					ctx,
				);
				pi.sendMessage(
					{
						customType: "planning-result",
						content: `${bounded(
							`Task ${spec.id}, worker ${resultWorkerId}: ${result.status}.\n${output}`,
						)}\nUsage: ${JSON.stringify(result.usage)}`,
						display: true,
						details: { taskId: spec.id, workerId: resultWorkerId, result },
					},
					{ triggerTurn, deliverAs: "followUp" },
				);
			},
		};
		const worker =
			target.kind === "existing"
				? team.assign(target.workerId, assignment)
				: team.spawn({
						...assignment,
						name: spec.id,
						defaults: target.defaults,
						resolved: { agent: target.agent, available: [target.agent], cwd: ctx.cwd },
					});
		workerId = worker.id;
		const job = { id: worker.id, team, result: worker.result };
		jobs.set(spec.id, job);
		return job;
	}

	pi.registerTool({
		name: "enter_plan_mode",
		label: "Enter planning",
		description: "Use this tool proactively when you're about to start a non-trivial implementation task.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		prepareLoadout: () => (planOpen ? undefined : HIDE_PLAN_MODE_TOOLS),
		async execute(_id, _args, _signal, _update, ctx) {
			requireMain();
			const revealed = openPlanMode();
			const snapshotResult = snapshot();
			const result = revealed
				? { ...snapshotResult, content: [{ type: "text" as const, text: revealed }, ...snapshotResult.content] }
				: snapshotResult;
			const examplesShown = ctx.sessionManager
				.getBranch()
				.some(
					(entry) =>
						(entry.type === "custom" && entry.customType === "planning-examples-shown") ||
						(entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolName === "enter_plan_mode" &&
							!entry.message.isError),
				);
			if (examplesShown) return result;
			// Persist before returning so another call in this batch cannot insert the examples again.
			pi.appendEntry("planning-examples-shown");
			return { ...result, content: [{ type: "text", text: PLANNING_GUIDANCE }, ...result.content] };
		},
	});

	pi.registerTool({
		name: "create_plan",
		label: "Create plan",
		description: "Create a structured task list. The harness generates and returns task IDs.",
		parameters: Type.Object({
			objective: Type.String({ description: "Overall outcome the plan should achieve." }),
			tasks: Type.Array(taskCreateSchema, {
				description: "Tasks needed to achieve the objective; IDs are generated.",
			}),
		}),
		executionMode: "sequential",
		async execute(_id, args, _signal, _update, ctx) {
			requireMain();
			if (plan?.tasks.some((task) => task.state.status !== "done" && task.state.status !== "superseded"))
				throw new Error("An unfinished plan already exists; revise it instead");
			const next = createPlan(args.objective, args.tasks, "Initial implementation plan");
			await drainWorkers();
			save(next, ctx);
			return snapshot();
		},
	});
	pi.registerTool({
		name: "task_create",
		label: "Create task",
		description: "Add a task to the plan. The harness generates and returns its ID.",
		parameters: Type.Object(
			{ revision: revisionSchema, ...taskCreateSchema.properties },
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_id, args, _signal, _update, ctx) {
			const { revision, ...spec } = args;
			const current = requirePlan(revision);
			save(
				revisePlan(
					current,
					[...current.tasks.filter((task) => task.state.status !== "superseded").map((task) => task.spec), spec],
					"Added task",
				),
				ctx,
			);
			return snapshot();
		},
	});
	pi.registerTool({
		name: "task_update",
		label: "Update task",
		description:
			"Use this tool to update a task in the task list.\n\n- ONLY mark a task as completed when you have FULLY accomplished it\n\nMake sure to read a task's latest state using `get_plan` before updating it.",
		parameters: taskUpdateSchema,
		executionMode: "sequential",
		async execute(_id, args, _signal, _update, ctx) {
			const { revision, taskId, ...patch } = args;
			const current = requirePlan(revision);
			const status = current.tasks.find((task) => task.spec.id === taskId)?.state.status;
			if (jobs.has(taskId) && (status === "running" || status === "queued"))
				throw new Error("Wait for the assigned worker to settle or cancel it before updating this task");
			save(updateTask(current, taskId, patch), ctx);
			jobs.delete(taskId);
			return snapshot(taskId);
		},
	});
	pi.registerTool({
		name: "revise_plan",
		label: "Revise plan",
		description:
			"Replace the active task list. Use returned IDs to retain existing tasks; omit IDs for new tasks generated by the harness.",
		parameters: Type.Object({
			revision: revisionSchema,
			reason: Type.String({ minLength: 1, description: "Why the plan is changing." }),
			tasks: Type.Array(taskRevisionSchema, {
				description:
					"Complete replacement task list. Use existing returned IDs to retain tasks; omit IDs for new tasks.",
			}),
		}),
		executionMode: "sequential",
		async execute(_id, args, _signal, _update, ctx) {
			save(revisePlan(requirePlan(args.revision), args.tasks, args.reason), ctx);
			return snapshot();
		},
	});
	pi.registerTool({
		name: "get_plan",
		label: "Get plan",
		description: "Use this tool to list all tasks in the task list.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Task ID to inspect; omit to return the whole plan." })),
		}),
		async execute(_id, args) {
			requireMain();
			return snapshot(args.taskId);
		},
	});
	pi.registerTool({
		name: "checkpoint_context",
		label: "Mark context milestone",
		description: "Record a named context checkpoint without changing task status.",
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: 120 }),
			description: Type.Optional(Type.String({ maxLength: 2000 })),
		}),
		executionMode: "sequential",
		async execute(_id, args) {
			requireMain();
			if (!args.name.trim()) throw new Error("A context milestone requires a meaningful name");
			return {
				content: [
					{ type: "text", text: `Step complete: ${args.name}${args.description ? `\n${args.description}` : ""}` },
				],
				details: args,
			};
		},
	});
	pi.registerTool({
		name: "get_subagent_context",
		label: "Get subagent context",
		description: "List context checkpoints for the subagent turn parameter.",
		parameters: Type.Object({}),
		async execute(_id, _args, _signal, _update, ctx) {
			requireMain();
			const details = listSubagentContext(ctx);
			return { content: [{ type: "text", text: bounded(JSON.stringify(details, null, 2)) }], details };
		},
	});
	pi.registerTool({
		name: "assign_tasks",
		label: "Assign tasks",
		description:
			"Assign ready tasks to new workers. Returns worker IDs; successful results complete tasks automatically. Model, tier, reasoningEffort, and turn apply to the batch.",
		parameters: Type.Object({
			revision: revisionSchema,
			taskIds: taskIdsSchema,
			background: Type.Optional(
				Type.Boolean({
					default: true,
					description: "Return immediately when true; wait for all first run results when false.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Model ID, unique name, or family alias such as sol, opus or flash (newest of that family) on the current account. Discover IDs with search_models. An explicit provider/model ID selects that route.",
				}),
			),
			tier: Type.Optional(modelTierSchema),
			reasoningEffort: Type.Optional(reasoningEffortSchema),
			turn: Type.Optional(turnSchema),
		}),
		// A blank model also lets --planning-model apply, as an omitted one does.
		prepareArguments: dropBlankSelections,
		executionMode: "sequential",
		async execute(_id, args, signal, _update, ctx) {
			const current = requirePlan(args.revision);
			if (signal?.aborted) throw new Error("Task assignment aborted before starting");
			const configuredModel = args.model ?? pi.getFlag("planning-model");
			// CLI flags are an external configuration boundary.
			if (configuredModel !== undefined && typeof configuredModel !== "string")
				throw new Error("Planning model must be a model ID or name");
			const agent = discoverBundledAgents().find((candidate) => candidate.name === "worker");
			if (!agent) throw new Error("The worker agent profile is unavailable.");
			const context = captureSubagentContext(args.turn, ctx);
			// Each task is rated on its own, so the tasks of one call can run at different tiers. A model or tier
			// chosen for the call applies to all of them and skips the rating.
			const requests = args.taskIds.map((id) =>
				plannedTierRequest(current, id, agent, { model: configuredModel, tier: args.tier }),
			);
			const ratings = await classifyTiers(pi, dispatch, requests, ctx, signal);
			if (signal?.aborted) throw new Error("Task assignment aborted before starting");
			const resolved = ratings.map((rating) =>
				dispatch.resolve(
					{ model: configuredModel, tier: args.tier, reasoningEffort: args.reasoningEffort },
					ctx,
					// The rated tier replaces the profile's tier, and the rated effort the effort of its tier row;
					// neither is a choice of the caller, so an explicit model, tier or reasoningEffort still wins.
					withRating(agent, rating),
				),
			);
			const background = args.background ?? true;
			// Workers may have reported while the classifier ran, so queue the tasks on the plan as it is now.
			const next = queueTasks(requirePlan(args.revision), args.taskIds);
			save(next, ctx);
			const dispatched = args.taskIds.map((id, index) => ({
				taskId: id,
				job: launch(
					next.tasks.find((task) => task.spec.id === id)!.spec,
					{
						kind: "new",
						agent,
						defaults: { ...resolved[index], context, extraArgs: ["--planning-worker", "--subagent-worker"] },
					},
					background ? "background" : "foreground",
					ctx,
				),
			}));
			const workers = dispatched.map(({ taskId, job }, index) => ({ taskId, workerId: job.id, ...resolved[index] }));
			const completed = background
				? undefined
				: await waitForWorkers(
						dispatched.map(({ job }) => job),
						signal,
					);
			const results = completed?.map((result, index) => ({
				...workers[index],
				status: result.status,
				output: getFinalOutput(result.messages),
				usage: result.usage,
				errorMessage: result.errorMessage,
			}));
			const result = snapshot();
			const assignment = { workers, turn: args.turn ?? 0, background };
			return {
				content: [...result.content, { type: "text", text: bounded(JSON.stringify({ ...assignment, results })) }],
				details: { ...result.details, assignment, results },
			};
		},
	});
	pi.registerTool({
		name: "assign_task",
		label: "Assign task to worker",
		description:
			"Queue a ready task for an existing worker. Appends task details and the plan when new or changed after its current run finishes.",
		parameters: Type.Object({
			revision: revisionSchema,
			taskId: Type.String(),
			workerId: Type.String(),
			background: Type.Optional(
				Type.Boolean({
					default: true,
					description: "Return immediately when true; wait for the result when false.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, args, signal, _update, ctx) {
			const current = requirePlan(args.revision);
			if (signal?.aborted) throw new Error("Task assignment aborted before starting");
			const team = getWorkerTeam(pi, ctx);
			const worker = team.list().find((worker) => worker.id === args.workerId);
			if (!worker || worker.status === "cancelled") throw new Error("Choose an available worker from list_agents");
			const next = queueTasks(current, [args.taskId]);
			save(next, ctx);
			const background = args.background ?? true;
			const job = launch(
				next.tasks.find((task) => task.spec.id === args.taskId)!.spec,
				{ kind: "existing", workerId: args.workerId },
				background ? "background" : "foreground",
				ctx,
			);
			const completed = background ? undefined : (await waitForWorkers([job], signal))[0];
			const result = snapshot();
			const assignment = {
				taskId: args.taskId,
				workerId: job.id,
				background,
				status: completed?.status ?? "queued",
				output: completed ? getFinalOutput(completed.messages) : undefined,
			};
			return {
				content: [...result.content, { type: "text", text: JSON.stringify(assignment) }],
				details: { ...result.details, assignment },
			};
		},
	});
	pi.registerTool({
		name: "cancel_tasks",
		label: "Cancel tasks",
		description: "Stop the selected tasks' workers and their queued assignments; wait until they exit.",
		parameters: Type.Object({ revision: revisionSchema, taskIds: taskIdsSchema }),
		executionMode: "sequential",
		async execute(_id, args) {
			requirePlan(args.revision);
			if (new Set(args.taskIds).size !== args.taskIds.length) throw new Error("Cancel requires distinct task IDs");
			const selected = args.taskIds.map((id) => {
				const job = jobs.get(id);
				const status = plan?.tasks.find((task) => task.spec.id === id)?.state.status;
				if (!job || (status !== "running" && status !== "queued")) throw new Error(`No assigned worker for ${id}`);
				return job;
			});
			await Promise.all(selected.map((job) => job.team.cancel(job.id)));
			return snapshot();
		},
	});
	pi.on("tool_call", async (event) => {
		if (isWorker() && toolNames.includes(event.toolName))
			return { block: true, reason: "Planning workers cannot invoke planning tools" };
	});
	pi.on("before_agent_start", async (event) => {
		if (!pi.getActiveTools().includes("enter_plan_mode")) return;
		// A named section rather than a replaced prompt: a replaced prompt is rebuilt at the head of
		// every request, so later prompt and tool changes could not be appended and would discard
		// the provider's prompt cache. Workers leave enter_plan_mode out of their tools.
		event.systemPromptOptions.sections.planning = MAIN_AGENT_PROMPT.planning;
		if (!plan) return;
		const current = `Current plan revision ${plan.revision}: ${plan.objective}. ${plan.tasks
			.filter((task) => task.state.status !== "superseded")
			.map((task) => `${task.spec.id}: ${task.state.status}`)
			.join(", ")}.`;
		return { message: { customType: "planning-context", content: current, display: false } };
	});
	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_before_switch", stopWorkers);
	pi.on("session_before_fork", stopWorkers);
	pi.on("session_before_tree", stopWorkers);
	pi.on("session_shutdown", stopWorkers);
}

async function waitForWorkers(jobs: WorkerJob[], signal: AbortSignal | undefined): Promise<SingleResult[]> {
	let cancellation: Promise<void> | undefined;
	const cancel = () => {
		cancellation ??= Promise.all(jobs.map((job) => job.team.cancel(job.id))).then(() => {});
		void cancellation.catch(() => {});
	};
	if (signal?.aborted) cancel();
	else signal?.addEventListener("abort", cancel, { once: true });
	try {
		return await Promise.all(jobs.map((job) => job.result));
	} finally {
		signal?.removeEventListener("abort", cancel);
		await cancellation;
	}
}

/** What the tier classifier is asked about one task of a plan: the task itself, with the objective and step names as background. */
function plannedTierRequest(
	plan: Plan,
	taskId: string,
	agent: AgentConfig,
	choice: { model?: string; tier?: ModelTier },
): TierRequest | undefined {
	const task = plan.tasks.find((candidate) => candidate.spec.id === taskId);
	if (!task) return undefined;
	const steps = plan.tasks
		.filter((candidate) => candidate.state.status !== "superseded")
		.map((candidate) => candidate.spec)
		.sort((left, right) => left.order - right.order);
	return {
		agent,
		work: { kind: "planned", objective: plan.objective, plan: steps.map((step) => step.name), task: task.spec },
		model: choice.model,
		tier: choice.tier,
	};
}

/** Supplies the assignment and only includes the full plan when it is new to the worker. */
function renderAssignment(
	plan: Plan,
	spec: TaskSpec,
	definition: { objective: string; tasks: TaskSpec[] } | undefined,
): string {
	const earlierResults = plan.tasks.flatMap((task) =>
		task.spec.order < spec.order && task.state.status === "done"
			? [{ id: task.spec.id, name: task.spec.name, output: task.state.output }]
			: [],
	);
	return `Task assignment notification.\n${JSON.stringify(
		{ plan: definition, objective: plan.objective, task: spec, earlierResults },
		null,
		2,
	)}`;
}

function bounded(text: string): string {
	const result = truncateHead(text, { maxLines: 160, maxBytes: 12000 });
	return (
		result.content + (result.truncated ? "\n[Output truncated; full output is persisted in planning state.]" : "")
	);
}
