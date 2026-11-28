// Writes the next steps of a compacted session with a chat model that reads what the main agent's context held, cleaned:
// the previous compaction's summary and the conversation since, as the block writers read it, and follows the
// compaction's custom instructions when there are any. The reply is the summary's part headed `Next steps`.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { tryModel, withInstructions } from "./block-condenser.ts";
import { renderCleaned, renderCleanedEnd, truncatedMarker } from "./transcript-cleaner.ts";

// Claude Code's wording chosen by the user, with one word changed by the user. It is meant to be reviewed and edited by
// a person, not reworded by an agent.
const nextStepsSystemPrompt = `You have been working on the task described below but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary.

Next Steps
Outline any pending tasks that you have explicitly been asked to work on.
List the next step that you will take that is related to the most recent work you were doing.
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain
If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Write in a way that enables immediate resumption of the task.
Do NOT call any tools.`;

// The user's wording. It is meant to be reviewed and edited by a person, not reworded by an agent.
function nextStepsInstructions(instructions: string): string {
	return `There are additional summarization instructions provided below. Remember to follow these instructions when creating the above summary. If they contain next steps, include those exact instructions in your Next Steps.

## Compact Instructions
${instructions}`;
}

// The user's own wording. It is meant to be reviewed and edited by a person, not reworded by an agent.
const fallbackText =
	"Please compare the current work done with the intended task in the prompt, and finish anything left.";

/** The heading of the summary's part that holds the next steps. */
export const nextStepsHeading = "Next steps";

/**
 * Writes the next steps from the previous compaction's summary, if any, and the cleaned messages since, fitted to
 * `maxChars`, following the compaction's custom `instructions` when there are any, and returns them without a first
 * line that only repeats {@link nextStepsHeading}. A request that fails
 * twice, or whose reply is that heading alone, gives a fixed request to check the work against the task instead, so it
 * does not discard the compaction. Rejects only with the abort reason.
 */
export async function writeNextSteps(
	previousSummary: string | undefined,
	messages: readonly AgentMessage[],
	maxChars: number,
	instructions: string | undefined,
	complete: (context: Context, signal: AbortSignal | undefined) => Promise<AssistantMessage>,
	signal: AbortSignal | undefined,
): Promise<string> {
	const reply = await tryModel(
		withInstructions(nextStepsSystemPrompt, instructions, nextStepsInstructions),
		heldContext(previousSummary, messages, maxChars),
		complete,
		signal,
	);
	const text = reply.ok ? withoutHeadingLine(reply.text) : "";
	return text === "" ? fallbackText : text;
}

/**
 * The summary and the rendered messages, separated by a blank line. When they exceed `maxChars`, the summary whole, a
 * blank line, the marker line and the end of the messages that fits the rest, starting at a message or tool line; the
 * summary is left out only when it alone exceeds `maxChars`.
 */
function heldContext(previousSummary: string | undefined, messages: readonly AgentMessage[], maxChars: number): string {
	const summary = previousSummary ?? "";
	const whole = [summary, renderCleaned(messages)].filter((part) => part !== "").join("\n\n");
	if (whole.length <= maxChars) return whole;
	// The summary's own next steps are the only record of a task pending before it and not mentioned since.
	const head = summary !== "" && summary.length <= maxChars ? `${summary}\n\n${truncatedMarker}` : truncatedMarker;
	return `${head}\n${renderCleanedEnd(messages, maxChars - head.length - 1)}`;
}

// Markdown a heading line may be dressed in: hashes, emphasis and a closing colon.
const headingMarkup = /[#*_:\s]+/g;

/**
 * The text without its first line when that line only repeats {@link nextStepsHeading}, in any case and markdown dress,
 * such as `## Next Steps` or `**Next steps:**`, since the part's own heading line already shows it.
 */
function withoutHeadingLine(text: string): string {
	const [first, ...rest] = text.split("\n");
	const repeated = first.replace(headingMarkup, " ").trim().toLowerCase() === nextStepsHeading.toLowerCase();
	return repeated ? rest.join("\n").trim() : text;
}
