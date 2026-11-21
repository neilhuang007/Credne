// Tracks the broker account that served the selected pool model, when the evidence names one.
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { accountProviderId, POOL_PROVIDER_PREFIX } from "./accounts/catalog.ts";
import { ACCOUNT_HEADER } from "./accounts/provider.ts";
import { isAccountProvider } from "./accounts/served.ts";

/** The broker key observed on the response, or the pinned provider ID recorded in an older transcript. */
export type ServingAccount = { type: "key"; key: string } | { type: "provider"; provider: string };

/** Observes successful pool responses and returns their account, or a historical account recorded by a virtual pool. */
export function observeServingAccount(pi: ExtensionAPI): (ctx: ExtensionContext) => ServingAccount | undefined {
	let scope: string | undefined;
	let pendingScope: string | undefined;
	let accountKey: string | undefined;
	let responseAccountKey: string | undefined;
	let isAmbiguous = false;
	const clear = () => {
		scope = undefined;
		pendingScope = undefined;
		accountKey = undefined;
		responseAccountKey = undefined;
		isAmbiguous = false;
	};
	pi.on("session_start", clear);
	pi.on("session_before_switch", clear);
	pi.on("session_before_fork", clear);
	pi.on("session_before_tree", clear);
	pi.on("session_shutdown", clear);
	pi.on("model_select", clear);
	pi.on("agent_end", () => {
		pendingScope = undefined;
		isAmbiguous = false;
	});
	pi.on("before_provider_request", (_event, ctx) => {
		const nextScope = poolScope(ctx);
		if (scope !== nextScope) clear();
		if (!nextScope) return;
		// The response hook has no request ID. Overlapping requests cannot establish affinity.
		isAmbiguous ||= pendingScope !== undefined;
		scope = nextScope;
		pendingScope = nextScope;
		accountKey = undefined;
		responseAccountKey = undefined;
	});
	pi.on("after_provider_response", (event, ctx) => {
		if (pendingScope === undefined || pendingScope !== poolScope(ctx) || isAmbiguous) return;
		responseAccountKey = event.status >= 200 && event.status < 300 ? event.headers[ACCOUNT_HEADER] : undefined;
		pendingScope = undefined;
	});
	pi.on("provider_stream_event", (event, ctx) => {
		if (scope === undefined || scope !== poolScope(ctx)) return;
		if (event.provider !== ctx.model?.provider || event.model !== ctx.model.id || isAmbiguous) {
			accountKey = undefined;
			responseAccountKey = undefined;
			return;
		}
		accountKey = responseAccountKey;
	});
	return (ctx) => {
		const currentScope = poolScope(ctx);
		if (!currentScope) return undefined;
		if (scope === currentScope) return accountKey ? { type: "key", key: accountKey } : undefined;
		const provider = historicalServingProvider(ctx);
		return provider ? { type: "provider", provider } : undefined;
	};
}

/** Check serving-account evidence against a currently available broker account. */
export function matchesServingAccount(account: { id: string; key: string }, serving: ServingAccount): boolean {
	return serving.type === "key" ? account.key === serving.key : accountProviderId(account.id) === serving.provider;
}

function poolScope(ctx: ExtensionContext): string | undefined {
	const model = ctx.model;
	if (!model?.provider.startsWith(POOL_PROVIDER_PREFIX)) return undefined;
	return JSON.stringify([ctx.sessionManager.getSessionId(), model.provider, model.id]);
}

function historicalServingProvider(ctx: ExtensionContext): string | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	const branch = ctx.sessionManager.getBranch();
	let account: string | undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "model_change") {
			// An old virtual pool wrote the selected pool in model_change and the physical account on the answer.
			return entry.provider === model.provider && entry.modelId === model.id ? account : undefined;
		}
		if (account || entry.type !== "message" || entry.message.role !== "assistant") continue;
		const { stopReason, model: modelId, provider } = entry.message;
		if (stopReason === "error" || stopReason === "aborted") continue;
		// A modern `pool:*` response, native response, or an older model gives no usable account identity.
		if (modelId !== model.id || !isAccountProvider(provider)) return undefined;
		account = provider;
	}
	return undefined;
}
