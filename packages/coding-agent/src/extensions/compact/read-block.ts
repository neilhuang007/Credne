// Lets the agent read the full original transcript of a block that a compaction of the "blocks" strategy condensed.
import { Type } from "typebox";
import { renderTranscript } from "../../core/compaction/transcript-cleaner.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { type SessionEntry, sessionEntryToContextMessages } from "../../core/session-manager.ts";
import { latestCompaction, readBlocksDetails } from "./blocks-details.ts";

/** Name of the tool that reads a condensed block in full. */
export const READ_BLOCK_TOOL = "read_block";

/**
 * Registers `read_block`, declared late: it becomes active after a compaction of the "blocks" strategy, or on a branch
 * whose latest compaction is one, and then stays active.
 */
export function registerReadBlock(pi: ExtensionAPI): void {
	pi.registerTool({
		name: READ_BLOCK_TOOL,
		label: "Read block",
		// Draft wording, to be reviewed by a person.
		description:
			"Read the full original transcript of a block from the agent transcript. The condensed account leaves details out; use this before you quote the original or rely on such a detail. Pass the block number, and offset to continue a long block.",
		parameters: Type.Object({
			block: Type.Integer({ description: "The block number." }),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "Character offset to start from. Default: 0." }),
			),
		}),
		// Activated by a compaction, so the initial tool list never holds it.
		defaultActive: false,
		async execute(_id, params, _signal, _update, ctx) {
			const transcript = blockTranscript(params.block, ctx.sessionManager.getBranch());
			return { content: [{ type: "text", text: page(transcript, params.offset ?? 0) }], details: {} };
		},
	});

	function activate(): void {
		const active = pi.getActiveTools();
		if (!active.includes(READ_BLOCK_TOOL)) pi.setActiveTools([...active, READ_BLOCK_TOOL]);
	}

	function restore(ctx: ExtensionContext): void {
		const latest = latestCompaction(ctx.sessionManager.getBranch());
		if (latest && readBlocksDetails(latest)) activate();
	}

	pi.on("session_compact", (event) => {
		if (readBlocksDetails(event.compactionEntry)) activate();
	});
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
}

/** The block's entries rendered as a transcript, uncleaned so nothing is left out. Throws for a block it cannot read. */
function blockTranscript(number: number, branch: SessionEntry[]): string {
	const latest = latestCompaction(branch);
	const block = latest && readBlocksDetails(latest)?.blocks.find((candidate) => candidate.number === number);
	if (!block) throw new Error(`Unknown block ${number}: the latest compaction has no block with this number.`);
	if (block.number === 0) {
		throw new Error("Block 0 was carried over from an older summary and has no transcript to read.");
	}
	const first = branch.findIndex((entry) => entry.id === block.firstEntryId);
	const last = branch.findIndex((entry) => entry.id === block.lastEntryId);
	// The IDs come from persisted session data, so they may name entries that are not on this branch.
	if (first < 0 || last < first) throw new Error(`The entries of block ${number} are not on the current branch.`);
	return renderTranscript(branch.slice(first, last + 1).flatMap(sessionEntryToContextMessages));
}

const pageChars = 20_000;

/** The characters from `offset` on, at most one page, with a notice saying how to continue when more remains. */
function page(transcript: string, offset: number): string {
	if (offset > 0 && offset >= transcript.length) {
		throw new Error(`Offset ${offset} is beyond the end of the block (${transcript.length} characters).`);
	}
	const end = Math.min(transcript.length, offset + pageChars);
	const shown = transcript.slice(offset, end).toWellFormed();
	if (end === transcript.length) return shown;
	return `${shown}\n\n[Showing characters ${offset + 1}-${end} of ${transcript.length}. Use offset=${end} to continue.]`;
}
