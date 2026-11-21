// Maps short model family aliases such as "sol" to the newest model of that family for subagent dispatch.
import type { Api, Model } from "@earendil-works/pi-ai";
import aliases from "./model-aliases.json" with { type: "json" };

type AliasRow = (typeof aliases)[number];

/** Returns the pool model that the first matching alias row names, matching on model ID only. */
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

function findAliasTarget<T extends { id: string }>(
	isRow: (row: AliasRow) => boolean,
	models: readonly T[],
): T | undefined {
	for (const row of aliases) {
		if (!isRow(row)) continue;
		const target = models.find((model) => model.id.toLowerCase() === row.model);
		if (target) return target;
	}
	return undefined;
}
