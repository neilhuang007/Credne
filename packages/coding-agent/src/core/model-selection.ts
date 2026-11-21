import type { Api, Model } from "@earendil-works/pi-ai";
import { USES_BROKER_AUTH } from "../config.ts";
import { ALL_POOL, isBrokerProvider, POOL_PROVIDER_PREFIX, poolProviderId } from "../extensions/accounts/catalog.ts";

export const GLOBAL_BROKER_PROVIDER = poolProviderId(ALL_POOL);

/** Normal choices use the global broker row, or family choices for IDs with no global route. */
export function getModelSelectionChoices(models: readonly Model<Api>[]): readonly Model<Api>[] {
	if (!USES_BROKER_AUTH) return models;
	const globalIds = new Set(
		models.filter((model) => model.provider === GLOBAL_BROKER_PROVIDER).map((model) => model.id.toLowerCase()),
	);
	return models.filter(
		(model) =>
			!isBrokerProvider(model.provider) ||
			model.provider === GLOBAL_BROKER_PROVIDER ||
			(model.provider.startsWith(POOL_PROVIDER_PREFIX) && !globalIds.has(model.id.toLowerCase())),
	);
}

/** Startup and unscoped cycling must not silently choose a family when the global ID is ambiguous. */
export function getAutomaticModelChoices(models: readonly Model<Api>[]): readonly Model<Api>[] {
	return USES_BROKER_AUTH
		? models.filter((model) => !isBrokerProvider(model.provider) || model.provider === GLOBAL_BROKER_PROVIDER)
		: models;
}
