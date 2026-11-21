// Resolves child model, reasoning and serving account without changing the parent session.
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { ACCOUNT_PROVIDER_PREFIX, accountProviderId, POOL_PROVIDER_PREFIX, readCatalog } from "../accounts/catalog.ts";
import { matchesServingAccount, observeServingAccount } from "../serving-account.ts";
import { resolveModelAlias } from "./model-aliases.ts";
import { type ModelTier, resolveModelTier, type TierSelection } from "./model-tiers.ts";

/** Reasoning levels accepted by child dispatch tools. */
export const reasoningEffortSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

export interface DispatchSelection {
	model?: string;
	tier?: ModelTier;
	reasoningEffort?: ThinkingLevel;
}

/** The defaults an agent profile contributes when the caller does not select a model. */
export interface ProfileDefaults {
	model?: string;
	tier?: ModelTier;
	/** An effort rated for this task: it replaces the effort of the tier row that selects the model, and nothing else. */
	ratedEffort?: ThinkingLevel;
}

export interface DispatchResolution {
	model: string;
	thinkingLevel: ThinkingLevel;
}

export interface SubagentDispatch {
	/** Picks the child model: explicit model, explicit tier, profile model, profile tier, then the parent's model. */
	resolve(selection: DispatchSelection, ctx: ExtensionContext, profile?: ProfileDefaults): DispatchResolution;
	models(ctx: ExtensionContext, provider?: string): { provider: string; models: Model<Api>[] };
}

/** Installs session scoped account observation and resolves child dispatch defaults. */
export function createSubagentDispatch(pi: ExtensionAPI): SubagentDispatch {
	const servingAccount = observeServingAccount(pi);
	const models: SubagentDispatch["models"] = (ctx, provider) => {
		const target = provider && provider !== ctx.model?.provider ? provider : currentProvider(servingAccount, ctx);
		return {
			provider: target,
			models: ctx.modelRegistry.getAvailable().filter((model) => model.provider === target),
		};
	};
	const modelFromReference = (reference: string, ctx: ExtensionContext, source: "caller" | "profile"): Model<Api> => {
		const text = reference.trim();
		// Only a provider explicitly supplied by the caller can opt out of the current account.
		const named = ctx.modelRegistry
			.getAll()
			.filter((candidate) => text.toLowerCase().startsWith(`${candidate.provider.toLowerCase()}/`))
			.sort((a, b) => b.provider.length - a.provider.length)[0];
		const pool = models(ctx, source === "caller" ? named?.provider : undefined);
		const literal = pool.models.find((candidate) => candidate.id.toLowerCase() === text.toLowerCase());
		return literal ?? selectModel(named ? text.slice(named.provider.length + 1) : text, pool);
	};
	// A tier with no row served by the current account selects nothing, so the next source applies.
	const modelFromTier = (tier: ModelTier | undefined, ctx: ExtensionContext): TierSelection | undefined =>
		tier === undefined ? undefined : resolveModelTier(tier, models(ctx).models);
	const inheritedModel = (ctx: ExtensionContext): Model<Api> => {
		if (!ctx.model) throw new Error("A parent model or explicit subagent model is required.");
		const provider = currentProvider(servingAccount, ctx);
		const inherited = ctx.modelRegistry.find(provider, ctx.model.id);
		if (!inherited) throw new Error(`Current account ${provider} cannot serve ${ctx.model.id}. Use search_models.`);
		return inherited;
	};
	// A tier row also carries the effort of its tier; other sources leave the effort to the caller and the parent.
	// A rated effort replaces the row's effort only when the profile's tier selects the model, where the rating applies.
	const pickModel = (
		selection: DispatchSelection,
		ctx: ExtensionContext,
		profile: ProfileDefaults | undefined,
	): { model: Model<Api>; effort?: ThinkingLevel } => {
		if (selection.model !== undefined) return { model: modelFromReference(selection.model, ctx, "caller") };
		const explicitTier = modelFromTier(selection.tier, ctx);
		if (explicitTier) return explicitTier;
		if (profile?.model !== undefined) return { model: modelFromReference(profile.model, ctx, "profile") };
		const profileTier = modelFromTier(profile?.tier, ctx);
		if (profileTier) return { model: profileTier.model, effort: profile?.ratedEffort ?? profileTier.effort };
		return { model: inheritedModel(ctx) };
	};
	return {
		models,
		resolve(selection, ctx, profile) {
			const { model, effort } = pickModel(selection, ctx, profile);
			const requested = selection.reasoningEffort ?? effort ?? ctx.thinkingLevel ?? pi.getThinkingLevel();
			if (selection.reasoningEffort !== undefined && !getSupportedThinkingLevels(model).includes(requested)) {
				throw new Error(`Model ${model.provider}/${model.id} does not support reasoning effort ${requested}.`);
			}
			return { model: `${model.provider}/${model.id}`, thinkingLevel: clampThinkingLevel(model, requested) };
		},
	};
}

function selectModel(text: string, pool: { provider: string; models: Model<Api>[] }): Model<Api> {
	const query = text.toLowerCase();
	const exact = pool.models.find((model) => model.id.toLowerCase() === query);
	if (exact) return exact;
	const aliased = resolveModelAlias(query, pool.models);
	if (aliased) return aliased;
	const names = pool.models.filter((model) => model.name.toLowerCase() === query);
	const matches = names.length
		? names
		: pool.models.filter((model) => query && `${model.id}\n${model.name}`.toLowerCase().includes(query));
	if (matches.length === 1) return matches[0];
	const candidates = matches.slice(0, 10).map((model) => `${model.provider}/${model.id}`);
	throw new Error(
		matches.length
			? `Ambiguous subagent model "${text}": ${candidates.join(", ")}. Use search_models to choose a model ID.`
			: `Unknown subagent model "${text}" on current account or provider ${pool.provider}. Use search_models to find available models. Another account requires an explicit provider/model ID.`,
	);
}

function currentProvider(servingAccount: ReturnType<typeof observeServingAccount>, ctx: ExtensionContext): string {
	const parent = ctx.model;
	if (!parent) throw new Error("A parent model or explicit provider is required. Use search_models with a provider.");
	if (parent.provider.startsWith(ACCOUNT_PROVIDER_PREFIX)) return parent.provider;
	if (parent.provider.startsWith(POOL_PROVIDER_PREFIX)) {
		const serving = servingAccount(ctx);
		const account =
			serving &&
			readCatalog(join(getAgentDir(), "accounts", "catalog.json")).accounts.find(
				(candidate) => matchesServingAccount(candidate, serving) && !candidate.disabled,
			);
		if (!account) {
			throw new Error(
				"The parent pool's serving account is unknown. Wait for a parent response or choose an explicit provider/model ID.",
			);
		}
		return accountProviderId(account.id);
	}
	return parent.provider;
}
