// Assembles the text an agent continues from after compaction: the reminders, the condensed user prompt, the plan, the
// subagent cards, the condensed transcript by block ending with the last block's cleaned transcript, and the next steps.
// Also lays out, the same way, the record of the user prompt and the accounts that the removal agent prunes.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CondensedBlock } from "./block-condenser.ts";
import { nextStepsHeading } from "./next-steps.ts";
import type { SubagentCard } from "./subagent-card.ts";
import { renderCleanedEnd, truncatedMarker } from "./transcript-cleaner.ts";

/** The parts of the context an agent continues from after compaction. */
export interface AssemblyInput {
	/** The reminders the text opens with, one per line. */
	reminders: readonly string[];
	/** The condensed user prompt. */
	request: string;
	/** The current plan, already rendered, when one exists. */
	plan?: string;
	subagents: readonly SubagentCard[];
	/** The blocks whose accounts the agent transcript shows, in order: every block so far but the last one. */
	blocks: readonly Pick<CondensedBlock, "number" | "text">[];
	/** The last block, which ends the agent transcript. */
	last: LastBlock;
	/** What the agent does next, as the next-steps writer returned it. */
	nextSteps: string;
}

/** The last block as the context shows it. */
export interface LastBlock {
	number: number;
	/** Its cleaned transcript, as the account writer read it. */
	text: string;
	/** Its cleaned messages, from which a transcript longer than `maxChars` is rendered by its end. */
	messages: readonly AgentMessage[];
	/**
	 * Its account, shown above the end of its transcript when the whole is longer than `maxChars`, unless the account is
	 * that cleaned transcript itself, as for a block whose request failed.
	 */
	account: string;
	/** The most characters shown under its `b<number>` line, unless its account alone is longer. */
	maxChars: number;
}

// The headings of the parts that the record of the removal agent shares with the summary.
const requestHeading = "User prompt";
const transcriptHeading = "Agent transcript";

/**
 * Builds the text an agent continues from: the reminders, then the user prompt, the plan, its subagents, the agent's
 * transcript by block and the next steps. A part with nothing in it is left out with its heading.
 */
export function assembleContext(input: AssemblyInput): string {
	const subagents = input.subagents.map((card) => `${card.id} (${card.agent}, ${card.status}): ${card.text}`);
	const transcript = [renderAccounts(input.blocks), renderLastBlock(input.last)].filter((entry) => entry !== "");
	const shown = renderParts([
		[requestHeading, input.request],
		["Plan", input.plan ?? ""],
		["Subagents", subagents.join("\n")],
		[transcriptHeading, transcript.join("\n\n")],
		[nextStepsHeading, input.nextSteps],
	]);
	return [input.reminders.join("\n"), shown].filter((paragraph) => paragraph !== "").join("\n\n");
}

/**
 * The user prompt and the accounts of `blocks` laid out as the summary lays them out, under the headings of its user
 * prompt and its agent transcript, leaving out empty accounts.
 */
export function renderRecord(request: string, blocks: readonly Pick<CondensedBlock, "number" | "text">[]): string {
	return renderParts([
		[requestHeading, request],
		[transcriptHeading, renderAccounts(blocks)],
	]);
}

/** Each part under its heading line, separated by blank lines; a part with nothing in it is left out with its heading. */
function renderParts(parts: readonly [heading: string, body: string][]): string {
	return parts
		.filter(([, body]) => body !== "")
		.map(([heading, body]) => `${heading}:\n${body}`)
		.join("\n\n");
}

/** Renders block accounts as the agent transcript shows them: `b<number>` over each account, leaving out empty ones. */
function renderAccounts(blocks: readonly Pick<CondensedBlock, "number" | "text">[]): string {
	return blocks
		.filter((block) => block.text !== "")
		.map((block) => `b${block.number}\n${block.text}`)
		.join("\n\n");
}

/**
 * The last block's entry: `b<number>` over its cleaned transcript when that fits `maxChars`, otherwise over its account,
 * a blank line, the marker line and the end of the transcript that fits the rest, starting at a message or tool line.
 * An account that is the cleaned transcript itself is left out, so the text does not appear twice. Empty when the
 * transcript is.
 */
function renderLastBlock(last: LastBlock): string {
	if (last.text === "") return "";
	if (last.text.length <= last.maxChars) return `b${last.number}\n${last.text}`;
	// An empty account is left out with its blank line, as the earlier blocks leave out theirs; so is the cleaned text a
	// block whose request failed keeps as its account.
	const head =
		last.account === "" || last.account === last.text ? truncatedMarker : `${last.account}\n\n${truncatedMarker}`;
	const end = renderCleanedEnd(last.messages, last.maxChars - head.length - 1);
	return [`b${last.number}`, head, end].filter((line) => line !== "").join("\n");
}
