// Writes a short status card for each subagent of an agent that compacts, from everything the subagent was told and
// everything it said back, so the agent keeps track of the subagents its compacted calls started.
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { clipText, tryEach } from "./block-condenser.ts";
import { maxWorkerTextChars } from "./transcript-cleaner.ts";

/** What the harness knows about one subagent when its parent compacts. */
export interface SubagentRecord {
	id: string;
	/** The agent type, such as "worker" or "explorer". */
	agent: string;
	/** The harness's own status for it, such as "running" or "completed". */
	status: string;
	/** Every prompt it was given, in order: its task, later assignments, follow-ups and messages from the parent. */
	prompts: readonly string[];
	/** Every message it sent to the parent, in order, ending with its latest report when it has one. */
	messages: readonly string[];
}

/** A subagent described for the parent agent. */
export interface SubagentCard {
	id: string;
	agent: string;
	status: string;
	text: string;
}

// Adapted from Claude Code's "Project thread status card classifier" prompt: the opening sentence and the rule for the
// "happened" line. It is meant to be reviewed and edited by a person, not reworded by an agent.
const cardSystemPrompt = `You write the status card for one subagent of a coding agent. The main agent reads the card instead of the subagent's conversation, so the card has to say what the subagent was asked to do and what it has done so far.

You are given every prompt the subagent received, in order, and every message it sent back, ending with its latest report when it has one.

Write two sentences with the concrete nouns: file, function, test name, error, number. The first says what the subagent was asked to do, taking later prompts into account when they changed the task. The second says what it reported, or that no result has arrived when it has not reported yet. No preamble, no markdown, no "I" and no "the subagent".

Reply with the two sentences only.`;

/**
 * Writes a card for each subagent with a chat model, several at a time, and reports each subagent to `onDone` once its
 * card is settled. A subagent whose request fails twice gets its latest prompt as its card, so one failed request does
 * not discard the compaction. Rejects only with the abort reason.
 */
export async function summarizeSubagents(
	records: readonly SubagentRecord[],
	complete: (context: Context, signal: AbortSignal | undefined) => Promise<AssistantMessage>,
	signal: AbortSignal | undefined,
	onDone: () => void,
): Promise<SubagentCard[]> {
	const replies = await tryEach(cardSystemPrompt, records.map(cardRequest), complete, signal, onDone);
	return records.map(({ id, agent, status, prompts }, index) => {
		const reply = replies[index];
		// The latest prompt is the task or steering the subagent is working on now.
		const text = reply.ok ? reply.text : clipText(prompts.at(-1) ?? "", maxWorkerTextChars);
		return { id, agent, status, text };
	});
}

/** The user message that asks for one subagent's card. */
function cardRequest(record: SubagentRecord): string {
	const messages = record.messages.length === 0 ? "(none)" : joinClipped(record.messages);
	return `Here are the prompts:\n<prompts>\n${joinClipped(record.prompts)}\n</prompts>\n\nHere are its messages:\n<messages>\n${messages}\n</messages>`;
}

/**
 * The texts, each clipped to the length the cleaned transcript keeps of a text sent to a worker, separated by a line
 * holding only `---`.
 */
function joinClipped(texts: readonly string[]): string {
	// One long prompt or message, such as a pasted log, would otherwise crowd out the rest.
	return texts.map((text) => clipText(text, maxWorkerTextChars)).join("\n---\n");
}
