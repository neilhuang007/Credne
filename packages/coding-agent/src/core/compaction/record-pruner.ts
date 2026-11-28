// Prunes the condensed record of a compaction, the user prompt and the block accounts, with a chat model that can only
// remove text. Each account is written without sight of the others, so an early account can state something a later
// block changed; this pass removes such statements, and what the compaction's custom instructions name to remove,
// before the summary is assembled and the record is stored.
import {
	type AssistantMessage,
	type Context,
	type Message,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { stopProblem, tryRequest, type Unusable, withInstructions } from "./block-condenser.ts";
import { renderRecord } from "./context-assembler.ts";

/** The condensed record of a compaction: the user prompt and the account of every block so far, in order. */
export interface CondensedRecord<Block extends { number: number; text: string }> {
	request: string;
	blocks: Block[];
}

/** The record as the removal agent left it with the texts it removed, in order, or that the pass was skipped. */
export type PruneResult<Block extends { number: number; text: string }> =
	| { kind: "skipped" }
	| { kind: "pruned"; record: CondensedRecord<Block>; removed: string[] };

// Based by the user on Claude Code's memory consolidation prompt. It is meant to be reviewed and edited by a person, not
// reworded by an agent.
const systemPrompt = `# Consolidation: condensed transcript

You are performing a consolidation — a reflective pass over the condensed record of a coding session. The record is the user prompt followed by one account per block of the session, in the order the work happened. Prune it so that the agent that continues from it can orient quickly.

## Phase 1 — Orient

- Read the user prompt to understand what was asked
- Read the accounts in order to see how the work changed over time

## Phase 2 — Gather

Look for:

1. Statements that drifted — facts that contradict something a later account says
2. Blocks whose work was temporary or was undone later

## Phase 3 — Prune

Remove with the remove tool, which deletes the text you give it where it matches exactly. You can only remove; you cannot write or reword.

- Deleting contradicted facts — if a later account disproves an earlier statement, remove the earlier statement at the source
- Remove statements that are now stale, wrong, or superseded
- Resolve contradictions — if two statements disagree, remove the wrong one

Keep the Important Discoveries:
- Technical constraints or requirements uncovered
- Decisions made and their rationale
- Errors encountered and how they were resolved
- What approaches were tried that didn't work (and why)

---

Return a brief summary of what you removed. If nothing changed (the record is already tight), say so.`;

// The user's wording. It is meant to be reviewed and edited by a person, not reworded by an agent.
function pruneInstructions(instructions: string): string {
	return `There are additional summarization instructions provided below. Remember to follow these instructions. Remove the content or sections they name to remove. Stay away from content that the instructions name to keep.

## Compact Instructions
${instructions}`;
}

/**
 * Lets a chat model remove outdated statements from the record with a `remove` tool, over at most six requests,
 * following the compaction's custom `instructions` when there are any, and returns what is left; an account it empties
 * is left out of the summary, as every empty account is. Skipped when fewer than two accounts hold text, or with
 * instructions when none does, since they may name something to remove; `onStart` is called only when the pass runs. A
 * request without a usable reply after its retry, or the last request, ends the pass with the removals already applied.
 * Rejects only with the abort reason.
 */
export async function pruneRecord<Block extends { number: number; text: string }>(
	record: CondensedRecord<Block>,
	instructions: string | undefined,
	complete: (context: Context, signal: AbortSignal | undefined) => Promise<AssistantMessage>,
	signal: AbortSignal | undefined,
	onStart: () => void,
): Promise<PruneResult<Block>> {
	const filled = record.blocks.filter((block) => block.text !== "").length;
	if (filled < (instructions === undefined ? 2 : 1)) return { kind: "skipped" };
	onStart();
	const bodies: Body[] = [
		{ kind: "prompt", text: record.request },
		...record.blocks.map((block): Body => ({ kind: "account", number: block.number, text: block.text })),
	];
	const prompt = withInstructions(systemPrompt, instructions, pruneInstructions);
	const removed = await runRounds(prompt, renderRecord(record.request, record.blocks), bodies, complete, signal);
	return {
		kind: "pruned",
		record: {
			request: bodies[0].text,
			blocks: record.blocks.map((block, index) => ({ ...block, text: bodies[index + 1].text })),
		},
		removed,
	};
}

/** A part of the record the agent may remove text from: the user prompt or the account of one block. */
type Body = { kind: "prompt"; text: string } | { kind: "account"; number: number; text: string };

// Model requests of one pass, retries not counted.
const maxRounds = 6;

/** Runs the agent over the record, applying each `remove` call to `bodies` in order, and returns the texts removed. */
async function runRounds(
	prompt: string,
	record: string,
	bodies: Body[],
	complete: (context: Context, signal: AbortSignal | undefined) => Promise<AssistantMessage>,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const removed: string[] = [];
	const messages: Message[] = [{ role: "user", content: record, timestamp: Date.now() }];
	for (let round = 0; round < maxRounds; round++) {
		const context: Context = { systemPrompt: prompt, messages, tools: [removeTool] };
		const turn = await tryRequest(context, readTurn, complete, signal);
		if (!turn.ok) break;
		const calls = turn.reply.content.filter((part): part is ToolCall => part.type === "toolCall");
		// A reply without a call is the agent's closing summary, which nothing reads.
		if (calls.length === 0) break;
		messages.push(turn.reply);
		for (const call of calls) {
			const outcome = applyCall(call, bodies);
			if (outcome.kind === "removed") removed.push(outcome.text);
			messages.push(toolResult(call, outcome));
		}
	}
	return removed;
}

/** The reply when it can be used: it stopped normally and holds a tool call or text. */
function readTurn(reply: AssistantMessage): { ok: true; reply: AssistantMessage } | Unusable {
	const problem = stopProblem(reply);
	if (problem !== undefined) return { ok: false, reason: problem };
	const used = reply.content.some(
		(part) => part.type === "toolCall" || (part.type === "text" && part.text.trim() !== ""),
	);
	return used ? { ok: true, reply } : { ok: false, reason: "the reply was blank" };
}

const removeParameters = Type.Object({
	text: Type.String({ description: "The exact text to remove." }),
});

// The user's wording, in the style of Claude Code's edit tool. It is meant to be reviewed and edited by a person, not
// reworded by an agent.
const removeTool: Tool<typeof removeParameters> = {
	name: "remove",
	description:
		"Performs exact text removals in the record.\n\nUsage:\n- `text` must match the record exactly, including whitespace and punctuation.\n- Quote enough of the text to make it unique in the record.",
	parameters: removeParameters,
};

/** What one `remove` call did, or why it removed nothing. */
type Removal =
	| { kind: "removed"; name: string; text: string }
	| { kind: "no match" }
	| { kind: "multiple"; count: number }
	| { kind: "invalid"; message: string };

/** Applies one tool call of the agent to `bodies`. */
function applyCall(call: ToolCall, bodies: Body[]): Removal {
	// A tool call is the model's wire output, so its name and arguments are checked before use, as the agent loop does.
	if (call.name !== removeTool.name) return { kind: "invalid", message: `Tool ${call.name} not found` };
	let args: Static<typeof removeParameters>;
	try {
		args = validateToolArguments(removeTool, call);
	} catch (error) {
		return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
	}
	return removeText(args.text, bodies);
}

/**
 * Removes `text` where it matches exactly once inside one body and tidies the whitespace where the rest of that body is
 * joined.
 */
function removeText(text: string, bodies: Body[]): Removal {
	// Searching each body alone means that a match taking in a heading or a `b<number>` line, or two bodies, is no match:
	// it would break the record's layout.
	const matches = bodies.flatMap((body) => occurrences(body.text, text).map((at) => ({ body, at })));
	if (matches.length === 0) return { kind: "no match" };
	if (matches.length > 1) return { kind: "multiple", count: matches.length };
	const [{ body, at }] = matches;
	body.text = joinTidied(body.text.slice(0, at), body.text.slice(at + text.length));
	return { kind: "removed", name: body.kind === "prompt" ? "the user prompt" : `b${body.number}`, text };
}

/** Where `text` starts in `body`, overlapping matches included; nowhere for an empty text. */
function occurrences(body: string, text: string): number[] {
	// The schema lets the model send an empty text, which would match everywhere.
	if (text === "") return [];
	const found: number[] = [];
	for (let at = body.indexOf(text); at !== -1; at = body.indexOf(text, at + 1)) found.push(at);
	return found;
}

// Punctuation that takes no space before it, and brackets that take none after them.
const closingMark = /^[.,;:!?)\]}]/;
const openingMark = /[([{]$/;

/**
 * The text before and after a removal joined again, changing only the whitespace between them: no doubled space, no
 * space before punctuation and no blank line left behind. A line break keeps the indentation of the line it starts.
 */
function joinTidied(before: string, after: string): string {
	const head = before.trimEnd();
	const tail = after.trimStart();
	if (head === "") return tail;
	if (tail === "") return head;
	const leftGap = before.slice(head.length);
	const rightGap = after.slice(0, after.length - tail.length);
	// A removed line leaves a line break on each side, and a removed paragraph a blank line: one of them is kept.
	const breaks = Math.min(2, Math.max(countBreaks(leftGap), countBreaks(rightGap)));
	if (breaks > 0) {
		const gap = rightGap.includes("\n") ? rightGap : leftGap;
		return `${head}${"\n".repeat(breaks)}${gap.slice(gap.lastIndexOf("\n") + 1)}${tail}`;
	}
	const spaced = leftGap !== "" || rightGap !== "";
	return spaced && !closingMark.test(tail) && !openingMark.test(head) ? `${head} ${tail}` : `${head}${tail}`;
}

function countBreaks(gap: string): number {
	return gap.split("\n").length - 1;
}

/** The tool result that tells the agent what its call did. */
function toolResult(call: ToolCall, outcome: Removal): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: describeRemoval(outcome) }],
		isError: outcome.kind !== "removed",
		timestamp: Date.now(),
	};
}

// The texts follow the repo's edit tool, as in the user's test of this pass.
function describeRemoval(outcome: Removal): string {
	switch (outcome.kind) {
		case "removed":
			return `Successfully removed the text from ${outcome.name}.`;
		case "no match":
			return "Could not find the exact text in the record. The text must match exactly including all whitespace and newlines, and must lie within the user prompt or one account, without a heading or a b<N> line.";
		case "multiple":
			return `Found ${outcome.count} occurrences of the text in the record. The text must be unique. Please provide more context to make it unique.`;
		case "invalid":
			return outcome.message;
	}
}
