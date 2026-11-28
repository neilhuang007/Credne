// Cuts a cleaned compaction region into blocks, each one request and the work done for it. A block starts at the
// region's first entry, at a user message sent after the agent had finished its turn or been interrupted (a message
// typed into running work only steers it), at an assistant message that hands work to a worker, and at the first entry
// that can open a block after a plan task is marked done. Nothing else divides: on real sessions the checks, commits and
// reports inside one piece of work almost never began a new request. A border met while the current block holds no
// assistant message yet is absorbed into it, and a block under `minBlockTokens` joins the block before it.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { arrayArg, type CleanEntry, isJsonObject, renderCleaned, stringArg } from "./transcript-cleaner.ts";

/** Why a block starts at an entry: the region start, a user request, a dispatch to a worker, a finished plan task. */
export type BorderKind = "start" | "user" | "dispatch" | "plan";

/** A border as the rules cut it, before small blocks join the block before them. */
export interface Border {
	firstEntryId: string;
	/** The kinds it opens with, each once, in the order they arrived: those at its first entry and those absorbed. */
	kinds: BorderKind[];
	/** Estimated tokens of the original conversation from this border to the next. */
	tokens: number;
}

/** One request and the work done for it. */
export interface Block {
	/** Continues from earlier compactions; the model sees it as `b<number>`. */
	number: number;
	firstEntryId: string;
	lastEntryId: string;
	/** Estimated tokens of its entries in the original conversation, before cleaning. */
	tokens: number;
	/** The kinds of the border it opens with. */
	kinds: BorderKind[];
	/** Its cleaned messages as plain text, as the account writer reads them. */
	text: string;
}

/** The borders as cut and the blocks after small ones joined the block before them. */
export interface SlicedRegion {
	borders: Border[];
	blocks: Block[];
}

/** The entries from one border to the next, while the walk fills them. */
interface Cut {
	kinds: BorderKind[];
	firstEntryId: string;
	lastEntryId: string;
	tokens: number;
	messages: AgentMessage[];
	/** Holds an assistant message; until then a later border is absorbed instead of opening a cut. */
	answered: boolean;
}

/** What the walk carries from entry to entry. */
interface Walk {
	cuts: Cut[];
	/** The latest assistant message so far as the session stored it, before cleaning. */
	lastAssistant: AssistantMessage | undefined;
	/** Kinds of the borders after a message, waiting for the next entry that can open a block. */
	pending: BorderKind[];
}

/**
 * Cuts a cleaned region, the output of `cleanTranscript`, into blocks numbered from `firstNumber`, and returns them
 * with the borders as cut before small blocks joined.
 */
export function sliceRegion(entries: readonly CleanEntry[], firstNumber: number): SlicedRegion {
	const cuts = cutRegion(entries);
	const borders = cuts.map(({ firstEntryId, kinds, tokens }) => ({ firstEntryId, kinds, tokens }));
	const blocks = joinSmallCuts(cuts).map(({ firstEntryId, lastEntryId, tokens, kinds, messages }, index) => ({
		number: firstNumber + index,
		firstEntryId,
		lastEntryId,
		tokens,
		kinds,
		text: renderCleaned(messages),
	}));
	return { borders, blocks };
}

function cutRegion(entries: readonly CleanEntry[]): Cut[] {
	if (entries.length === 0) return [];
	const walk: Walk = { cuts: [openCut(["start"], entries[0].sourceEntry.id)], lastAssistant: undefined, pending: [] };
	for (const entry of entries) walkEntry(entry, walk);
	return walk.cuts;
}

function openCut(kinds: BorderKind[], entryId: string): Cut {
	return { kinds, firstEntryId: entryId, lastEntryId: entryId, tokens: 0, messages: [], answered: false };
}

function walkEntry(entry: CleanEntry, walk: Walk): void {
	const source = entry.sourceEntry;
	// Tool results and injected messages never open a block, so a tool call stays with its result and a border after
	// a message waits for the next entry that can open one.
	if (entry.messages.some((message) => message.role === "user" || message.role === "assistant")) {
		placeBorder([...walk.pending, ...entryBorders(entry.messages, walk.lastAssistant)], source.id, walk);
		walk.pending = [];
	}
	const cut = walk.cuts[walk.cuts.length - 1];
	cut.lastEntryId = source.id;
	cut.tokens += entry.rawTokens;
	for (const message of entry.messages) {
		cut.messages.push(message);
		if (message.role !== "assistant") continue;
		cut.answered = true;
		if (completesTask(message)) walk.pending.push("plan");
	}
	// The cleaner removes aborted and failed replies, which still end a turn, so the turn is read from the stored message.
	if (source.type === "message" && source.message.role === "assistant") walk.lastAssistant = source.message;
}

/** The kinds of the borders an entry's own messages place before it. */
function entryBorders(messages: readonly AgentMessage[], lastAssistant: AssistantMessage | undefined): BorderKind[] {
	return messages.flatMap((message): BorderKind[] => {
		if (message.role === "user") return turnEnded(lastAssistant) ? ["user"] : [];
		if (message.role !== "assistant") return [];
		return message.content.some((part) => part.type === "toolCall" && dispatchesWorker(part)) ? ["dispatch"] : [];
	});
}

/**
 * Whether the agent was waiting when the user wrote: its last message made no tool call, was aborted or failed, or
 * there was none in the region.
 */
function turnEnded(last: AssistantMessage | undefined): boolean {
	if (!last) return true;
	if (last.stopReason === "aborted" || last.stopReason === "error") return true;
	return !last.content.some((part) => part.type === "toolCall");
}

const assignTools: ReadonlySet<string> = new Set(["assign_tasks", "assign_task"]);

/**
 * Whether the call hands work to a worker: an assign tool, or a subagent call naming the `worker` agent at its top
 * level or in an item of `tasks` or `chain`. The other agents serve the current work.
 */
function dispatchesWorker(call: ToolCall): boolean {
	if (assignTools.has(call.name)) return true;
	if (call.name !== "subagent") return false;
	const args = call.arguments;
	const items = [args, ...arrayArg(args, "tasks"), ...arrayArg(args, "chain")];
	return items.some((item) => isJsonObject(item) && stringArg(item, "agent") === "worker");
}

/**
 * Opens a new cut of the kinds at the entry, or adds them to the current cut while that holds no assistant message
 * yet, which keeps a request together with the reply to it.
 */
function placeBorder(kinds: readonly BorderKind[], entryId: string, walk: Walk): void {
	if (kinds.length === 0) return;
	const cut = walk.cuts[walk.cuts.length - 1];
	if (cut.answered) walk.cuts.push(openCut([...new Set(kinds)], entryId));
	else cut.kinds = [...new Set([...cut.kinds, ...kinds])];
}

/** Whether the message marks a plan task done. */
function completesTask(message: AssistantMessage): boolean {
	return message.content.some(
		(part) =>
			part.type === "toolCall" && part.name === "task_update" && stringArg(part.arguments, "status") === "done",
	);
}

// A block smaller than this, in tokens of the original conversation, joins the block before it: its account would
// come out nearly as long as the block itself.
const minBlockTokens = 2_000;

/** The cuts with each one under `minBlockTokens` joined to the one before it; the first has none and stays. */
function joinSmallCuts(cuts: readonly Cut[]): Cut[] {
	const joined: Cut[] = [];
	for (const cut of cuts) {
		const previous = joined.at(-1);
		if (previous && cut.tokens < minBlockTokens) {
			const { lastEntryId, tokens, messages } = cut;
			joined[joined.length - 1] = {
				...previous,
				lastEntryId,
				tokens: previous.tokens + tokens,
				messages: [...previous.messages, ...messages],
			};
		} else {
			joined.push(cut);
		}
	}
	return joined;
}
