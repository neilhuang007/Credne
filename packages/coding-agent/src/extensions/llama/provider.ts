import {
	type AnyModel,
	type ApiKeyCredential,
	type AuthContext,
	type AuthResult,
	type ClassifierModel,
	isModelType,
	type Model,
	type Provider,
	type ProviderAuth,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { llamaCppClassifyApi } from "@earendil-works/pi-ai/api/llama-cpp-classify.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
import { USES_BROKER_AUTH } from "../../config.ts";
import {
	LlamaClient,
	type LlamaModelInfo,
	type LlamaServerProps,
	LlamaUnreachableError,
	llamaInferenceUrl,
	normalizeLlamaServerUrl,
} from "./client.ts";

export const LLAMA_PROVIDER_ID = "llama.cpp";
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:9931";

function getUnauthenticatedServerUrl(): string | undefined {
	const url = URL.parse(process.env.LLAMA_BASE_URL || DEFAULT_LLAMA_SERVER_URL);
	if (
		!url ||
		url.username ||
		url.password ||
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
	)
		return undefined;
	return normalizeLlamaServerUrl(url.href);
}

function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
	const value = credential?.env?.LLAMA_BASE_URL;
	return typeof value === "string" && value.trim() ? normalizeLlamaServerUrl(value) : undefined;
}

async function resolveServerUrl(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	const configured = credentialServerUrl(credential) ?? (await ctx.env("LLAMA_BASE_URL"))?.trim();
	return configured ? normalizeLlamaServerUrl(configured) : undefined;
}

function modelIsSelectable(model: LlamaModelInfo, routerAutoload: boolean): boolean {
	if (model.status.value === "loaded") return true;
	// llama.cpp reports idle-slept models as "sleeping"; requests wake them automatically.
	if (model.status.value === "sleeping") return true;
	// Unloaded presets are routable only when llama.cpp router autoload can load them on first use.
	return routerAutoload && model.status.value === "unloaded" && !model.status.failed && model.source === "preset";
}

async function routerAutoloadEnabled(
	client: LlamaClient,
	catalog: readonly LlamaModelInfo[],
	signal: AbortSignal,
): Promise<boolean> {
	if (!catalog.some((model) => model.status.value === "unloaded" && model.source === "preset")) return false;
	try {
		return (await client.props({ signal })).models_autoload === true;
	} catch {
		return false;
	}
}

function configuredContextWindow(model: LlamaModelInfo): number | undefined {
	const args = model.status.args ?? [];
	for (let index = 0; index < args.length - 1; index++) {
		const flag = args[index];
		if (flag !== "--ctx-size" && flag !== "-c" && flag !== "-ctx") continue;
		const contextWindow = Number(args[index + 1]);
		if (Number.isSafeInteger(contextWindow) && contextWindow > 0) return contextWindow;
	}
	return undefined;
}

function contextWindowOf(model: LlamaModelInfo, cachedContextWindow?: number): number {
	const runtimeContextWindow = model.meta?.n_ctx;
	if (runtimeContextWindow && runtimeContextWindow > 0) return runtimeContextWindow;
	const configuredContext = configuredContextWindow(model);
	if (configuredContext) return configuredContext;
	if (cachedContextWindow && cachedContextWindow > 0) return cachedContextWindow;
	const trainingContextWindow = model.meta?.n_ctx_train;
	return trainingContextWindow && trainingContextWindow > 0 ? trainingContextWindow : 128000;
}

type LlamaClassifierApi = "llama-cpp-classify" | "typesafe-system-one";

/**
 * Whether llama.cpp reports a native decision model. Since llama.cpp 0.6.0, `GET /models` lists
 * `decisions` in `architecture.output_modalities` for these models, including unloaded and sleeping ones.
 * Older servers report `["text"]` or omit `architecture`, so their models are treated as chat models.
 */
function isDecisionModel(model: LlamaModelInfo): boolean {
	return model.architecture?.output_modalities?.includes("decisions") === true;
}

/** Decision-only models cannot generate text and are not listed for chat. */
function isChatModel(model: LlamaModelInfo): boolean {
	return !isDecisionModel(model) || model.architecture?.output_modalities?.includes("text") === true;
}

/**
 * A llama.cpp model used as a classifier. Decision models answer natively through llama.cpp's
 * System One endpoint (`/v1/systemone`). Chat models fall back to `llama-cpp-classify`, which reads
 * answers from next-token label probabilities.
 */
function toPiClassifierModel(
	model: LlamaModelInfo,
	serverUrl: string,
	cachedContextWindow?: number,
): ClassifierModel<LlamaClassifierApi> {
	const decision = isDecisionModel(model);
	return {
		type: "classifier",
		id: model.id,
		name: model.id,
		api: decision ? "typesafe-system-one" : "llama-cpp-classify",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: decision ? llamaInferenceUrl(serverUrl) : serverUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: contextWindowOf(model, cachedContextWindow),
	};
}

function isLlamaClassifierModel(model: AnyModel): model is ClassifierModel<LlamaClassifierApi> {
	return (
		isModelType(model, "classifier") && (model.api === "llama-cpp-classify" || model.api === "typesafe-system-one")
	);
}

function toPiModel(
	model: LlamaModelInfo,
	serverUrl: string,
	props?: LlamaServerProps,
	cachedContextWindow?: number,
): Model<"openai-completions"> {
	const contextWindow = contextWindowOf(model, cachedContextWindow);
	const reasoning = props?.chat_template?.includes("enable_thinking") === true;
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: llamaInferenceUrl(serverUrl),
		reasoning,
		...(reasoning && {
			thinkingLevelMap: { off: "off", minimal: null, low: null, medium: "medium", high: null, xhigh: null },
		}),
		input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			...(reasoning && { thinkingFormat: "qwen-chat-template" }),
		},
	};
}

export interface LlamaProviderController {
	provider: Provider<"openai-completions">;
	setCatalog(models: readonly LlamaModelInfo[], serverUrl: string, options?: { routerAutoload?: boolean }): void;
}

export function createLlamaProvider(): LlamaProviderController {
	let models: readonly Model<"openai-completions">[] = [];
	let classifiers: readonly ClassifierModel<LlamaClassifierApi>[] = [];
	const chat = openAICompletionsApi();
	const fallbackClassifier = llamaCppClassifyApi();
	const decisionClassifier = typesafeSystemOneApi();
	const localServerUrl = USES_BROKER_AUTH ? getUnauthenticatedServerUrl() : undefined;
	// Without LLAMA_BASE_URL, Credne probes the default port; no server there means no local models, not an error.
	const isImplicitServer = USES_BROKER_AUTH && !process.env.LLAMA_BASE_URL;

	const setCatalog = (
		catalog: readonly LlamaModelInfo[],
		serverUrl: string,
		options: { routerAutoload?: boolean } = {},
	): void => {
		const selectable = catalog.filter((model) => modelIsSelectable(model, options.routerAutoload === true));
		models = selectable.filter(isChatModel).map((model) => toPiModel(model, serverUrl));
		classifiers = selectable.map((model) => toPiClassifierModel(model, serverUrl));
	};

	const provider: Provider<"openai-completions"> = {
		id: LLAMA_PROVIDER_ID,
		name: "llama.cpp",
		baseUrl: llamaInferenceUrl(localServerUrl ?? DEFAULT_LLAMA_SERVER_URL),
		auth: USES_BROKER_AUTH
			? localLlamaAuth(localServerUrl)
			: {
					apiKey: {
						name: "llama.cpp server",
						login: async (interaction): Promise<ApiKeyCredential> => {
							const enteredUrl = await interaction.prompt({
								type: "text",
								message: "llama.cpp server URL",
								placeholder: process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL,
							});
							const serverUrl = normalizeLlamaServerUrl(
								enteredUrl.trim() || process.env.LLAMA_BASE_URL || DEFAULT_LLAMA_SERVER_URL,
							);
							const apiKey = (
								await interaction.prompt({
									type: "secret",
									message: "API key (optional)",
								})
							).trim();
							await new LlamaClient(serverUrl, apiKey || undefined).list({ signal: interaction.signal });
							return {
								type: "api_key",
								key: apiKey || undefined,
								env: { LLAMA_BASE_URL: serverUrl },
							};
						},
						check: async ({ ctx, credential }) => {
							const serverUrl = await resolveServerUrl(ctx, credential);
							return serverUrl
								? { type: "api_key", source: credential ? "stored credential" : "LLAMA_BASE_URL" }
								: undefined;
						},
						resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
							const serverUrl = await resolveServerUrl(ctx, credential);
							if (!serverUrl) return undefined;
							const apiKey = credential?.key ?? (await ctx.env("LLAMA_API_KEY")) ?? "local";
							return {
								auth: { apiKey, baseUrl: llamaInferenceUrl(serverUrl) },
								env: { ...credential?.env, LLAMA_BASE_URL: serverUrl },
								source: credential ? "stored credential" : "LLAMA_BASE_URL",
							};
						},
					},
				},
		getModels: () => models,
		getAllModels: () => [...models, ...classifiers],
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			const cachedContextWindows = new Map<string, number>();
			if (context.stored) {
				const stored = context.stored.models.filter((model) => model.provider === LLAMA_PROVIDER_ID);
				const restored = stored.filter(
					(model): model is Model<"openai-completions"> =>
						isModelType(model, "chat") && model.api === "openai-completions",
				);
				const restoredClassifiers = stored.filter(isLlamaClassifierModel);
				for (const model of [...restored, ...restoredClassifiers]) {
					cachedContextWindows.set(model.id, model.contextWindow);
				}
				if (
					!(await context.publish({
						update: () => {
							models = restored;
							classifiers = restoredClassifiers;
						},
					}))
				) {
					return;
				}
			}

			if (!context.allowNetwork || context.signal.aborted) return;
			const credential = context.credential?.type === "api_key" ? context.credential : undefined;
			const serverUrl = USES_BROKER_AUTH ? localServerUrl : credentialServerUrl(credential);
			if (!serverUrl) return;
			const client = new LlamaClient(serverUrl, USES_BROKER_AUTH ? undefined : credential?.key);
			let catalog: LlamaModelInfo[];
			try {
				catalog = await client.list({ signal: context.signal });
			} catch (error) {
				if (isImplicitServer && error instanceof LlamaUnreachableError) return;
				throw error;
			}
			if (context.signal.aborted) return;
			const routerAutoload = await routerAutoloadEnabled(client, catalog, context.signal);
			if (context.signal.aborted) return;
			const selectable = catalog.filter((model) => modelIsSelectable(model, routerAutoload));
			// Only loaded models expose their chat template without side effects. Unloaded autoload presets would
			// need to be loaded, while querying sleeping models may wake them. Those models remain without thinking
			// support until they are loaded and a later catalog refresh discovers it. Decision models need no
			// template, and llama.cpp reports them in the catalog regardless of their status.
			const refreshed = await Promise.all(
				selectable.filter(isChatModel).map(async (model) => {
					const cachedContextWindow = cachedContextWindows.get(model.id);
					if (model.status.value !== "loaded") return toPiModel(model, serverUrl, undefined, cachedContextWindow);
					const props = await client.props({ model: model.id, signal: context.signal });
					return toPiModel(model, serverUrl, props, cachedContextWindow);
				}),
			);
			const refreshedClassifiers = selectable.map((model) =>
				toPiClassifierModel(model, serverUrl, cachedContextWindows.get(model.id)),
			);
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models: [...refreshed, ...refreshedClassifiers], checkedAt: Date.now() },
				update: () => {
					models = refreshed;
					classifiers = refreshedClassifiers;
				},
			});
		},
		stream: (model, context, options) => chat.stream(model, context, options),
		streamSimple: (model, context, options) => chat.streamSimple(model, context, options),
		classify: (model, context, options) => {
			const classifier = model.api === "typesafe-system-one" ? decisionClassifier : fallbackClassifier;
			return classifier.classify(model, context, USES_BROKER_AUTH ? { ...options, apiKey: undefined } : options);
		},
	};

	return { provider, setCatalog };
}

function localLlamaAuth(serverUrl: string | undefined): ProviderAuth {
	return {
		apiKey: {
			name: "Unauthenticated local llama.cpp server",
			check: async () => (serverUrl ? { type: "api_key", source: "local llama.cpp" } : undefined),
			resolve: async () =>
				serverUrl
					? {
							// The OpenAI adapter requires a nonempty value; remove its Authorization header on the wire.
							auth: { apiKey: "local", headers: { authorization: null }, baseUrl: llamaInferenceUrl(serverUrl) },
							env: { LLAMA_BASE_URL: serverUrl },
							source: "local llama.cpp",
						}
					: undefined,
		},
	};
}
