import {
	type Api,
	type ClassifierApi,
	type ClassifierModel,
	createProvider,
	type FetchFunction,
	type Model,
	type Provider,
	type ProviderResponse,
	type ProviderStreams,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIDecisionsApi } from "@earendil-works/pi-ai/api/openai-decisions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
	type AccountCatalog,
	accountDisplayName,
	accountProviderId,
	BROKER_PLACEHOLDER_URL,
	poolDisplayName,
	poolProviderId,
} from "./catalog.ts";
import { type BrokerClient, type BrokerTarget, fetchBroker } from "./client.ts";

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
	/** Classifier models served through this entry's broker route, for example the Decisions model of an OpenAI API key. */
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
				classifiers: account.classifiers,
			}),
		),
	];
}

/**
 * A Pi provider backed by the account broker. Requests use Pi's own native API adapters, so
 * streaming, tool calls, reasoning and usage parsing are unchanged; only the endpoint and the
 * credential differ. The credential is the broker's per-run token, never a provider secret. Classifier
 * models post to the route's `decisions` path, which the broker forwards to OpenAI's Decisions API.
 */
export function createAccountProvider(
	spec: AccountProviderSpec,
	client: BrokerClient,
	onServedBy?: ServedByListener,
): Provider {
	const report = (response: ProviderResponse) => {
		const key = response.headers[ACCOUNT_HEADER];
		if (key) onServedBy?.(spec.id, key);
	};
	const decisions = openAIDecisionsApi();
	return createProvider({
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
		// A pool may mix APIs (Claude and GPT models), so every adapter is available.
		api: {
			"anthropic-messages": observed(anthropicMessagesApi(), report),
			"openai-responses": observed(openAIResponsesApi(), report),
			"openai-completions": observed(openAICompletionsApi(), report),
		},
		// A classification may be served by another pool account than the chat, so it must not move the footer.
		classifiers: {
			"openai-decisions": {
				classify: (model, context, options) =>
					decisions.classify(model, context, { ...options, fetch: fetchInference }),
			},
		},
	});
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
