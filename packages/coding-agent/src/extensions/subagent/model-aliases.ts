// Shared model family aliases such as "sol" for normal selection, subagent dispatch and the /model view.
import type { Api, Model } from "@earendil-works/pi-ai";
import aliases from "./model-aliases.json" with { type: "json" };

/** One alias of a vendor: the row's model names the family the alias selects the latest version of. */
export type ModelAliasRow = (typeof aliases)[number];

interface ParsedModelId {
	/** The non-numeric words of the ID, joined, so `gpt-6.2-astra` and `gpt-6.3-astra` share one family. */
	family: string;
	version: number[];
	isDated: boolean;
}

/** The alias rows in file order. */
export const modelAliasRows: readonly ModelAliasRow[] = aliases;

/** Returns the latest model of the family that the first supported alias row names, matching on model ID only. */
export function resolveModelAlias(alias: string, models: readonly Model<Api>[]): Model<Api> | undefined {
	const query = alias.toLowerCase();
	return findAliasTarget((row) => row.alias === query, models);
}

/**
 * Like resolveModelAlias, but only rows of one provider's family: an alias such as "flash" names a model per provider.
 * Accepts any items with a model ID, such as a broker account's models, and returns the matching item.
 */
export function resolveProviderAlias<T extends { id: string }>(
	provider: string,
	alias: string,
	models: readonly T[],
): T | undefined {
	const query = alias.toLowerCase();
	return findAliasTarget((row) => row.provider === provider && row.alias === query, models);
}

/**
 * Returns the item with the highest version in the family of the row's model: the table lists a family, not a
 * version, so a newer or older served version still resolves. Among equal items, the first one wins.
 */
export function resolveAliasRow<T extends { id: string }>(row: ModelAliasRow, models: readonly T[]): T | undefined {
	const { family } = parseModelId(row.model);
	let best: { item: T; parsed: ParsedModelId } | undefined;
	for (const item of models) {
		const parsed = parseModelId(item.id);
		if (parsed.family !== family) continue;
		if (!best || isNewer(parsed, best.parsed)) best = { item, parsed };
	}
	return best?.item;
}

/** Returns the first alias row, in file order, whose family the model ID belongs to. */
export function findAliasRowOfModel(modelId: string): ModelAliasRow | undefined {
	const { family } = parseModelId(modelId);
	return aliases.find((row) => parseModelId(row.model).family === family);
}

function findAliasTarget<T extends { id: string }>(
	isRow: (row: ModelAliasRow) => boolean,
	models: readonly T[],
): T | undefined {
	for (const row of aliases) {
		if (!isRow(row)) continue;
		const target = resolveAliasRow(row, models);
		if (target) return target;
	}
	return undefined;
}

/**
 * Splits an ID on `-` and `.`: numeric tokens (optionally `v`-prefixed) are version parts, eight-digit tokens are
 * date snapshots, and every other token is a family word, so `gpt-4o` and `o3` keep their tokens as words.
 */
function parseModelId(id: string): ParsedModelId {
	const words: string[] = [];
	const version: number[] = [];
	let isDated = false;
	for (const token of id.toLowerCase().split(/[-.]/)) {
		if (/^\d{8}$/.test(token)) isDated = true;
		else if (/^v?\d+$/.test(token)) version.push(Number(token.replace("v", "")));
		else words.push(token);
	}
	return { family: words.join("-"), version, isDated };
}

/** Whether `candidate` beats `best`: a higher version, or the undated ID of an equal version. */
function isNewer(candidate: ParsedModelId, best: ParsedModelId): boolean {
	const difference = compareVersions(candidate.version, best.version);
	return difference > 0 || (difference === 0 && best.isDated && !candidate.isDated);
}

/** Compares numeric tuples part by part; on a shared prefix the longer tuple is higher. */
function compareVersions(left: readonly number[], right: readonly number[]): number {
	const shared = Math.min(left.length, right.length);
	for (let index = 0; index < shared; index++) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return left.length - right.length;
}
