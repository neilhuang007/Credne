// Intersects OMP's provider/auth catalog with the transports and login controls hosted by Credne.
import {
	type Api,
	type FetchImpl,
	getOAuthProviders,
	getProviderDefinition,
	type Model,
	type ProviderDefinition,
	providerPauseReason,
} from "@oh-my-pi/pi-ai";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import type { CompiledAuthProvider } from "@oh-my-pi/pi-catalog/compat/types";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { PROVIDER_DESCRIPTORS, type ProviderDescriptor } from "@oh-my-pi/pi-catalog/provider-models";

export type AuthMethod = "api-key" | "oauth";
type KeyEnrollment =
	// Anthropic and OpenAI keys are checked, and their models listed, through the catalog descriptor.
	| { kind: "legacy"; descriptor: ProviderDescriptor }
	// TypeSafe lists its Jev models as classifiers; its key is checked by listing them.
	| { kind: "classifier" }
	| {
			kind: "upstream";
			login: NonNullable<ProviderDefinition["login"]>;
			origin: string;
	  }
	| { kind: "catalog"; descriptor: ProviderDescriptor };

interface Provider {
	id: string;
	name: string;
	models: Model<Api>[];
	key?: KeyEnrollment;
	oauth?: { flow: "browser" | "device"; name: string };
}

const CHAT_APIS = new Set<Api>([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"google-generative-ai",
	"openrouter",
	"ollama-chat",
]);

// These providers use ordinary HTTP APIs in some rows but require host-owned credential/endpoint controls.
const HOST_CONTROLS = new Set([
	"gitlab-duo", // Enterprise instance and GitLab proxy credential exchange.
	"github-copilot", // GitHub token exchange, account tier and enterprise routing.
	"google-vertex", // Google application default credentials and project/location.
	"bedrock-mantle", // AWS credential chain and region selection.
	"alibaba-coding-plan", // Credential-dependent endpoint selection.
	"alibaba-token-plan", // Credential-dependent endpoint selection.
]);

/** Returns the OMP providers for which this broker can enroll an explicit account. */
export function publicProviders(): { id: string; name: string; authMethods: AuthMethod[] }[] {
	return [...providers.values()].flatMap(({ id, name, key, oauth }) => {
		if (providerPauseReason(id)) return [];
		const authMethods: AuthMethod[] = [];
		if (key) authMethods.push("api-key");
		if (oauth) authMethods.push("oauth");
		return authMethods.length ? [{ id, name, authMethods }] : [];
	});
}

/** Looks up a supported provider without resolving or reading its environment credentials. */
export function brokerProvider(id: string): Provider | undefined {
	return providerPauseReason(id) ? undefined : providers.get(id);
}

/** Gives a safe explanation without quoting an untrusted provider string or upstream error. */
export function unsupportedEnrollment(id: string, method: AuthMethod): string {
	const policy = authPolicyFor(id);
	if (policy?.disabled) return "This provider is disabled by the OMP auth catalog.";
	if (policy?.id === id || providerEntry(id)?.id === id)
		return method === "oauth"
			? "This OMP sign-in is not supported by the broker. It may require provider-specific prompts, a native browser or CLI, or enterprise account controls."
			: "This OMP provider does not support verified API-key enrollment for chat in the broker.";
	return "Unknown OMP provider.";
}

/** Resolves a management provider ID; persisted legacy account kinds keep their existing IDs. */
export function accountProvider(
	id: string | undefined,
	kind: AuthMethod,
): { native: string; family: string; record: string } {
	switch (id) {
		case "":
		case undefined:
		case "anthropic":
		case "claude":
		case "claude-api":
			return { native: "anthropic", family: "claude", record: kind === "oauth" ? "claude" : "claude-api" };
		case "codex":
		case "openai-codex":
			return { native: kind === "oauth" ? "openai-codex" : "openai", family: "codex", record: "codex" };
		case "openai":
		case "openai-api":
			return { native: "openai", family: "openai", record: "openai-api" };
		default:
			return { native: id, family: id, record: id };
	}
}

/** Checks a key using OMP's login validator or its authenticated model-list descriptor. */
export async function validateProviderKey(
	provider: Provider,
	enrollment: Exclude<KeyEnrollment, { kind: "legacy" | "classifier" }>,
	key: string,
	signal: AbortSignal,
): Promise<{ key: string; ids?: string[] }> {
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
	if (enrollment.kind === "upstream") {
		let accepted = false;
		const result = await enrollment.login({
			onPrompt: async () => key,
			signal: deadline,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				if (new URL(request.url).origin !== enrollment.origin) throw new Error("Unexpected validation endpoint.");
				const response = await fetch(request, {
					redirect: "error",
					signal: AbortSignal.any([request.signal, deadline]),
				});
				accepted ||= response.ok;
				return response;
			},
		});
		// Some CLI probes are optional; the broker does not report an unverified key as enrolled.
		if (!accepted || typeof result !== "string" || !result) throw new Error("Key was not verified.");
		return { key: result };
	}

	const origins = new Set(provider.models.map((model) => new URL(model.baseUrl).origin));
	let accepted = false;
	const fetchCatalog: FetchImpl = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (!origins.has(url.origin)) throw new Error("Unexpected discovery endpoint.");
		// The descriptor owns auth placement (e.g. Google's discovery uses the query string).
		const credentials = [
			[request.headers.get("authorization"), `Bearer ${key}`],
			[request.headers.get("x-api-key"), key],
			[request.headers.get("x-goog-api-key"), key],
			[url.searchParams.get("key"), key],
		].filter(([actual]) => actual !== null);
		if (
			!credentials.length ||
			credentials.some(([actual, expected]) => actual !== expected) ||
			request.headers.has("cookie")
		)
			throw new Error("Discovery did not use the supplied key.");
		const response = await fetch(request, { redirect: "error", signal: AbortSignal.any([request.signal, deadline]) });
		accepted ||= response.ok;
		return response;
	};
	const rows = await enrollment.descriptor
		.createModelManagerOptions({ apiKey: key, fetch: fetchCatalog })
		.fetchDynamicModels?.();
	const reported = new Set(
		rows?.filter((row) => (!row.kind || row.kind === "chat") && CHAT_APIS.has(row.api)).map((row) => row.id),
	);
	const ids = provider.models.filter((model) => reported.has(model.id)).map((model) => model.id);
	if (!accepted || !ids.length) throw new Error("No verified catalog chat models.");
	return { key, ids };
}

function officialOrigin(value: string): string | undefined {
	if (/[{}<>]/.test(value)) return;
	try {
		const url = new URL(value);
		if (url.protocol === "https:" && !url.username && !url.password && !url.hostname.endsWith(".invalid"))
			return url.origin;
	} catch {
		// The OMP catalog also contains empty URLs and non-hosted inference adapters.
	}
}

function buildProviders(): Map<string, Provider> {
	const oauth = new Map(
		getOAuthProviders()
			.filter((provider) => provider.available)
			.map((provider) => [provider.id, provider]),
	);
	const descriptors = new Map(PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.providerId, descriptor]));
	const providers = new Map<string, Provider>();
	for (const id of getBundledProviders()) {
		const policy = authPolicyFor(id);
		const definition = getProviderDefinition(id);
		if (
			!policy ||
			!definition ||
			policy.disabled ||
			policy.available === false ||
			policy.allowsMissingApiKey ||
			policy.nativeAuthApis?.length ||
			policy.apiKeyFormat !== "bearer" ||
			HOST_CONTROLS.has(id)
		)
			continue;
		const models = getBundledModels(id).filter(
			(model) => (!model.kind || model.kind === "chat") && CHAT_APIS.has(model.api) && officialOrigin(model.baseUrl),
		);
		if (!models.length) continue;
		const provider: Provider = { id, name: id === "anthropic" ? "Anthropic" : policy.name, models };
		const info = oauth.get(id);
		const flow = info && definition.login && oauthFlow(policy);
		if (flow) provider.oauth = { flow, name: info.name };
		provider.key = keyEnrollment(policy, definition, descriptors.get(id), provider.oauth);
		if (provider.key || provider.oauth) providers.set(id, provider);
	}
	// OMP lists TypeSafe's Jev models as `kind: "judge"`, which the chat filter above rightly drops.
	providers.set("typesafe", {
		id: "typesafe",
		name: "TypeSafe",
		models: getBundledModels("typesafe"),
		key: { kind: "classifier" },
	});
	return providers;
}

function oauthFlow(policy: CompiledAuthProvider): "browser" | "device" | undefined {
	const login = policy.login;
	if (policy.storeAs || policy.result) return;
	if (login?.kind === "oauth-code") {
		// The management callback accepts a complete, state-bound loopback redirect only.
		const { callback } = login;
		if (
			login.pkce &&
			login.state !== "none" &&
			login.standardAuthorizeParams &&
			!login.pasteKey &&
			!callback.nativeScheme &&
			!callback.manualOnly &&
			!callback.redirectUri?.env?.length &&
			["localhost", "127.0.0.1"].includes(callback.hostname)
		)
			return "browser";
	}
	if (login?.kind === "device-code" && (login.credential.accountId || login.credential.email)) {
		// No hidden follow-up prompts, ambient device fingerprint, or externally configured auth host.
		if (!login.afterExchange && !login.headersHook && !login.baseUrl?.env?.length) return "device";
	}
}

function keyEnrollment(
	policy: CompiledAuthProvider,
	definition: ProviderDefinition,
	descriptor?: ProviderDescriptor,
	oauth?: Provider["oauth"],
): KeyEnrollment | undefined {
	const { id, login } = policy;
	if (id === "anthropic" || id === "openai") return descriptor && { kind: "legacy", descriptor };
	if (policy.loginWarning) return;
	const validation = login?.kind === "api-key" ? login.validate : undefined;
	if (validation && definition.login) {
		// Never send a managed key to an env-configured host or a validator that needs extra credentials.
		const url = validation.kind === "models-endpoint" ? validation.url : validation.baseUrl;
		const origin = officialOrigin(url);
		if (origin && (validation.kind !== "models-endpoint" || !validation.headersHook))
			return { kind: "upstream", login: definition.login, origin };
		return;
	}
	if (login?.kind !== "api-key" && (!providerEntry(id)?.envVars?.length || oauth)) return;
	// Probe only providers with a catalog-owned authenticated fetch path; no default /models guess.
	if (
		descriptor &&
		!descriptor.allowUnauthenticated &&
		descriptor.createModelManagerOptions({ apiKey: "catalog-probe" }).fetchDynamicModels
	)
		return { kind: "catalog", descriptor };
}

const providers = buildProviders();
