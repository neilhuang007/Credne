import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
	Api,
	ClassifierApi,
	ClassifierModel,
	Model,
	ModelThinkingLevel,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { BrokerAccount, BrokerAccountKind, BrokerModel } from "./client.ts";
import { OMP_NATIVE_API, type OmpIdentity } from "./omp-native.ts";

/** Prefix of providers that pin one broker account. */
export const ACCOUNT_PROVIDER_PREFIX = "acct:";
/** Prefix of providers that let the broker balance requests across accounts. */
export const POOL_PROVIDER_PREFIX = "pool:";
/** Pool over every enabled account across all model families. */
export const ALL_POOL = "all";
/** Whether `providerId` names the retired in-process Claude subscription provider. */
export function isLocalClaudeProvider(providerId: string): boolean {
	return providerId.toLowerCase().startsWith("claude-sub:");
}

/** Whether requests of `providerId` go through the account broker: a pinned account or a pool. */
export function isBrokerProvider(providerId: string): boolean {
	return providerId.startsWith(ACCOUNT_PROVIDER_PREFIX) || providerId.startsWith(POOL_PROVIDER_PREFIX);
}

/**
 * Placeholder model base URL. The real route URL contains the broker's per-run port, so provider
 * auth supplies it at request time and it is never persisted.
 */
export const BROKER_PLACEHOLDER_URL = "http://127.0.0.1/credne-broker";

/** Broker provider key of OpenAI API keys. ChatGPT subscriptions are `codex`. */
const OPENAI_API_PROVIDER = "openai-api";
/** Broker provider key of TypeSafe (Jev) API keys. */
export const TYPESAFE_PROVIDER = "typesafe";
/** The only classifier of an OpenAI API key: the model of OpenAI's Decisions API. */
const LUNA_MODEL_ID = "gpt-6-luna";
/** The API of every account classifier: the broker's `systemone` route speaks TypeSafe's System One wire. */
const SYSTEM_ONE_API = "typesafe-system-one";

/** Which broker models of an API-key provider are classifiers, and the Pi catalog entry that describes them. */
interface ClassifierSource {
	/** Pi's built-in provider and model whose entry the classifiers copy for cost, limits and input. */
	catalogProvider: string;
	catalogModelId: string;
	/** The API of that entry, which is not the route's: luna's entry is Decisions. An entry with another API is not used. */
	catalogApi: ClassifierApi;
	serves(model: BrokerModel): boolean;
}

const CLASSIFIER_SOURCES = new Map<string, ClassifierSource>([
	[
		OPENAI_API_PROVIDER,
		{
			catalogProvider: "openai",
			catalogModelId: LUNA_MODEL_ID,
			catalogApi: "openai-decisions",
			serves: (model) => model.id === LUNA_MODEL_ID,
		},
	],
	[
		TYPESAFE_PROVIDER,
		{
			catalogProvider: "typesafe",
			catalogModelId: "jev-latest",
			catalogApi: SYSTEM_ONE_API,
			serves: (model) => model.kind === "classifier",
		},
	],
]);

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
	/** oh-my-pi's provider and API for each model ID the broker reported them for. */
	upstream?: Record<string, OmpIdentity>;
	/** Classifier models the broker serves for this account: gpt-6-luna of an OpenAI API key, the Jev models of a TypeSafe key. */
	classifiers?: ClassifierModel<ClassifierApi>[];
}

/** A broker pool: every enabled account of its family funds its models. */
export interface CachedPool {
	/** `all` or a model family such as `claude`. */
	name: string;
	accountCount: number;
	models: Model<Api>[];
	/**
	 * oh-my-pi's provider and API for each model ID whose serving accounts all share one. An ID that different
	 * accounts serve through different providers, such as a GPT model on a ChatGPT subscription and an OpenAI key,
	 * has none: the pool does not know which one answers.
	 */
	upstream?: Record<string, OmpIdentity>;
	/** Classifier models the broker serves for this pool: `pool:openai` offers gpt-6-luna, `pool:typesafe` the Jev models. */
	classifiers?: ClassifierModel<ClassifierApi>[];
}

/**
 * Last known accounts and their Pi models. Pi registers one provider per entry from this file
 * before the broker is contacted, so sessions that selected an account or pool restore it on startup.
 * Version 3 stores chat models on the `omp-native` API; older files name APIs the providers no longer serve.
 */
export interface AccountCatalog {
	version: 3;
	accounts: CachedAccount[];
	pools: CachedPool[];
}

export const EMPTY_CATALOG: AccountCatalog = { version: 3, accounts: [], pools: [] };

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
	if (catalog.version !== 3 || !Array.isArray(catalog.accounts) || !Array.isArray(catalog.pools)) {
		return EMPTY_CATALOG;
	}
	const accounts = catalog.accounts
		.filter(
			(entry) =>
				typeof entry?.id === "string" &&
				typeof entry.key === "string" &&
				typeof entry.provider === "string" &&
				Array.isArray(entry.models) &&
				entry.kind !== "api-credits",
		)
		.map((entry) => ({
			...entry,
			upstream: readUpstream(entry.upstream),
			classifiers: readClassifiers(entry.classifiers),
		}));
	// Older catalogs omitted pool:all and pool:claude when they were served locally.
	return { version: 3, accounts, pools: buildPools(accounts) };
}

/** The identities of a catalog file entry that are well formed. Files from before the broker reported them have none. */
function readUpstream(value: unknown): Record<string, OmpIdentity> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const entries = Object.entries(value).flatMap(([modelId, identity]: [string, Partial<OmpIdentity> | null]) =>
		typeof identity?.provider === "string" && typeof identity.api === "string"
			? [[modelId, { provider: identity.provider, api: identity.api }] as const]
			: [],
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The identity of `modelId` in an `upstream` table. Model IDs come from the broker, so inherited keys do not count. */
export function upstreamIdentity(
	upstream: Readonly<Record<string, OmpIdentity>> | undefined,
	modelId: string,
): OmpIdentity | undefined {
	return upstream && Object.hasOwn(upstream, modelId) ? upstream[modelId] : undefined;
}

/** The classifier models of a catalog file entry that this version serves. Entries of other APIs, such as Decisions, are dropped. */
function readClassifiers(value: unknown): ClassifierModel<ClassifierApi>[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter(
		(entry): entry is ClassifierModel<ClassifierApi> =>
			entry?.type === "classifier" && entry.api === SYSTEM_ONE_API && typeof entry.id === "string",
	);
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
 * Model family of a broker provider. Claude subscriptions (`claude`) and API keys (`claude-api`)
 * serve the same Claude models.
 */
export function familyOf(provider: string): string {
	if (provider === OPENAI_API_PROVIDER) return "openai";
	if (provider === "claude-api" || provider === "anthropic") return "claude";
	return provider === "openai-codex" ? "codex" : provider;
}

/** Families whose same-id models can share one route in the global pool. */
export function sharedRouteFamily(family: string): string {
	if (family === "codex") return "openai";
	return family === "xai-oauth" ? "xai" : family;
}

/** Pi's built-in providers whose catalog describes the same upstream models. */
const CATALOG_SOURCES = new Map<string, readonly string[]>([
	["claude", ["anthropic"]],
	["codex", ["openai-codex", "openai"]],
	["xai-oauth", ["xai-oauth", "xai"]],
]);

export type CatalogLookup = (provider: string, modelId: string) => Model<Api> | undefined;

/** Finds a classifier model of Pi's catalog. */
export type ClassifierLookup = (provider: string, modelId: string) => ClassifierModel<ClassifierApi> | undefined;

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
	if (family === TYPESAFE_PROVIDER) return "TypeSafe";
	return family.charAt(0).toUpperCase() + family.slice(1);
}

export function poolDisplayName(pool: Pick<CachedPool, "name" | "accountCount">): string {
	const title = pool.name === ALL_POOL ? "All accounts" : familyTitle(pool.name);
	return `${title} pool (${pool.accountCount} ${pool.accountCount === 1 ? "account" : "accounts"})`;
}

/**
 * Build the catalog from broker data, using Pi's model metadata where available. Each family with
 * an enabled account gets a broker pool, as does the union of all families. OpenAI API keys offer the
 * gpt-6-luna classifier if the key lists it, and TypeSafe keys offer their Jev classifiers instead of
 * chat models. Each family pool offers the classifiers of its accounts.
 */
export function buildCatalog(
	brokerAccounts: readonly BrokerAccount[],
	accountModels: ReadonlyMap<string, readonly BrokerModel[]>,
	lookup: CatalogLookup,
	lookupClassifier?: ClassifierLookup,
): AccountCatalog {
	const accounts = brokerAccounts.filter((account) => account.kind !== "api-credits");
	const cachedAccounts = accounts.map((account): CachedAccount => {
		const providerId = accountProviderId(account.id);
		const served = chatModels(account, accountModels, lookup);
		return {
			id: account.id,
			key: account.key,
			provider: account.provider,
			kind: account.kind,
			label: account.label,
			email: account.email,
			plan: account.plan,
			disabled: account.disabled,
			models: served.map((model) => toPiModel(providerId, familyOf(account.provider), model, lookup)),
			upstream: accountUpstream(served),
			classifiers: accountClassifiers(providerId, account, accountModels, lookupClassifier),
		};
	});

	return { version: 3, accounts: cachedAccounts, pools: buildPools(cachedAccounts) };
}

function buildPools(accounts: readonly CachedAccount[]): CachedPool[] {
	const enabled = accounts.filter((account) => !account.disabled);
	if (enabled.length === 0) return [];
	const families = [...new Set(enabled.map((account) => familyOf(account.provider)))].sort();
	return [ALL_POOL, ...families].map((name) => {
		const members = name === ALL_POOL ? enabled : enabled.filter((account) => familyOf(account.provider) === name);
		const provider = poolProviderId(name);
		// The broker's classifier routes are restricted to pinned API keys and their family pool, never pool:all.
		const classifiers = name === ALL_POOL ? undefined : members.find((account) => account.classifiers)?.classifiers;
		const models = poolModels(provider, members);
		return {
			name,
			accountCount: members.length,
			models,
			upstream: poolUpstream(members, models),
			classifiers: classifiers?.map((model) => ({ ...model, provider })),
		};
	});
}

/** The identities the broker reported for the models of an account. A model it reported none for has no entry. */
function accountUpstream(models: readonly BrokerModel[]): Record<string, OmpIdentity> | undefined {
	const entries = models.flatMap((model) =>
		model.provider !== undefined && model.api !== undefined
			? [[model.id, { provider: model.provider, api: model.api }] as const]
			: [],
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The identity of each pool model that every account serving it reports, and reports the same. */
function poolUpstream(
	members: readonly CachedAccount[],
	models: readonly Model<Api>[],
): Record<string, OmpIdentity> | undefined {
	const entries = models.flatMap(({ id }) => {
		const identities = members
			.filter((account) => account.models.some((model) => model.id === id))
			.map((account) => upstreamIdentity(account.upstream, id));
		const [first] = identities;
		const isShared = identities.every(
			(identity) => identity?.provider === first?.provider && identity?.api === first?.api,
		);
		return first && isShared ? [[id, first] as const] : [];
	});
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function poolModels(provider: string, members: readonly CachedAccount[]): Model<Api>[] {
	const byId = new Map<string, { family: string; models: [Model<Api>, ...Model<Api>[]] } | undefined>();
	for (const account of members) {
		const family = sharedRouteFamily(familyOf(account.provider));
		for (const model of account.models) {
			const existing = byId.get(model.id);
			if (existing) {
				if (existing.family === family && existing.models[0].api === model.api) existing.models.push(model);
				else byId.set(model.id, undefined);
			} else if (!byId.has(model.id)) {
				byId.set(model.id, { family, models: [model] });
			}
		}
	}
	// One bare ID can only address one identity over this route. Ambiguous IDs remain in their family pools.
	return [...byId.values()].flatMap((entry) =>
		entry ? [mergePoolModel(provider, entry.models[0], entry.models)] : [],
	);
}

function mergePoolModel(provider: string, first: Model<Api>, models: readonly Model<Api>[]): Model<Api> {
	if (models.length === 1) return { ...first, provider };
	// Failover can use any member. Advertise only the limits and capabilities shared by the route.
	return {
		...first,
		provider,
		contextWindow: Math.min(...models.map((model) => model.contextWindow)),
		maxTokens: Math.min(...models.map((model) => model.maxTokens)),
		input: first.input.filter((input) => models.every((model) => model.input.includes(input))),
		reasoning: models.every((model) => model.reasoning),
		thinkingLevelMap: sharedThinkingLevelMap(first, models),
	};
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function sharedThinkingLevelMap(first: Model<Api>, models: readonly Model<Api>[]): ThinkingLevelMap | undefined {
	let result: ThinkingLevelMap | undefined;
	for (const level of THINKING_LEVELS) {
		const firstValue = first.thinkingLevelMap?.[level];
		const value = models.every((model) => model.thinkingLevelMap?.[level] === firstValue) ? firstValue : null;
		if (value === undefined) continue;
		result ??= {};
		result[level] = value;
	}
	return result;
}

function chatModels(
	account: BrokerAccount,
	accountModels: ReadonlyMap<string, readonly BrokerModel[]>,
	lookup: CatalogLookup,
): readonly BrokerModel[] {
	const models = (accountModels.get(account.key) ?? []).filter((model) => model.kind !== "classifier");
	// OpenAI lists image, audio and embedding IDs too. Either catalog can positively identify a chat model.
	return account.provider === OPENAI_API_PROVIDER
		? models.filter((model) => model.kind === "chat" || lookup("openai", model.id))
		: models;
}

/**
 * The classifiers of a pinned API-key account: gpt-6-luna of an OpenAI key that lists it, or the Jev
 * models of a TypeSafe key. Only API keys qualify; OpenAI's Decisions API, which serves luna, rejects
 * ChatGPT sign-in credentials. Each model uses the built-in entry's cost, limits and input, and the
 * System One API of the broker route.
 */
function accountClassifiers(
	providerId: string,
	account: BrokerAccount,
	accountModels: ReadonlyMap<string, readonly BrokerModel[]>,
	lookupClassifier: ClassifierLookup | undefined,
): ClassifierModel<ClassifierApi>[] | undefined {
	const source = CLASSIFIER_SOURCES.get(account.provider);
	if (!source || account.kind !== "api-key") return undefined;
	const known = lookupClassifier?.(source.catalogProvider, source.catalogModelId);
	if (known?.api !== source.catalogApi) return undefined;
	const served = (accountModels.get(account.key) ?? []).filter(source.serves);
	if (served.length === 0) return undefined;
	return served.map((model) => ({
		...known,
		id: model.id,
		name: model.displayName ?? (model.id === known.id ? known.name : model.id),
		api: SYSTEM_ONE_API,
		provider: providerId,
		baseUrl: BROKER_PLACEHOLDER_URL,
	}));
}

function toPiModel(providerId: string, family: string, model: BrokerModel, lookup: CatalogLookup): Model<Api> {
	const known = (CATALOG_SOURCES.get(family) ?? [family]).map((source) => lookup(source, model.id)).find(Boolean);
	const input: Model<Api>["input"] =
		known?.input ?? (model.inputModalities?.includes("image") ? ["text", "image"] : ["text"]);
	const piModel: Model<Api> = {
		id: model.id,
		name: known?.name ?? model.displayName ?? model.id,
		api: OMP_NATIVE_API,
		provider: providerId,
		baseUrl: BROKER_PLACEHOLDER_URL,
		reasoning: known?.reasoning ?? model.thinking,
		input,
		cost: known?.cost ?? model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: known?.contextWindow ?? model.contextLength ?? 128_000,
		maxTokens: known?.maxTokens ?? model.maxCompletionTokens ?? 16_384,
	};
	const thinkingLevelMap = known?.thinkingLevelMap ?? brokerThinkingLevelMap(model);
	if (thinkingLevelMap) piModel.thinkingLevelMap = thinkingLevelMap;
	if (known?.inputLimits) piModel.inputLimits = known.inputLimits;
	if (known?.promptCache) piModel.promptCache = known.promptCache;
	if (known?.samplingParams) piModel.samplingParams = known.samplingParams;
	if (known?.samplingParamsByThinkingLevel)
		piModel.samplingParamsByThinkingLevel = known.samplingParamsByThinkingLevel;
	return piModel;
}

function brokerThinkingLevelMap(model: BrokerModel): ThinkingLevelMap | undefined {
	const levels = model.thinkingLevels;
	if (!model.thinking || !levels?.some((level) => THINKING_LEVELS.some((supported) => supported === level))) {
		return undefined;
	}
	const map: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		if (level !== "off") map[level] = levels.includes(level) ? level : null;
	}
	return map;
}
