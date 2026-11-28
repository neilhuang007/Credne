// Condenses each block of a compaction region to a short account of the assistant's work, with a chat model asked once
// per block; a block whose request fails twice keeps its cleaned text as its account. Also holds the helpers its sibling
// steps share for asking a chat model, once, about many items at once, or in a conversation of their own: a request
// without a usable reply is retried once after a wait, and each step puts a text of its own in place of a reply that
// fails again; and the helper that appends a compaction's custom instructions to a system prompt.
import { type AssistantMessage, type Context, contentText } from "@earendil-works/pi-ai";
import { sleep } from "../../utils/sleep.ts";
import type { Block } from "./slicer.ts";

/** A block condensed to an account of the assistant's work. */
export interface CondensedBlock {
	number: number;
	firstEntryId: string;
	lastEntryId: string;
	/** Empty when nothing in the block needed to be kept. */
	text: string;
}

// The length situations are the user's. The rest is stitched from Claude Code's prompts: session transcript chunk
// summary, context compaction summary, reporting outcomes, compaction omitted tool result handling, subagent reporting
// notes, outcome-first communication style, conversation summarization (user feedback), coordinator mode orchestration
// (worker reports) and the ScheduleWakeup no-op guidance (nothing worth keeping). It is meant to be reviewed and edited
// by a person, not reworded by an agent.
const condenserSystemPrompt = `You are a subagent that focuses on condensing one block of a coding session, given the user prompt and the block.

Summarize this portion of the session transcript as an account of what the assistant did, in chronological order. Focus on:
1. What the assistant did: files created or changed as (path lines), for example (src/app.ts 111:112)
2. Technical constraints or requirements uncovered
3. Decisions made and their rationale
4. Errors encountered and how they were resolved, and approaches that were tried and didn't work (and why)
5. The outcome

Determine the length of the account from the importance of the block to the user prompt:
- The block achieved nothing that later work depends on, for example the assistant only reported status, answered a question, waited for a subagent, or read and searched without a finding: reply with exactly: (nothing to keep)
- Predetermined implementation with no new design choices: one brief paragraph for each separate change.
- A decision, a steering instruction, an error and its resolution, a small design choice, or the result of a test or check: add 3–5 sentences on these.
- Important design choices, technical discussion, a change of direction, or several approaches ruled out where later work depends on why each failed: keep each decision and the reasons that led to it, however long that takes.
Be concise but complete—err on the side of including information that would prevent duplicate work or repeated mistakes, and exceed these lengths only for that.

Write plain sentences from the assistant's side only. Do not repeat the user's inputs; where the user told the assistant to do something differently, say what the assistant changed. Leave out what the assistant explained, proposed or reported to the user, except facts it found and decisions that were made; of a discussion, keep the decision and its reason. Leave out how the work was carried out: the individual commands, searches and reads, and details that the changed files themselves show. Do not recap code that was merely read. Summarize a batch of edits as one change and say what it achieved, instead of describing each edit, and name the files once, with their lines, as the block's [Edited] lines show them. A subagent's report describes what it intended to do, not necessarily what it did: give its outcome, the files it changed and what it left open as the subagent's work, not the assistant's. Report what actually happened, not what was intended: keep the result of a test or check with its numbers, and when the block ends before the work is complete, say what is left. Do not guess at what a shortened output held, and do not mention it. Drop details that don't change what the reader would do next, such as what the block did not do. The user prompt tells you what matters; do not judge the block against it. Preserve specific details like file names, error messages, and user feedback.

Reply with the account only, or with exactly: (nothing to keep)`;

// The user's wording. It is meant to be reviewed and edited by a person, not reworded by an agent.
function condenserInstructions(instructions: string): string {
	return `There are additional summarization instructions provided below. Remember to follow these instructions when creating the account. Keep all content that the instructions name to keep.

## Compact Instructions
${instructions}`;
}

/**
 * Condenses each block with a chat model, following the compaction's custom `instructions` when there are any, and
 * reports each block to `onDone` once its account is settled. Every request shares one prefix, the system prompt with the
 * user prompt, and differs only in its block; the shortest block's request goes first, alone, and the others follow
 * several at a time once it is answered, so that they can read that prefix from a cache it wrote. A block whose request
 * fails twice keeps its whole cleaned text as its account, so one failed request does not discard the compaction.
 * Rejects only with the abort reason.
 */
export async function condenseBlocks(
	blocks: readonly Block[],
	request: string,
	instructions: string | undefined,
	complete: (context: Context, signal: AbortSignal | undefined) => Promise<AssistantMessage>,
	signal: AbortSignal | undefined,
	onDone: () => void,
): Promise<CondensedBlock[]> {
	// The user prompt sits in the system prompt, the slot that providers cache as a prefix, so only the block follows it.
	const systemPrompt = `${withInstructions(condenserSystemPrompt, instructions, condenserInstructions)}\n\nHere is the user prompt:\n<user-prompt>\n${request}\n</user-prompt>`;
	const messages = blocks.map((block) => `Here is the block:\n<block>\n${block.text}\n</block>`);
	const shortest = blocks.reduce(
		(best, block, index) => (block.text.length < blocks[best].text.length ? index : best),
		0,
	);
	const replies = await tryOneFirst(systemPrompt, messages, shortest, complete, signal, onDone);
	return blocks.map(({ number, firstEntryId, lastEntryId, text }, index) => {
		const reply = replies[index];
		// The cleaned text reads as a transcript, so it stands in for the account without a marker.
		return { number, firstEntryId, lastEntryId, text: reply.ok ? boundedAccount(reply.text, text.length) : text };
	});
}

/**
 * The system prompt followed by a blank line and the block that gives the compaction's custom `instructions`, or the
 * prompt alone when there are none.
 */
export function withInstructions(
	systemPrompt: string,
	instructions: string | undefined,
	block: (instructions: string) => string,
): string {
	return instructions === undefined ? systemPrompt : `${systemPrompt}\n\n${block(instructions)}`;
}

/**
 * Asks a chat model once per user message as {@link tryEach} does, but sends the message at `first` alone before the
 * others, since a prefix cached by a request can be read only once that request is answered.
 */
async function tryOneFirst(
	systemPrompt: string,
	messages: readonly string[],
	first: number,
	complete: (context: Context, signal: AbortSignal | undefined) => Promise<AssistantMessage>,
	signal: AbortSignal | undefined,
	onDone: () => void,
): Promise<ReadReply[]> {
	if (messages.length < 2) return tryEach(systemPrompt, messages, complete, signal, onDone);
	const firstReply = await tryModel(systemPrompt, messages[first], complete, signal);
	onDone();
	const replies = await tryEach(
		systemPrompt,
		messages.filter((_, index) => index !== first),
		complete,
		signal,
		onDone,
	);
	replies.splice(first, 0, firstReply);
	return replies;
}

function boundedAccount(reply: string, maxChars: number): string {
	if (reply === "(nothing to keep)" || maxChars === 0) return "";
	if (reply.length <= maxChars) return reply;
	return `${clipText(reply, maxChars - 1).trimEnd()}…`;
}

// Requests to the chat model that run at the same time.
const maxConcurrentRequests = 8;

/**
 * Asks a chat model once per user message, several at a time, and returns each reply read for use, in order, as
 * {@link tryModel} reads it; reports each message to `onDone` once its reply is read. Rejects only with the abort reason.
 */
export function tryEach(
	systemPrompt: string,
	messages: readonly string[],
	complete: (context: Context, signal: AbortSignal | undefined) => Promise<AssistantMessage>,
	signal: AbortSignal | undefined,
	onDone: () => void,
): Promise<ReadReply[]> {
	// tryModel rejects only on an abort, so no failed request stops the others.
	return runEach(
		messages,
		async (message, stopped) => {
			const reply = await tryModel(systemPrompt, message, complete, stopped);
			onDone();
			return reply;
		},
		signal,
	);
}

/**
 * Runs `ask` once per item, several at a time, and returns the results in order. Rejects with the first rejection, after
 * stopping the others, or with the abort reason once `signal` aborts.
 */
async function runEach<Item, Result>(
	items: readonly Item[],
	ask: (item: Item, signal: AbortSignal) => Promise<Result>,
	signal: AbortSignal | undefined,
): Promise<Result[]> {
	// A failure aborts the requests still in flight, and the workers are awaited, so no request outlives the step.
	const stop = new AbortController();
	const stopped = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
	const results: Result[] = [];
	let failure: unknown;
	let next = 0;
	const work = async (): Promise<void> => {
		while (next < items.length && !stopped.aborted) {
			const index = next++;
			try {
				results[index] = await ask(items[index], stopped);
			} catch (error) {
				failure ??= error;
				stop.abort();
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(maxConcurrentRequests, items.length) }, work));
	signal?.throwIfAborted();
	if (failure !== undefined) throw failure;
	return results;
}

// Rate limits and overloads last for seconds, so an immediate retry tends to meet the same condition.
const retryDelayMs = 5_000;

/**
 * Asks a chat model with one user message and returns the reply read for use, retried as {@link tryRequest} retries it.
 * Rejects only with the abort reason.
 */
export function tryModel(
	systemPrompt: string,
	userMessage: string,
	complete: (context: Context, signal: AbortSignal | undefined) => Promise<AssistantMessage>,
	signal: AbortSignal | undefined,
): Promise<ReadReply> {
	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
	};
	return tryRequest(context, readReply, complete, signal);
}

/** Why a reply cannot be used. */
export interface Unusable {
	ok: false;
	reason: string;
}

/**
 * Sends one request and returns its reply as `read` reads it. A request without a usable reply, because it was rejected
 * or `read` finds the reply unusable, is sent once more after a wait, and the second reply is returned whatever it is.
 * Rejects only with the abort reason, at once and without a retry, once `signal` aborts.
 */
export async function tryRequest<Read extends { ok: true } | Unusable>(
	context: Context,
	read: (reply: AssistantMessage) => Read,
	complete: (context: Context, signal: AbortSignal | undefined) => Promise<AssistantMessage>,
	signal: AbortSignal | undefined,
): Promise<Read | Unusable> {
	const first = await attemptRequest(context, read, complete, signal);
	// An abort cancels the compaction; it is not a failure to retry.
	signal?.throwIfAborted();
	if (first.ok) return first;
	// The wait ends at once on an abort, which is rethrown with its reason on the next line.
	await sleep(retryDelayMs, signal).catch(() => undefined);
	signal?.throwIfAborted();
	const second = await attemptRequest(context, read, complete, signal);
	signal?.throwIfAborted();
	return second;
}

/** A model reply read for use: its trimmed text, or why it cannot be used. */
export type ReadReply = { ok: true; text: string } | Unusable;

/** The reply's trimmed text, or why it is not usable: it failed, was aborted, hit the token cap or came back blank. */
function readReply(reply: AssistantMessage): ReadReply {
	const problem = stopProblem(reply);
	if (problem !== undefined) return { ok: false, reason: problem };
	const text = contentText(reply.content).trim();
	return text ? { ok: true, text } : { ok: false, reason: "the reply was blank" };
}

/** Why the reply cannot be used whatever it holds: it failed, was aborted or hit the token cap; otherwise undefined. */
export function stopProblem(reply: AssistantMessage): string | undefined {
	// The reply is a model's wire output. A reply cut off by the token cap would end mid-sentence, so it is not used.
	if (reply.stopReason === "error" || reply.stopReason === "aborted") {
		return reply.errorMessage || `stop reason ${reply.stopReason}`;
	}
	if (reply.stopReason === "length") return "the reply hit the token cap";
	return undefined;
}

/** One request's reply as `read` reads it; a rejected request is not usable either. */
async function attemptRequest<Read extends { ok: true } | Unusable>(
	context: Context,
	read: (reply: AssistantMessage) => Read,
	complete: (context: Context, signal: AbortSignal | undefined) => Promise<AssistantMessage>,
	signal: AbortSignal | undefined,
): Promise<Read | Unusable> {
	try {
		return read(await complete(context, signal));
	} catch (error) {
		// The injected call may reject, for example while it prepares the request.
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

/** The text's first `max` characters, with a split surrogate pair replaced rather than kept as invalid text. */
export function clipText(text: string, max: number): string {
	return text.slice(0, max).toWellFormed();
}
