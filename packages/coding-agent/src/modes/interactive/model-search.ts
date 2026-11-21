import type { Api, Model } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { USES_BROKER_AUTH } from "../../config.ts";
import { getExactModelSelectionMatches } from "../../core/model-resolver.ts";

/** Rank exact IDs and served aliases above fuzzy search results without dropping ambiguous routes. */
export function filterModelSelection<T>(
	items: T[],
	query: string,
	getModel: (item: T) => Model<Api>,
	getSearchText: (item: T) => string,
): T[] {
	const filtered = fuzzyFilter(items, query, getSearchText);
	if (!USES_BROKER_AUTH) return filtered;
	const matches = new Set(getExactModelSelectionMatches(query, items.map(getModel), "scoped"));
	if (matches.size === 0) return filtered;
	return [
		...items.filter((item) => matches.has(getModel(item))),
		...filtered.filter((item) => !matches.has(getModel(item))),
	];
}

export interface ModelSearchItem {
	id: string;
	provider: string;
	name?: string;
}

export function getModelSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${id} ${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

const splitModelLabel = (value: string): string[] =>
	value
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);

/**
 * Returns the model name when it has words the ID does not, e.g. a renamed override like
 * "MiniMax M3 [rasmus@openrouter, parasail]" for "minimax/minimax-m3". Names that only
 * restate the ID with different casing, separators, or a dropped namespace/version suffix
 * ("Claude Sonnet 4.5 (EU)" for "eu.anthropic.claude-sonnet-4-5-20250929-v1:0") return undefined.
 */
export function getDistinctModelName(item: { id: string; name?: string }): string | undefined {
	const name = item.name?.trim();
	if (!name) return undefined;
	const idWords = splitModelLabel(item.id);
	const idTokens = new Set(idWords);
	const compactId = idWords.join("");
	// Single-character words must match a whole ID token: "4" is not covered by "mistral-small-2603".
	const isCovered = (word: string) => idTokens.has(word) || (word.length > 1 && compactId.includes(word));
	return splitModelLabel(name).every(isCovered) ? undefined : name;
}

/**
 * The /model selector search should rank exact provider-prefixed queries before proxy-provider IDs
 * like openrouter/openai/gpt-5, so keep the bare model ID out of the leading position.
 */
export function getModelSelectorSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}
