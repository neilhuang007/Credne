// Resolves child model, reasoning and serving account without changing the parent session.
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import {
	ACCOUNT_PROVIDER_PREFIX,
	ALL_POOL,
	accountProviderId,
	POOL_PROVIDER_PREFIX,
	poolProviderId,
	readCatalog,
} from "../accounts/catalog.ts";
import { matchesServingAccount, observeServingAccount } from "../serving-account.ts";
import { resolveModelAlias } from "./model-aliases.ts";
import { type ModelTier, resolveModelTier, type TierSelection } from "./model-tiers.ts";

/** Model override accepted by child dispatch tools. */
export const dispatchModelSchema = Type.Optional(
	Type.String({
		description:
			"Leave unset to use the agent profile and tier-based model selection. Set only when the user requests a specific model; this overrides the default for this call.",
	}),
);

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
	/** The reasoning effort of the profile's `model`; a call's `reasoningEffort` replaces it. */
	effort?: ThinkingLevel;
	tier?: ModelTier;
	/** An effort rated for this task: it replaces the effort of the tier row that selects the model, and nothing else. */
	ratedEffort?: ThinkingLevel;
	decision?: DispatchDecision;
}

export interface DispatchDecision {
	modelId: string;
	outcome: "rated tier" | "rated effort" | "kept default" | "low confidence" | "failed" | "shadow";
}

type ModelSource = {
	method: "explicit" | "explicit tier" | "profile" | "profile tier" | "inherited" | "auto";
	tier?: ModelTier;
};

/** The dispatch decision shown in chat, without the serving provider or account. */
export type ModelChoice = ModelSource & {
	modelId: string;
	decision?: DispatchDecision;
	effort: ThinkingLevel;
	explicitEffort: boolean;
};

export interface DispatchResolution {
	model: string;
	thinkingLevel: ThinkingLevel;
}

export interface SubagentDispatch {
	/** Picks the child model: explicit model, explicit tier, profile model, profile tier, then the parent's model. */
	resolve(selection: DispatchSelection, ctx: ExtensionContext, profile?: ProfileDefaults): DispatchResolution;
	/** Also reports which source supplied the model, for a subagent call's terminal badge. */
	resolveWithChoice(
		selection: DispatchSelection,
		ctx: ExtensionContext,
		profile?: ProfileDefaults,
	): DispatchResolution & { requestedThinkingLevel: ThinkingLevel; modelChoice: ModelChoice };
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
		const query = named ? text.slice(named.provider.length + 1) : text;
		const literal = pool.models.find((candidate) => candidate.id.toLowerCase() === text.toLowerCase());
		// A profile names a model, not an account: when the current account lacks it, a pool that serves it does.
		const found =
			literal ?? findModel(query, pool) ?? (source === "profile" ? findModelOnPools(query, ctx) : undefined);
		if (!found) {
			throw new Error(
				`Unknown subagent model "${query}" on current account or provider ${pool.provider}. Use search_models to find available models. Another account requires an explicit provider/model ID.`,
			);
		}
		return found;
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
	// A tier row also carries the effort of its tier, and a profile model that of its profile; other sources leave the
	// effort to the caller and the parent.
	// A rated effort replaces the row's effort only when the profile's tier selects the model, where the rating applies.
	const pickModel = (
		selection: DispatchSelection,
		ctx: ExtensionContext,
		profile: ProfileDefaults | undefined,
	): { model: Model<Api>; effort?: ThinkingLevel } & ModelSource => {
		if (selection.model !== undefined)
			return { model: modelFromReference(selection.model, ctx, "caller"), method: "explicit" };
		const explicitTier = modelFromTier(selection.tier, ctx);
		if (explicitTier) return { ...explicitTier, method: "explicit tier", tier: selection.tier };
		if (profile?.model !== undefined) {
			return { model: modelFromReference(profile.model, ctx, "profile"), effort: profile.effort, method: "profile" };
		}
		const profileTier = modelFromTier(profile?.tier, ctx);
		if (profileTier) {
			return {
				model: profileTier.model,
				effort: profile?.ratedEffort ?? profileTier.effort,
				method: profile?.decision?.outcome === "rated tier" ? "auto" : "profile tier",
				tier: profile?.tier,
			};
		}
		return { model: inheritedModel(ctx), method: "inherited" };
	};
	const resolveWithChoice: SubagentDispatch["resolveWithChoice"] = (selection, ctx, profile) => {
		const { model, effort, ...source } = pickModel(selection, ctx, profile);
		const requested = selection.reasoningEffort ?? effort ?? ctx.thinkingLevel ?? pi.getThinkingLevel();
		if (selection.reasoningEffort !== undefined && !getSupportedThinkingLevels(model).includes(requested)) {
			throw new Error(`Model ${model.provider}/${model.id} does not support reasoning effort ${requested}.`);
		}
		const thinkingLevel = clampThinkingLevel(model, requested);
		return {
			model: `${model.provider}/${model.id}`,
			thinkingLevel,
			requestedThinkingLevel: requested,
			modelChoice: {
				modelId: model.id,
				decision: profile?.decision,
				effort: thinkingLevel,
				explicitEffort: selection.reasoningEffort !== undefined,
				...source,
			},
		};
	};
	return {
		models,
		resolveWithChoice,
		resolve(selection, ctx, profile) {
			const { model, thinkingLevel } = resolveWithChoice(selection, ctx, profile);
			return { model, thinkingLevel };
		},
	};
}

/** The models of the pool that the text names: an exact ID, an alias, an exact name, or every ID or name containing it. */
function matchModels(text: string, models: Model<Api>[]): Model<Api>[] {
	const query = text.toLowerCase();
	const exact = models.find((model) => model.id.toLowerCase() === query);
	if (exact) return [exact];
	const aliased = resolveModelAlias(query, models);
	if (aliased) return [aliased];
	const names = models.filter((model) => model.name.toLowerCase() === query);
	return names.length
		? names
		: models.filter((model) => query && `${model.id}\n${model.name}`.toLowerCase().includes(query));
}

/** The one model of the pool that the text names: undefined when it names none, an error when it names several. */
function findModel(text: string, pool: { provider: string; models: Model<Api>[] }): Model<Api> | undefined {
	const matches = matchModels(text, pool.models);
	if (matches.length <= 1) return matches[0];
	const candidates = matches.slice(0, 10).map((model) => `${model.provider}/${model.id}`);
	throw new Error(
		`Ambiguous subagent model "${text}": ${candidates.join(", ")}. Use search_models to choose a model ID.`,
	);
}

/** The model a broker pool serves, a family pool such as `pool:claude` before the global pool; undefined when none does. */
function findModelOnPools(text: string, ctx: ExtensionContext): Model<Api> | undefined {
	const available = ctx.modelRegistry.getAvailable();
	const globalPool = poolProviderId(ALL_POOL);
	const providers = [...new Set(available.map((model) => model.provider))]
		.filter((provider) => provider.startsWith(POOL_PROVIDER_PREFIX))
		.sort((a, b) => Number(a === globalPool) - Number(b === globalPool));
	for (const provider of providers) {
		const found = findModel(text, { provider, models: available.filter((model) => model.provider === provider) });
		if (found) return found;
	}
	return undefined;
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
		// The broker tries subscriptions before paid accounts, so a paid account serves a turn only as a fallback. Pinning
		// children to it would keep them on it, and pinned accounts never fail over, so the pool decides for them instead.
		if (account.kind !== "oauth") return parent.provider;
		return accountProviderId(account.id);
	}
	return parent.provider;
}

// The selections a model may send as "" to mean no choice, and the item lists of a call that carry them too.
const selectionFields = ["model", "tier", "reasoningEffort"] as const;
const itemLists = ["tasks", "chain"] as const;

/**
 * Removes a blank `model`, `tier` or `reasoningEffort`, at the top level and in each `tasks` or `chain` item, so a model
 * that fills every optional field with "" leaves those choices to the harness. Runs on raw tool arguments before schema
 * validation, never changes them in place, and returns the input itself when nothing is blank.
 */
export function dropBlankSelections<T>(args: unknown): T {
	// Tool arguments are model output and have not been validated yet, so their shape is checked here.
	if (!isPlainObject(args)) return args as T;
	let result = withoutBlankSelections(args);
	for (const list of itemLists) {
		const items = result[list];
		if (!Array.isArray(items)) continue;
		const cleaned = items.map((item) => (isPlainObject(item) ? withoutBlankSelections(item) : item));
		if (cleaned.some((item, index) => item !== items[index])) result = { ...result, [list]: cleaned };
	}
	// The schema check that follows validates the result, as prepareArguments expects.
	return result as T;
}

function withoutBlankSelections(record: Record<string, unknown>): Record<string, unknown> {
	const blank = selectionFields.filter((field) => {
		const value = record[field];
		return typeof value === "string" && value.trim() === "";
	});
	if (blank.length === 0) return record;
	const result = { ...record };
	for (const field of blank) delete result[field];
	return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
