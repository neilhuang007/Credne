// Finds the medium tier model of the session model's own family on the account that serves the session model, the
// model the compaction weighs as its compactor, also before a broker pool has named that account.
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { AccountProviderSpec } from "../accounts/provider.ts";
import type { SubagentDispatch } from "../subagent/dispatch.ts";
import { findAliasRowOfModel } from "../subagent/model-aliases.ts";
import { resolveModelTier } from "../subagent/model-tiers.ts";

/**
 * The medium tier model of the `working` model's family on the account that serves it, found among the models subagent
 * dispatch gives for that account. While `working` is a pool whose serving account is not known yet, it is that model
 * of the pool's accounts that the broker tries first for `working`, sent through the pool, when they all have the same
 * one. Undefined when the account, or those accounts, have none, and for a model the tier table files under no family.
 */
export function findMediumTierModel(
	working: Model<Api>,
	dispatch: Pick<SubagentDispatch, "models">,
	ctx: ExtensionContext,
): Model<Api> | undefined {
	// A model's family is the vendor its alias row files it under (`anthropic`, `openai`), the one the tier table's rows
	// name, so a GPT session is never compacted by a Claude model, even where a pool serves both.
	const family = findAliasRowOfModel(working.id)?.provider;
	if (family === undefined) return undefined;
	let models: Model<Api>[];
	try {
		models = dispatch.models(ctx).models;
	} catch {
		// Dispatch learns a pool's serving account only from the account header of the pool's reply to the session model,
		// so it throws until that reply in this process: in a fresh or resumed process, a compaction before the first
		// reply would otherwise find no account.
		return poolMediumTierModel(working, family, ctx);
	}
	return familyMediumTierModel(family, models);
}

/**
 * The medium tier model of `family` that the pool's first choice of accounts for `working` all have, on the pool. The
 * broker sends a request to the pool's enabled accounts that list its model, subscriptions before API keys, so a
 * session's first request goes to one of that first group unless all of them are cooling down.
 */
function poolMediumTierModel(working: Model<Api>, family: string, ctx: ExtensionContext): Model<Api> | undefined {
	const pool: (Provider & Pick<AccountProviderSpec, "poolAccounts">) | undefined = ctx.modelRegistry.getProvider(
		working.provider,
	);
	const serving = (pool?.poolAccounts ?? []).filter((account) =>
		account.models.some((model) => model.id === working.id),
	);
	const subscriptions = serving.filter((account) => account.kind === "oauth");
	const first = subscriptions.length > 0 ? subscriptions : serving;
	const ids = new Set(first.map((account) => familyMediumTierModel(family, account.models)?.id));
	const [id] = ids;
	// Accounts that would pick different models, or none, leave the choice to the pool's first reply.
	if (ids.size !== 1 || id === undefined) return undefined;
	// The pool, not one of those accounts, serves the compaction, so a cooling subscription fails over to another
	// account as the session model's own requests do.
	return ctx.modelRegistry.find(working.provider, id);
}

/** The medium tier model among `models` of `family`; the tier rows of other families find none of them. */
function familyMediumTierModel(family: string, models: readonly Model<Api>[]): Model<Api> | undefined {
	const own = models.filter((model) => findAliasRowOfModel(model.id)?.provider === family);
	return resolveModelTier("medium", own)?.model;
}
