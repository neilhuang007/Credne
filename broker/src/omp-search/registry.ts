// Credne shim, not from oh-my-pi: the slice of OMP's coding-agent ModelRegistry that the vendored search providers
// call, backed by one broker account's AuthStorage. Each member mirrors the OMP method it replaces.
import type { Api, ApiKeyResolver, AuthStorage, Model } from "@oh-my-pi/pi-ai";

/** OMP's thinking selector type from pi-tui; the search providers only pass it through. */
export type ConfiguredThinkingLevel = string;

/** What `searchAnthropic` and `searchCodex` read from OMP's ModelRegistry. */
export interface ModelRegistry {
	readonly authStorage: AuthStorage;
	/** OMP `ModelRegistry.resolver(model, sessionId)`: the provider's key resolver scoped to the model. */
	resolver(model: Model<Api>, sessionId?: string): ApiKeyResolver;
	/** OMP `ModelRegistry.resolveModelHeaders`: the model's configured headers. */
	resolveModelHeaders(model: Model<Api>, signal?: AbortSignal): Promise<Record<string, string> | undefined>;
	/** OMP `ModelRegistry.hasCommandBackedApiKey`; broker accounts never have a command-backed key. */
	hasCommandBackedApiKey(provider: string): boolean;
}

/** The registry OMP's search providers see for one broker account. */
export function accountRegistry(authStorage: AuthStorage): ModelRegistry {
	return {
		authStorage,
		resolver: (model, sessionId) =>
			authStorage.keys.resolver(model.provider, { sessionId, baseUrl: model.baseUrl, modelId: model.id }),
		// Broker models carry no header resolver; OMP's method falls back to the static headers the same way.
		resolveModelHeaders: async (model) => (model.headers ? { ...model.headers } : undefined),
		hasCommandBackedApiKey: () => false,
	};
}
