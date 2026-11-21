// Maps the capability tiers of subagent tasks (light, medium, heavy) to a model and reasoning effort on the current account.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { resolveProviderAlias } from "./model-aliases.ts";
import tiers from "./model-tiers.json" with { type: "json" };

/** Capability tiers accepted by dispatch tools and agent profiles. */
export const modelTierSchema = Type.Union([Type.Literal("light"), Type.Literal("medium"), Type.Literal("heavy")], {
	description:
		"Capability tier for the task. Defaults to the agent's tier; the harness picks the model and reasoning effort.",
});

export type ModelTier = Static<typeof modelTierSchema>;

export interface TierSelection<T extends { id: string } = Model<Api>> {
	model: T;
	effort: ThinkingLevel;
}

/**
 * Returns the first row of the tier, in file order, whose alias resolves in the pool, with that row's effort.
 * Accepts any items with a model ID, such as a broker account's models, and returns the matching item.
 */
export function resolveModelTier<T extends { id: string }>(
	tier: ModelTier,
	models: readonly T[],
): TierSelection<T> | undefined {
	for (const row of tiers) {
		if (row.tier !== tier) continue;
		const model = resolveProviderAlias(row.provider, row.alias, models);
		// The JSON import widens effort to string; a test checks every row against the effort schema.
		if (model) return { model, effort: row.effort as ThinkingLevel };
	}
	return undefined;
}
