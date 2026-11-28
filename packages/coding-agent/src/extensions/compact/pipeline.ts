// Compacts with the "blocks" strategy: cuts the conversation since the previous compaction into blocks, condenses the
// user's prompt and every block with one model of the account, removes from that record what later blocks made untrue,
// writes the next steps from the conversation, and assembles the text the agent continues from. No entry from before
// the compaction is kept; of the conversation, the text shows only the last block's cleaned transcript, cut to its end
// when it is long.
import {
	type Api,
	type AssistantMessage,
	type CacheRetention,
	type Context,
	clampThinkingLevel,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { condenseBlocks } from "../../core/compaction/block-condenser.ts";
import { type CompactionResult, chooseCompactor, findCompactionRange } from "../../core/compaction/compaction.ts";
import { assembleContext } from "../../core/compaction/context-assembler.ts";
import { writeNextSteps } from "../../core/compaction/next-steps.ts";
import { pruneRecord } from "../../core/compaction/record-pruner.ts";
import { collectRewriteInput, rewriteUserRequest } from "../../core/compaction/request-rewriter.ts";
import { sliceRegion } from "../../core/compaction/slicer.ts";
import { type SubagentCard, summarizeSubagents } from "../../core/compaction/subagent-card.ts";
import { cleanTranscript } from "../../core/compaction/transcript-cleaner.ts";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "../../core/extensions/types.ts";
import type { CustomEntry, SessionEntry } from "../../core/session-manager.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { type Plan, validatePersistedPlan } from "../planning/graph.ts";
import { planSchema } from "../planning/schema.ts";
import type { SubagentDispatch } from "../subagent/dispatch.ts";
import { findWorkerTeam } from "../subagent/team.ts";
import { type BlocksDetails, latestCompaction, readBlocksDetails, type StoredBlock } from "./blocks-details.ts";
import { oneCacheKey } from "./cache-key.ts";
import { findMediumTierModel } from "./medium-tier.ts";
import type { CompactionProgress, CompactionStep } from "./progress.ts";
import { READ_BLOCK_TOOL } from "./read-block.ts";

/** Calls a chat model with one request. */
type Complete = (context: Context, signal: AbortSignal | undefined) => Promise<AssistantMessage>;

/** Starts a step of the procedure; `total` is the number of requests it will make, when known. */
type EnterStep = (step: CompactionStep, total?: number) => void;

// The character budgets count three characters per token.
const charsPerToken = 3;
// Tokens of the compactor's window left for its instructions and its reply.
const reservedCompactorTokens = 20_000;
// The share of the session model's context window that the last block's entry in the agent transcript may take.
const lastBlockShare = 0.05;
// Adapted from Claude Code's post-compaction reminder to reread files. The wording is meant to be reviewed and edited by
// a person, not reworded by an agent.
const rereadReminder =
	"Text from before compaction is no longer in your context. Before you quote it or show it again, read it again with the read_block tool.";
// The user's own wording. It is meant to be reviewed and edited by a person, not reworded by an agent.
const fileReminder = "Reread important files for reference and implementation when needed.";

/**
 * Compacts the branch with the "blocks" strategy and returns the compaction to store, which keeps no entry from before
 * it. The block writers, the next-steps agent and the removal agent follow the compaction's custom `instructions`, which
 * are absent or hold text. A model request that fails twice does not fail it: each step puts a text of its own in place
 * of the reply, and the removal agent keeps the removals it has made. Once `event.signal` aborts, requests in flight are
 * aborted through it and the procedure rejects with its reason; the caller cancels on an aborted signal, whatever the
 * outcome.
 */
export async function compactWithBlocks(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	dispatch: Pick<SubagentDispatch, "models">,
	progress: CompactionProgress,
	instructions: string | undefined,
	ctx: ExtensionContext,
): Promise<CompactionResult<BlocksDetails>> {
	const working = ctx.model;
	// The core compacts only with a session model; the context type allows none.
	if (!working) throw new Error("there is no session model to compact for");
	const { signal } = event;
	// Cleaning and slicing never read the signal, so every step boundary checks it.
	const enter: EnterStep = (step, total) => {
		signal.throwIfAborted();
		progress.begin(step, total);
	};
	const meter = createUsageMeter();
	// The compactor makes every request. It comes from the curated tier table on the current account, in the session
	// model's own family, never from price order across the catalog.
	const compactor = chooseCompactor(working, findMediumTierModel(working, dispatch, ctx));
	// A request whose prefix no later request reads pays for no cache write. The block accounts after the first, and the
	// removal agent's later rounds, read the prefix the earlier requests wrote within the same few minutes; each of the
	// two steps has a caller of its own, whose requests share one prompt cache key.
	const complete = chatCaller(compactor, "none", meter, ctx);
	const completeBlocks = chatCaller(compactor, "short", meter, ctx);
	const completePrune = chatCaller(compactor, "short", meter, ctx);
	const chatChars = Math.max(0, compactor.contextWindow - reservedCompactorTokens) * charsPerToken;
	const earlier = readEarlierState(event.branchEntries);
	const { projection, start } = findCompactionRange(event.branchEntries);

	enter("clean");
	// The session's working directory is the project directory that file paths in cleaned text are shown relative to.
	const region = cleanTranscript(projection.entries.slice(start), ctx.cwd);

	enter("rewrite");
	const rewriteInput = collectRewriteInput(region, earlier.request, chatChars);
	const rewritten = await rewriteUserRequest(rewriteInput, complete, signal);
	// The verbatim inputs are stored as the record of what the user wrote.
	const userMessages = [...earlier.userMessages, ...rewriteInput.inputs];
	// Without a condensed prompt, the user's own inputs stand in for it, and are stored as it.
	const request = rewritten.source === "failed" ? userMessages.join("\n\n") : rewritten.text;

	enter("slice");
	const { borders, blocks } = sliceRegion(region, earlier.nextNumber);
	const last = blocks.at(-1);
	// The core compacts only a range with entries, and every entry belongs to a block.
	if (!last) throw new Error("slicing found nothing to condense");

	enter("condense", blocks.length);
	// The next steps need no account, so they are written while the blocks are condensed, from what the main agent's
	// context held.
	const pendingNextSteps = writeNextSteps(
		event.preparation.previousSummary,
		region.flatMap((entry) => entry.messages),
		chatChars,
		instructions,
		complete,
		signal,
	);
	// It rejects only on an abort, which also rejects the step running then, before this is awaited; this keeps its
	// rejection from going unhandled.
	pendingNextSteps.catch(() => undefined);
	// One block's request shares its prefix with no other.
	const completeBlock = blocks.length > 1 ? completeBlocks : complete;
	const condensed = await condenseBlocks(blocks, request, instructions, completeBlock, signal, () =>
		progress.finished(),
	);
	// The accounts were written without sight of each other, so what a later block made untrue is removed before the
	// record is shown and stored, and later compactions start from the pruned record.
	const condensedRecord = { request, blocks: [...earlier.blocks, ...condensed] };
	const pruning = await pruneRecord(condensedRecord, instructions, completePrune, signal, () => enter("prune"));
	const record = pruning.kind === "pruned" ? pruning.record : condensedRecord;
	const stored: StoredBlock[] = record.blocks;
	const subagents = await summarizeTeam(complete, enter, signal, () => progress.finished(), ctx);
	// The last block is shown by its cleaned transcript. The next compaction no longer has it in its region and shows its
	// stored account instead, so every account is stored.
	const shown = stored.slice(0, -1);

	enter("next");
	const nextSteps = await pendingNextSteps;

	// A subagent worker's tool allowlist leaves read_block unregistered, so its summary does not point to it.
	const canReread = pi.getAllTools().some((tool) => tool.name === READ_BLOCK_TOOL);
	const summary = assembleContext({
		reminders: [...(canReread ? [rereadReminder] : []), fileReminder],
		request: record.request,
		plan: renderPlan(event.branchEntries),
		subagents,
		blocks: shown,
		last: {
			number: last.number,
			text: last.text,
			// The last block runs to the end of the region.
			messages: region
				.slice(region.findIndex((entry) => entry.sourceEntry.id === last.firstEntryId))
				.flatMap((entry) => entry.messages),
			// A block whose request failed keeps its cleaned transcript as its account, which the summary does not show above
			// that transcript's end, however the removal agent cut it.
			account: condensed[condensed.length - 1].text === last.text ? last.text : stored[stored.length - 1].text,
			maxChars: Math.floor(working.contextWindow * lastBlockShare) * charsPerToken,
		},
		nextSteps,
	});
	return {
		summary,
		// No entry has an empty ID, so the rebuilt context keeps no entry from before the compaction.
		firstKeptEntryId: "",
		tokensBefore: event.preparation.tokensBefore,
		usage: meter.total(),
		details: {
			strategy: "blocks",
			request: record.request,
			userMessages,
			blocks: stored,
			borders,
			models: { compactor: modelKey(compactor) },
			...(pruning.kind === "pruned" ? { removed: pruning.removed } : {}),
			...(instructions === undefined ? {} : { instructions }),
		},
	};
}

/** Sums the usage of every model call of one compaction. */
interface UsageMeter {
	add(usage: Usage | undefined): void;
	/** The sum, or undefined when no call reported usage. */
	total(): Usage | undefined;
}

function createUsageMeter(): UsageMeter {
	let total: Usage | undefined;
	return {
		add: (usage) => {
			if (usage) total = total ? combineUsage(total, usage) : usage;
		},
		total: () => total,
	};
}

/**
 * Calls the chat model at medium reasoning, or the nearest level it supports, with the prompt cache `retention`, and
 * records each reply's usage, its cache reads and writes included. Unless `retention` is "none", every request of the
 * caller carries one prompt cache key of its own, where the provider takes one.
 */
function chatCaller(model: Model<Api>, retention: CacheRetention, meter: UsageMeter, ctx: ExtensionContext): Complete {
	const level = clampThinkingLevel(model, "medium");
	const reasoning = level === "off" ? undefined : level;
	const onPayload = retention === "none" ? undefined : oneCacheKey(model, ctx);
	return async (context, signal) => {
		const options = { signal, reasoning, cacheRetention: retention, onPayload };
		const stream = ctx.modelRegistry.streamSimple(model, context, options);
		const reply = await stream.result();
		meter.add(reply.usage);
		return reply;
	};
}

/** The model as stored in the details: `provider/id`. */
function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/** What the previous compaction leaves for this one. */
interface EarlierState {
	/** The user prompt it condensed, if it was a "blocks" compaction. */
	request: string | undefined;
	/** The user inputs it stored, if it was a "blocks" compaction. */
	userMessages: string[];
	blocks: StoredBlock[];
	/** The number of the first new block. */
	nextNumber: number;
}

/**
 * Reads the latest compaction on the branch: its prompt, user inputs and blocks, or its summary carried as block 0.
 */
function readEarlierState(branch: readonly SessionEntry[]): EarlierState {
	const latest = latestCompaction(branch);
	if (!latest) return { request: undefined, userMessages: [], blocks: [], nextNumber: 1 };
	const details = readBlocksDetails(latest);
	if (!details) {
		const carried = { number: 0, firstEntryId: "", lastEntryId: "", text: latest.summary };
		return { request: undefined, userMessages: [], blocks: [carried], nextNumber: 1 };
	}
	const highest = Math.max(0, ...details.blocks.map((block) => block.number));
	return {
		request: details.request,
		userMessages: details.userMessages,
		blocks: details.blocks,
		nextNumber: highest + 1,
	};
}

/**
 * A card for each running or queued worker of the main session, each reported to `onDone` once settled; none in a
 * subagent or when no worker is at work.
 */
async function summarizeTeam(
	complete: Complete,
	enter: EnterStep,
	signal: AbortSignal,
	onDone: () => void,
	ctx: ExtensionContext,
): Promise<SubagentCard[]> {
	const records = findWorkerTeam(ctx)?.subagentRecords() ?? [];
	if (records.length === 0) return [];
	enter("subagents", records.length);
	return summarizeSubagents(records, complete, signal, onDone);
}

/** The latest persisted plan as its objective and one line per task with its status, name and ID. */
function renderPlan(branch: readonly SessionEntry[]): string | undefined {
	const entry = branch.findLast(
		(candidate): candidate is CustomEntry => candidate.type === "custom" && candidate.customType === "planning-state",
	);
	const plan = entry && readPlan(entry.data);
	if (!plan) return undefined;
	// Superseded tasks are left out, as in the planning extension's own context message.
	const tasks = plan.tasks
		.filter((task) => task.state.status !== "superseded")
		.map((task) => `- ${task.state.status}: ${task.spec.name} (${task.spec.id})`);
	return [plan.objective, ...tasks].join("\n");
}

/** The plan held by the data of a persisted `planning-state` entry, or undefined when it fails the schema or the plan's invariants. */
function readPlan(data: unknown): Plan | undefined {
	// Session entries are a disk input boundary, so the plan must pass the persisted schema and its invariants, as when
	// the planning extension restores it.
	if (!Value.Check(planSchema, data)) return undefined;
	try {
		validatePersistedPlan(data);
		return data;
	} catch {
		return undefined;
	}
}
