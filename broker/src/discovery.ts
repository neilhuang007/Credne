// Live model lists of Claude and ChatGPT subscriptions, read with the account's own sign-in through OMP's discovery.
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import type { ModelSpec } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { fetchCodexModels } from "@oh-my-pi/pi-catalog/discovery/codex";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { anthropicModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Account } from "./accounts.ts";
import { brokerProvider } from "./providers.ts";

/** How long one discovery may take; a model list request waits for it. */
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * The chat models the provider lists for a subscription account's sign-in, or undefined when the account is not a
 * Claude or ChatGPT subscription or the provider gave no list. A model the bundled catalog knows keeps its bundled
 * entry; a newer one is built from the discovered row. Only the OAuth access token is used: OMP's key cascade could
 * fall back to an environment API key, which would list a key's models as the subscription's.
 */
export async function discoverSubscriptionModels(
	account: Account,
	anthropicBaseUrl: string,
): Promise<Model<Api>[] | undefined> {
	if (account.record.kind !== "oauth") return undefined;
	const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const access = await account.storage.oauth.access(account.provider, undefined, { signal });
	if (!access) return undefined;
	let specs: readonly ModelSpec<Api>[] | null | undefined;
	if (account.provider === "openai-codex") {
		const result = await fetchCodexModels({
			accessToken: access.accessToken,
			accountId: access.accountId,
			signal,
			fetchFn: (input, init) => fetch(input, { ...init, redirect: "error" }),
		});
		specs = result?.rejectedStatus === undefined ? result?.models : undefined;
	} else if (account.provider === "anthropic") {
		const rows = await anthropicModelManagerOptions({
			apiKey: access.accessToken,
			baseUrl: anthropicBaseUrl,
			fetch: providerOnly(anthropicBaseUrl, signal),
		}).fetchDynamicModels?.();
		// The model list also names embedding and judge rows; the bundled catalog knows which they are.
		const kinds = new Map(getBundledModels("anthropic").map((model) => [model.id, model.kind]));
		specs = rows?.filter((row) => (row.kind ?? kinds.get(row.id) ?? "chat") === "chat");
	}
	if (!specs?.length) return undefined;
	const bundled = new Map(getBundledModels(account.provider).map((model) => [model.id, model]));
	const discovered = specs.map((spec) => ({ ...(bundled.get(spec.id) ?? buildModel(spec)) }));
	// OMP's model manager drops bundled rows a listing omits only for providers whose listing is authoritative (Codex).
	// Anthropic lists dated IDs such as claude-haiku-4-5-20251001, so its bare IDs, including OMP's Haiku search swap,
	// stay from the bundled list.
	if (providerEntry(account.provider)?.dynamicModelsAuthoritative === true) return discovered;
	const listed = new Set(discovered.map((model) => model.id));
	const kept = (brokerProvider(account.provider)?.models ?? []).filter((model) => !listed.has(model.id));
	return [...discovered, ...kept.map((model) => ({ ...model }))];
}

/** A fetch that sends the sign-in only to the provider; discovery's public reference reads fail and are skipped. */
function providerOnly(baseUrl: string, signal: AbortSignal): FetchImpl {
	const origin = new URL(baseUrl).origin;
	return async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).origin !== origin) throw new Error("Unexpected discovery endpoint.");
		return fetch(request, { redirect: "error", signal: AbortSignal.any([request.signal, signal]) });
	};
}
