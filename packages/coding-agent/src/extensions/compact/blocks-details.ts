// The details a compaction of the "blocks" strategy stores in its entry, and how to read them back from a branch.
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { CompactionEntry, SessionEntry } from "../../core/session-manager.ts";

const storedBlockSchema = Type.Object({
	number: Type.Integer({ minimum: 0 }),
	firstEntryId: Type.String(),
	lastEntryId: Type.String(),
	text: Type.String(),
});

// Entries stored before the borders were cut by rules alone also hold a `score` and a `source` per border, kinds that
// are no longer placed and a classifier in `models`. The objects allow extra properties and the kinds are plain
// strings, so those entries still pass and the next compaction reads their blocks, prompt and inputs.
const storedBorderSchema = Type.Object({
	firstEntryId: Type.String(),
	kinds: Type.Array(Type.String()),
	/** Estimated tokens of the original conversation from this border to the next. */
	tokens: Type.Number(),
});

// Entries stored while the summary listed the files changed also hold `changedFiles`, and entries stored while another
// model wrote the accounts and cards hold `models.writer`. The objects allow extra properties, so those entries still
// pass and the next compaction reads their blocks, prompt and inputs.
const blocksDetailsSchema = Type.Object({
	strategy: Type.Literal("blocks"),
	request: Type.String(),
	userMessages: Type.Array(Type.String()),
	blocks: Type.Array(storedBlockSchema),
	borders: Type.Array(storedBorderSchema),
	models: Type.Object({ compactor: Type.String() }),
	// Absent when the removal agent did not run, and in entries stored before it existed.
	removed: Type.Optional(Type.Array(Type.String())),
	// Absent when the compaction had no custom instructions, and in entries stored before they were stored.
	instructions: Type.Optional(Type.String()),
});

/** A condensed block as a compaction entry stores it. Block 0 holds an older summary and has empty entry IDs. */
export type StoredBlock = Static<typeof storedBlockSchema>;

/** A border of the compaction's region as cut, before small blocks joined the block before them. */
export type StoredBorder = Static<typeof storedBorderSchema>;

/**
 * What a compaction of the "blocks" strategy stores in `details`: the condensed user prompt (every user input so far
 * joined, when the request to condense it failed) and every block so far (the last one included), both as the removal
 * agent left them; every user input so far (kept as the record of what the user wrote), the borders of this
 * compaction's region as cut, the model it used as `provider/id`, the texts the removal agent removed, when it ran, and
 * the custom instructions the compaction followed, when it had any.
 */
export type BlocksDetails = Static<typeof blocksDetailsSchema>;

/** The latest compaction entry on the branch, or undefined without one. */
export function latestCompaction(branch: readonly SessionEntry[]): CompactionEntry | undefined {
	return branch.findLast((entry): entry is CompactionEntry => entry.type === "compaction");
}

/** The entry's details when they are in the "blocks" format, otherwise undefined. */
export function readBlocksDetails(entry: CompactionEntry): BlocksDetails | undefined {
	// Compaction entries are persisted session data, so their details pass the schema before they are trusted.
	return Value.Check(blocksDetailsSchema, entry.details) ? entry.details : undefined;
}
