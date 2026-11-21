import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { BrokerAccount, BrokerAccountKind, BrokerModel } from "./client.ts";

/** Prefix of providers that pin one broker account. */
export const ACCOUNT_PROVIDER_PREFIX = "acct:";
/** Prefix of the providers that serve one local Claude subscription, `claude-sub:<id>`. */
export const LOCAL_CLAUDE_PROVIDER_PREFIX = "claude-sub:";
/** Prefix of providers that let the broker balance requests across accounts. */
export const POOL_PROVIDER_PREFIX = "pool:";
/** Pool over every account of every family; the default for new sessions. */
export const ALL_POOL = "all";
/** Pools that virtual models serve in this process instead of the broker: subscriptions first, then API accounts. */
export const VIRTUAL_POOLS: readonly string[] = [ALL_POOL, "claude"];

/** Whether `providerId` is a physical provider of one local Claude subscription. */
export function isLocalClaudeProvider(providerId: string): boolean {
	return providerId.startsWith(LOCAL_CLAUDE_PROVIDER_PREFIX);
}

/** Pi provider id of a local Claude subscription. */
export function localClaudeProviderId(accountId: string): string {
	return `${LOCAL_CLAUDE_PROVIDER_PREFIX}${accountId}`;
}

/** Whether `providerId` is a virtual pool (`pool:claude`, `pool:all`): its models route to physical accounts in this process. */
export function isVirtualPoolProvider(providerId: string): boolean {
	return (
		providerId.startsWith(POOL_PROVIDER_PREFIX) &&
		VIRTUAL_POOLS.includes(providerId.slice(POOL_PROVIDER_PREFIX.length))
	);
}

/** Whether requests of `providerId` go through the account broker: a pinned broker account or a broker pool. */
export function isBrokerProvider(providerId: string): boolean {
	if (providerId.startsWith(ACCOUNT_PROVIDER_PREFIX)) return true;
	return providerId.startsWith(POOL_PROVIDER_PREFIX) && !isVirtualPoolProvider(providerId);
}

/**
 * Placeholder model base URL. The real route URL contains the broker's per-run port, so provider
 * auth supplies it at request time and it is never persisted.
 */
export const BROKER_PLACEHOLDER_URL = "http://127.0.0.1/credne-broker";

/** A broker account as cached for synchronous provider registration at startup. No secrets. */
export interface CachedAccount {
	id: string;
	key: string;
	provider: string;
	kind: BrokerAccountKind;
	label?: string;
	email?: string;
	plan?: string;
	disabled: boolean;
	models: Model<Api>[];
}

/** A broker pool: every enabled account of its family funds its models. */
export interface CachedPool {
	/** `all` or a model family such as `claude`. */
	name: string;
	accountCount: number;
	models: Model<Api>[];
}

/**
 * Last known accounts and their Pi models. Pi registers one provider per entry from this file
 * before the broker is contacted, so sessions that selected an account or pool restore it on startup.
 */
export interface AccountCatalog {
	version: 2;
	accounts: CachedAccount[];
	pools: CachedPool[];
}

export const EMPTY_CATALOG: AccountCatalog = { version: 2, accounts: [], pools: [] };

/**
 * Claude subscriptions are signed in, stored and refreshed by this process (`claude-sub:*` providers). A broker
 * account of that kind is legacy data that the one-time import moves out of the broker.
 */
export function isBrokerClaudeSubscription(account: { provider: string; kind: BrokerAccountKind }): boolean {
	return account.provider === "claude" && account.kind === "oauth";
}

/** Catalog file contents, or an empty catalog when the file is missing, outdated or unreadable. */
export function readCatalog(path: string): AccountCatalog {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return EMPTY_CATALOG;
	}
	// The file is written by this extension, but may be from another version or hand-edited.
	if (typeof data !== "object" || data === null) return EMPTY_CATALOG;
	const catalog = data as Partial<AccountCatalog>;
	if (catalog.version !== 2 || !Array.isArray(catalog.accounts) || !Array.isArray(catalog.pools)) {
		return EMPTY_CATALOG;
	}
	return {
		version: 2,
		// A catalog written before subscriptions moved out of the broker may still list them and their pools.
		accounts: catalog.accounts.filter(
			(entry) =>
				typeof entry?.id === "string" &&
				typeof entry.key === "string" &&
				Array.isArray(entry.models) &&
				!isBrokerClaudeSubscription(entry),
		),
		pools: catalog.pools.filter(
			(entry) =>
				typeof entry?.name === "string" && Array.isArray(entry.models) && !VIRTUAL_POOLS.includes(entry.name),
		),
	};
}

/** Write the catalog atomically; concurrent harness processes write equivalent broker-derived data. */
export function writeCatalog(path: string, catalog: AccountCatalog): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

/** Pi provider id of a pinned account, e.g. `acct:claude-1a2b3c4d-user@example.com`. */
export function accountProviderId(accountId: string): string {
	return `${ACCOUNT_PROVIDER_PREFIX}${accountId.replace(/\.json$/i, "")}`;
}

export function poolProviderId(name: string): string {
	return `${POOL_PROVIDER_PREFIX}${name}`;
}

/**
 * Model family of a broker provider. Claude subscriptions (`claude`) and official-API accounts
 * (`claude-api`: API credits and API keys) serve the same Claude models.
 */
export function familyOf(provider: string): string {
	if (provider === "openai-api") return "openai";
	return provider === "claude-api" ? "claude" : provider;
}

/** Pi API adapter used for a model family. */
export function apiForFamily(family: string): Api {
	if (family === "claude") return "anthropic-messages";
	if (family === "codex" || family === "openai") return "openai-responses";
	// Other providers go through the daemon's Chat Completions gateway.
	return "openai-completions";
}

/** Pi's built-in providers whose catalog describes the same upstream models. */
const CATALOG_SOURCES: Record<string, readonly string[]> = {
	claude: ["anthropic"],
	codex: ["openai-codex", "openai"],
	openai: ["openai"],
};

export type CatalogLookup = (provider: string, modelId: string) => Model<Api> | undefined;

const KIND_LABELS: Record<BrokerAccountKind, string> = {
	oauth: "subscription",
	"api-key": "API key",
	"api-credits": "API credits",
};

/** Display name of an account in selectors and provider lists. */
export function accountDisplayName(
	account: Pick<CachedAccount, "provider" | "kind" | "email" | "label" | "id" | "plan">,
): string {
	const who = account.email ?? account.label ?? account.id;
	const kind = account.kind === "oauth" ? (account.plan ?? KIND_LABELS.oauth) : KIND_LABELS[account.kind];
	return `${familyTitle(familyOf(account.provider))} · ${who} (${kind})`;
}

export function familyTitle(family: string): string {
	if (family === "claude") return "Claude";
	if (family === "codex") return "ChatGPT Codex";
	if (family === "openai") return "OpenAI API";
	return family.charAt(0).toUpperCase() + family.slice(1);
}

export function poolDisplayName(pool: Pick<CachedPool, "name" | "accountCount">): string {
	const title = pool.name === ALL_POOL ? "All accounts" : familyTitle(pool.name);
	return `${title} pool (${pool.accountCount} ${pool.accountCount === 1 ? "account" : "accounts"})`;
}

/**
 * Build the catalog from broker data, describing models with Pi's catalog metadata where it knows
 * them. Every family with an enabled account gets a broker pool, except the virtual pools (`pool:claude`
 * and `pool:all`), which span these accounts and the local Claude subscriptions. Broker copies of Claude
 * subscriptions are left out.
 */
export function buildCatalog(
	brokerAccounts: readonly BrokerAccount[],
	accountModels: ReadonlyMap<string, readonly BrokerModel[]>,
	lookup: CatalogLookup,
): AccountCatalog {
	const accounts = brokerAccounts.filter((account) => !isBrokerClaudeSubscription(account));
	const cachedAccounts = accounts.map((account): CachedAccount => {
		const providerId = accountProviderId(account.id);
		return {
			id: account.id,
			key: account.key,
			provider: account.provider,
			kind: account.kind,
			label: account.label,
			email: account.email,
			plan: account.plan,
			disabled: account.disabled,
			models: chatModels(account, accountModels, lookup).map((model) =>
				toPiModel(providerId, familyOf(account.provider), model, lookup),
			),
		};
	});

	const enabled = accounts.filter((account) => !account.disabled);
	const families = [...new Set(enabled.map((account) => familyOf(account.provider)))]
		.filter((family) => !VIRTUAL_POOLS.includes(family))
		.sort();
	const poolFor = (name: string, members: readonly BrokerAccount[]): CachedPool => {
		const models = new Map<string, Model<Api>>();
		for (const account of members) {
			for (const model of chatModels(account, accountModels, lookup)) {
				if (!models.has(model.id)) {
					models.set(model.id, toPiModel(poolProviderId(name), familyOf(account.provider), model, lookup));
				}
			}
		}
		return { name, accountCount: members.length, models: [...models.values()] };
	};
	const pools = families.map((family) =>
		poolFor(
			family,
			enabled.filter((account) => familyOf(account.provider) === family),
		),
	);
	return { version: 2, accounts: cachedAccounts, pools };
}

function chatModels(
	account: BrokerAccount,
	accountModels: ReadonlyMap<string, readonly BrokerModel[]>,
	lookup: CatalogLookup,
): readonly BrokerModel[] {
	const models = accountModels.get(account.key) ?? [];
	// OpenAI lists image, audio and embedding models too; only registered chat models belong here.
	return account.provider === "openai-api" ? models.filter((model) => lookup("openai", model.id)) : models;
}

function toPiModel(providerId: string, family: string, model: BrokerModel, lookup: CatalogLookup): Model<Api> {
	const api = apiForFamily(family);
	const known = (CATALOG_SOURCES[family] ?? []).map((source) => lookup(source, model.id)).find(Boolean);
	const input: Model<Api>["input"] =
		known?.input ?? (model.inputModalities?.includes("image") ? ["text", "image"] : ["text"]);
	const piModel: Model<Api> = {
		id: model.id,
		name: known?.name ?? model.displayName ?? model.id,
		api,
		provider: providerId,
		baseUrl: BROKER_PLACEHOLDER_URL,
		reasoning: known?.reasoning ?? model.thinking,
		input,
		cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: known?.contextWindow ?? model.contextLength ?? 128_000,
		maxTokens: known?.maxTokens ?? model.maxCompletionTokens ?? 16_384,
	};
	if (known?.thinkingLevelMap) piModel.thinkingLevelMap = known.thinkingLevelMap;
	if (known?.inputLimits) piModel.inputLimits = known.inputLimits;
	if (known?.promptCache) piModel.promptCache = known.promptCache;
	const compat = brokerCompat(api, known?.compat);
	if (compat) piModel.compat = compat;
	return piModel;
}

/**
 * Compatibility flags for the daemon's protocol gateway. Pi sends a portable request shape; the
 * daemon's provider adapters apply upstream-specific options. Anthropic message threads stay off:
 * their server-side continuation state is bound to one account. Session affinity headers let pools
 * keep a conversation on one account.
 */
function brokerCompat(api: Api, known: Model<Api>["compat"]): Model<Api>["compat"] {
	const source = (known ?? {}) as Record<string, unknown>;
	if (api === "anthropic-messages") {
		const kept = pick(source, ["forceAdaptiveThinking", "supportsStrictTools", "supportsTemperature"]);
		return { ...kept, supportsMessageThreads: false, sendSessionAffinityHeaders: true } as Model<Api>["compat"];
	}
	if (api === "openai-responses") {
		return pick(source, ["supportsMidConvoSystemMessages"]) as Model<Api>["compat"];
	}
	return undefined;
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		if (source[key] !== undefined) result[key] = source[key];
	}
	return result;
}
