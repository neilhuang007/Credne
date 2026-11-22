import {
	type Api,
	type ClassifierApi,
	type ClassifierModel,
	createProvider,
	type FetchFunction,
	type Model,
	type Provider,
	type ProviderClassifier,
	type ProviderResponse,
	type ProviderStreams,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
import {
	type AccountCatalog,
	ALL_POOL,
	accountDisplayName,
	accountProviderId,
	BROKER_PLACEHOLDER_URL,
	type CachedAccount,
	familyOf,
	poolDisplayName,
	poolProviderId,
} from "./catalog.ts";
import { type BrokerClient, type BrokerTarget, fetchBroker } from "./client.ts";
import { OMP_NATIVE_API, type OmpIdentity, type OmpIdentityLookup, ompNativeStreams } from "./omp-native.ts";

/** Response header naming the account that served a request, base64url encoded. */
export const ACCOUNT_HEADER = "x-credne-account";

/** One entry of the account list: a pinned broker account or a broker pool. */
export interface AccountProviderSpec {
	id: string;
	name: string;
	target: BrokerTarget;
	/** Disabled accounts stay registered so sessions that used them fail with a clear reason. */
	disabled: boolean;
	models: Model<Api>[];
	poolAccounts?: readonly CachedAccount[];
	/** oh-my-pi's provider and API for the models of this entry, by model ID. Absent for an ID with none. */
	upstream?: Record<string, OmpIdentity>;
	/** Classifier models served through this entry's broker route, for example the gpt-6-luna model of an OpenAI API key. */
	classifiers?: ClassifierModel<ClassifierApi>[];
}

/** Called with the account key that served a request of a provider. */
export type ServedByListener = (providerId: string, accountKey: string) => void;

/** One spec per cached broker pool and account. */
export function providerSpecs(catalog: AccountCatalog): AccountProviderSpec[] {
	return [
		...catalog.pools.map(
			(pool): AccountProviderSpec => ({
				id: poolProviderId(pool.name),
				name: poolDisplayName(pool),
				target: { type: "pool", name: pool.name },
				disabled: false,
				models: pool.models,
				poolAccounts: catalog.accounts.filter(
					(account) => !account.disabled && (pool.name === ALL_POOL || familyOf(account.provider) === pool.name),
				),
				upstream: pool.upstream,
				classifiers: pool.classifiers,
			}),
		),
		...catalog.accounts.map(
			(account): AccountProviderSpec => ({
				id: accountProviderId(account.id),
				name: accountDisplayName(account),
				target: { type: "account", key: account.key },
				disabled: account.disabled,
				models: account.models,
				upstream: account.upstream,
				classifiers: account.classifiers,
			}),
		),
	];
}

/**
 * A Pi provider backed by the account broker. Chat requests go to the route's `pi/stream` path in
 * oh-my-pi's pi-native protocol, and the broker's oh-my-pi runtime shapes, authenticates and sends them
 * (see `omp-native.ts`). Classifier models post to the route's `systemone` path, System One's wire, which
 * the broker serves for TypeSafe keys and, through oh-my-pi's judgment client, for OpenAI's gpt-6-luna.
 * The credential is the broker's per-run token, never a provider secret. `identify` finds oh-my-pi's provider and
 * API for the models of any account or pool, since a session's earlier turns can come from another one; without
 * it, earlier turns keep Pi's identity and oh-my-pi replays their reasoning as plain text. `refresh` runs in the
 * network phase of a model catalog refresh and re-reads the account list, which re-registers changed providers.
 */
export function createAccountProvider(
	spec: AccountProviderSpec,
	client: BrokerClient,
	onServedBy?: ServedByListener,
	identify: OmpIdentityLookup = () => undefined,
	refresh?: (signal: AbortSignal) => Promise<void>,
): Provider & Pick<AccountProviderSpec, "poolAccounts"> {
	const report = (response: ProviderResponse) => {
		const key = response.headers[ACCOUNT_HEADER];
		if (key) onServedBy?.(spec.id, key);
	};
	const provider = createProvider({
		id: spec.id,
		name: spec.name,
		baseUrl: BROKER_PLACEHOLDER_URL,
		auth: {
			apiKey: {
				name: "Account broker",
				// Side-effect free: availability comes from the catalog, so listing models never starts the broker.
				check: async () => (spec.disabled ? undefined : { type: "api_key", source: "account broker" }),
				resolve: async ({ signal }) => {
					if (spec.disabled) return undefined;
					const connection = await client.connect(signal);
					return {
						auth: { apiKey: connection.token, baseUrl: client.routeBaseUrl(connection, spec.target) },
						source: "account broker",
					};
				},
			},
		},
		models: [...spec.models, ...(spec.classifiers ?? [])],
		// One API for every model: a pool may mix Claude and GPT models, and oh-my-pi speaks each provider's wire.
		api: { [OMP_NATIVE_API]: observed(ompNativeStreams(identify), report) },
		// A classification may be served by another pool account than the chat, so it must not move the footer.
		classifiers: { "typesafe-system-one": viaLoopback(typesafeSystemOneApi()) },
	});
	const accountProvider = { ...provider, poolAccounts: spec.poolAccounts };
	if (!refresh) return accountProvider;
	return {
		...accountProvider,
		// "configured" skips credential resolution, which would start the broker; the catalog check decides.
		refreshModelsAuth: "configured",
		refreshModels: async ({ allowNetwork, signal }) => {
			if (allowNetwork && !signal.aborted) await refresh(signal);
		},
	};
}

/** Reports broker responses before invoking the caller's own response handler. */
function observed(streams: ProviderStreams, report: (response: ProviderResponse) => void): ProviderStreams {
	const withReport = <T extends StreamOptions>(options: T | undefined): T =>
		({
			...options,
			fetch: fetchInference,
			onResponse: (response: ProviderResponse, model: Model<Api>) => {
				report(response);
				return options?.onResponse?.(response, model);
			},
		}) as T;
	return {
		stream: (model, context, options) => streams.stream(model, context, withReport(options)),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, withReport(options)),
	};
}

/** A classifier API whose requests only go to the loopback broker route. */
function viaLoopback(classifier: ProviderClassifier): ProviderClassifier {
	return {
		classify: (model, context, options) => classifier.classify(model, context, { ...options, fetch: fetchInference }),
	};
}

/** Keep the broker token on the loopback route even when proxy or redirect settings would send it elsewhere. */
const fetchInference: FetchFunction = async (input, init) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url.origin) || !url.pathname.startsWith("/credne/v1/route/")) {
		throw new Error("Inference requests must use a loopback account broker route.");
	}
	const response = await fetchBroker(url.href, {
		method: request.method,
		headers: [...request.headers],
		body: request.body,
		duplex: "half",
		signal: request.signal,
	});
	// Undici and the platform use the same Fetch response protocol, with different declared stream types.
	return response as unknown as Awaited<ReturnType<FetchFunction>>;
};
