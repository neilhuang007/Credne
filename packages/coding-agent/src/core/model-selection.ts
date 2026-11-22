import type { Api, Model } from "@earendil-works/pi-ai";
import { USES_BROKER_AUTH } from "../config.ts";
import {
	ACCOUNT_PROVIDER_PREFIX,
	ALL_POOL,
	isBrokerProvider,
	POOL_PROVIDER_PREFIX,
	poolProviderId,
} from "../extensions/accounts/catalog.ts";

export const GLOBAL_BROKER_PROVIDER = poolProviderId(ALL_POOL);

/**
 * Normal choices use the global broker row, or family choices for IDs with no global route. `pinned` is the
 * provider in effect: an account it names replaces the routes for the IDs that account serves.
 */
export function getModelSelectionChoices(models: readonly Model<Api>[], pinned?: string): readonly Model<Api>[] {
	if (!USES_BROKER_AUTH) return models;
	const globalIds = new Set(
		models.filter((model) => model.provider === GLOBAL_BROKER_PROVIDER).map((model) => model.id.toLowerCase()),
	);
	const choices = models.filter(
		(model) =>
			!isBrokerProvider(model.provider) ||
			model.provider === GLOBAL_BROKER_PROVIDER ||
			(model.provider.startsWith(POOL_PROVIDER_PREFIX) && !globalIds.has(model.id.toLowerCase())),
	);
	return withPinnedAccount(models, choices, pinned);
}

/**
 * Startup and unscoped cycling must not silently choose a family when the global ID is ambiguous. `pinned` is
 * the provider in effect: an account it names replaces the global routes for the IDs that account serves.
 */
export function getAutomaticModelChoices(models: readonly Model<Api>[], pinned?: string): readonly Model<Api>[] {
	if (!USES_BROKER_AUTH) return models;
	const choices = models.filter(
		(model) => !isBrokerProvider(model.provider) || model.provider === GLOBAL_BROKER_PROVIDER,
	);
	return withPinnedAccount(models, choices, pinned);
}

/** Rows of the account a session is pinned to: `pinned` names an `acct:` provider that has rows in `models`. */
export function getPinnedAccountModels(models: readonly Model<Api>[], pinned?: string): readonly Model<Api>[] {
	if (!pinned?.startsWith(ACCOUNT_PROVIDER_PREFIX)) return [];
	return models.filter((model) => model.provider === pinned);
}

/** The pinned account's rows replace the broker routes of its IDs. Other choices stay, so a pick can leave the pin. */
function withPinnedAccount(
	models: readonly Model<Api>[],
	choices: readonly Model<Api>[],
	pinned: string | undefined,
): readonly Model<Api>[] {
	const accountModels = getPinnedAccountModels(models, pinned);
	if (accountModels.length === 0) return choices;
	const servedIds = new Set(accountModels.map((model) => model.id.toLowerCase()));
	const others = choices.filter(
		(model) => !isBrokerProvider(model.provider) || !servedIds.has(model.id.toLowerCase()),
	);
	return [...accountModels, ...others];
}
