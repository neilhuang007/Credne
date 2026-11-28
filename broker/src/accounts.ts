import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Api, type AuthCredential, AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchTypeSafeModels } from "@oh-my-pi/pi-catalog/discovery/typesafe";
import { getBundledModels, getEffectiveTokenCost } from "@oh-my-pi/pi-catalog/models";
import type { ProviderDescriptor } from "@oh-my-pi/pi-catalog/provider-models";
import { loadBrokerConfig } from "./config.ts";
import { discoverSubscriptionModels } from "./discovery.ts";
import { accountProvider, brokerProvider, unsupportedEnrollment, validateProviderKey } from "./providers.ts";
import { array, object, stringArray, text, type WireObject } from "./wire.ts";

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
export const accountKey = (id: string): string => Buffer.from(id).toString("base64url");
export interface AccountRecord {
	id: string;
	provider?: string;
	name: string;
	kind: "api-key" | "oauth";
	email?: string;
	disabled?: boolean;
	models?: string[];
	createdAt: string;
	source?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	plan?: string;
}
export interface Account {
	record: AccountRecord;
	storage: AuthStorage;
	provider: string;
	family: string;
	models: Model<Api>[];
	/** What System One may ask this account: TypeSafe's Jev models, or OpenAI's GPT-6 Luna Decisions judge. */
	judges: Model<Api>[];
	cooldown: number;
	lastStatus?: number;
	subscriptionLimit?: boolean;
	/** When a subscription's model list may be read from its provider again (epoch ms). */
	nextDiscovery: number;
	/** The subscription model read in progress, which a pool request waits for before choosing an account. */
	discovering?: Promise<void>;
}

/** How long a subscription's discovered model list stands before the next model request reads it again. */
const DISCOVERY_INTERVAL_MS = 15 * 60_000;
/** How soon a failed model list read is retried. */
const DISCOVERY_RETRY_MS = 60_000;
export interface AccountOptions {
	home: string;
	anthropicBaseUrl: string;
	openaiBaseUrl: string;
	typesafeBaseUrl: string;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error("Cannot read broker account storage.");
	}
}
function parseRecord(value: WireObject): AccountRecord {
	if (
		typeof value.id !== "string" ||
		typeof value.name !== "string" ||
		(value.kind !== "api-key" && value.kind !== "oauth")
	)
		throw new Error("Invalid broker account storage.");
	return {
		id: value.id,
		name: value.name,
		kind: value.kind,
		provider: text(value.provider),
		email: text(value.email),
		disabled: value.disabled === true,
		models: stringArray(value.models),
		createdAt: text(value.createdAt) ?? new Date().toISOString(),
		source: text(value.source),
		baseUrl: text(value.baseUrl),
		plan: text(value.plan),
	};
}
export function normalizeName(value: unknown): string {
	const name =
		typeof value === "string"
			? value
					.trim()
					.toLowerCase()
					.replace(/[^a-z0-9._-]+/g, "-")
					.replace(/^[-.]+|[-.]+$/g, "")
			: "";
	if (!name || name.length > 48)
		throw new HttpError(400, "account name must have 1-48 letters, digits, dots, dashes or underscores");
	return name;
}
export function publicAccount(account: Account): Record<string, unknown> {
	const { record } = account;
	const cooling = account.cooldown > Date.now();
	return {
		id: record.id,
		key: accountKey(record.id),
		provider: record.provider,
		kind: record.kind,
		source: record.source ?? "broker",
		label: record.name,
		email: record.email,
		plan: record.plan,
		status: record.disabled ? "disabled" : cooling ? "error" : "active",
		disabled: record.disabled === true,
		unavailable: cooling,
		quotaExceeded:
			cooling &&
			(account.lastStatus === 402 ||
				(account.lastStatus === 429 && (!isChatSubscription(account) || account.subscriptionLimit === true))),
		quotaReason: cooling && account.subscriptionLimit ? "subscription_usage_limit" : undefined,
		retryAfter: cooling ? new Date(account.cooldown).toISOString() : undefined,
		lastError: account.lastStatus
			? { message: `Provider returned HTTP ${account.lastStatus}.`, httpStatus: account.lastStatus }
			: undefined,
		modelCount: account.models.length,
	};
}
export function isChatSubscription(account: Account): boolean {
	return (account.provider === "anthropic" || account.provider === "openai-codex") && account.record.kind === "oauth";
}

/** TypeSafe accounts answer System One classifier requests only; they never serve chat. */
export const classifierAccount = (account: Account): boolean => account.provider === "typesafe";

/** Statuses that bench an account until the provider's retry hint expires. */
export const cooldownStatuses: readonly number[] = [429, 402, 503];

/** Records a failed provider response and, for a cooldown status, benches the account until its retry hint. */
export function recordFailure(account: Account, status: number, retryAfter?: string, subscriptionLimit = false): void {
	account.subscriptionLimit = subscriptionLimit;
	account.lastStatus = status;
	if (!cooldownStatuses.includes(status)) return;
	const seconds = Number(retryAfter);
	const date = Date.parse(retryAfter ?? "");
	account.cooldown =
		Number.isFinite(seconds) && seconds > 0
			? Date.now() + seconds * 1000
			: Number.isFinite(date)
				? date
				: Date.now() + (status === 402 ? 3600000 : 60000);
}

export function publicModels(account: Account): Record<string, unknown>[] {
	const knownChat = new Set(brokerProvider(account.provider)?.models.map((model) => model.id));
	return account.models.map((model) => {
		const { input, output, cacheRead, cacheWrite } = getEffectiveTokenCost(model.cost);
		return {
			id: model.id,
			// The identity OMP resolves the model to. OMP replays signed thinking only for past assistant turns that
			// carry it, so callers send history under these values.
			provider: model.provider,
			api: model.api,
			displayName: model.name,
			kind: classifierAccount(account) ? "classifier" : knownChat.has(model.id) ? "chat" : undefined,
			contextLength: model.contextWindow,
			maxCompletionTokens: model.maxTokens,
			thinking: !!model.thinking,
			thinkingLevels: model.thinking?.efforts,
			inputModalities: model.input,
			cost: { input, output, cacheRead, cacheWrite },
		};
	});
}

/** A System One model the bundled catalog lacks; it takes images like the bundled Jev rows, and TypeSafe refuses what it cannot read. */
function typeSafeModel(id: string, baseUrl: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "typesafe",
		provider: "typesafe",
		baseUrl,
		kind: "judge",
		reasoning: false,
		input: ["text", "image"],
		supportsTools: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	});
}

const lunaId = "gpt-6-luna";

/**
 * OpenAI's Decisions API answers System One questions for GPT-6 Luna. OMP's catalog defines that judge as its own
 * row (`gpt-6-luna-decisions`, wire id `gpt-6-luna`); an OpenAI key that lists the chat model serves it under the
 * wire id, which is what System One callers name.
 */
function openaiJudges(record: AccountRecord, models: Model<Api>[]): Model<Api>[] {
	const chat = models.find((model) => model.id === lunaId);
	const judge = getBundledModels("openai").find((model) => model.id === `${lunaId}-decisions`);
	if (record.provider !== "openai-api" || !chat || !judge) return [];
	return [{ ...judge, id: lunaId, baseUrl: chat.baseUrl, headers: chat.headers }];
}

/** The `/v1` root of an Anthropic or OpenAI endpoint, from a base URL given with or without it. */
function apiRoot(base: string): string {
	const root = base.replace(/\/+$/, "");
	return `${root}${root.endsWith("/v1") ? "" : "/v1"}`;
}

/** The model IDs a key's discovery returned, or the error its HTTP status explains when it returned none. */
function discoveredIds(models: readonly { id: string }[] | null | undefined, status: number | undefined): string[] {
	if (!models) {
		if (status === undefined) throw new HttpError(400, "Key validation failed or timed out.");
		throw new HttpError(
			400,
			status >= 400 ? `Key rejected (HTTP ${status}).` : "Provider returned invalid model data.",
		);
	}
	if (!models.length) throw new HttpError(400, "Key has no accessible models.");
	return models.map((model) => model.id);
}

/** Each store contains exactly one account. Provider retries cannot cross this boundary. */
export class Accounts {
	readonly accounts = new Map<string, Account>();
	readonly options: AccountOptions;
	readonly routing = { affinity: true, retries: 1, strategy: "round-robin" };
	private readonly metadataPath: string;
	private mutation: Promise<unknown> = Promise.resolve();
	constructor(options: AccountOptions) {
		this.options = options;
		this.metadataPath = join(options.home, "omp-accounts.json");
	}
	async locked<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.mutation.then(fn, fn);
		this.mutation = next.catch(() => {});
		return next;
	}
	async load(): Promise<void> {
		await mkdir(join(this.options.home, "credentials"), { recursive: true, mode: 0o700 });
		await chmod(join(this.options.home, "credentials"), 0o700);
		const config = await loadBrokerConfig(this.options.home);
		const metadata = await readJson(this.metadataPath);
		const migrating = metadata === undefined;
		const saved = object(migrating ? await readJson(join(this.options.home, "api-accounts.json")) : metadata);
		if (!migrating && (saved.version !== 2 || !Array.isArray(saved.accounts)))
			throw new Error("Invalid OMP broker account storage.");
		for (const raw of array(saved.accounts)) {
			const value = object(raw);
			// Console credits stay in the legacy store; OMP does not serve them.
			if (value.kind === "api-credits") continue;
			const record = parseRecord(value);
			record.provider ??= record.kind === "oauth" ? "codex" : "claude-api";
			const key = migrating && record.kind === "api-key" ? text(value.apiKey) : undefined;
			await this.register(record, key ? { type: "api_key", key } : undefined);
		}
		if (migrating) {
			await this.importLegacy();
			// An empty snapshot is authoritative too: later deletes must not revive legacy accounts.
			await this.save();
		}
		Object.assign(this.routing, config.routing);
		for (const { key, ...record } of config.accounts) {
			await this.register(
				{ ...record, kind: "api-key", source: "config", createdAt: new Date().toISOString() },
				{ type: "api_key", key },
			);
		}
	}
	private async importLegacy(): Promise<void> {
		let names: string[];
		try {
			names = await readdir(join(this.options.home, "auths"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const name of names) {
			if (!name.endsWith(".json") || this.accounts.has(name)) continue;
			const data = object(await readJson(join(this.options.home, "auths", name)));
			const provider = data.type ?? data.provider;
			if (provider !== "codex" && provider !== "claude") continue;
			const access = data.access_token ?? object(data.tokens).access_token;
			const refresh = data.refresh_token ?? object(data.tokens).refresh_token;
			if (typeof access !== "string" || typeof refresh !== "string") continue;
			const expires =
				Date.parse(text(data.expired ?? data.expires_at) ?? "") ||
				(typeof data.expires === "number" ? data.expires : Date.now());
			const email = text(data.email),
				accountId = text(data.account_id),
				orgId = provider === "claude" ? text(data.organization_uuid) : accountId;
			await this.register(
				{
					id: name,
					provider,
					name: email ?? name,
					kind: "oauth",
					email,
					plan: text(data.plan_type),
					disabled: data.disabled === true,
					createdAt: new Date().toISOString(),
				},
				{ type: "oauth", access, refresh, expires, email, accountId, orgId },
			);
		}
	}
	async register(record: AccountRecord, credential?: AuthCredential): Promise<Account> {
		const { native: provider, family } = accountProvider(record.provider, record.kind);
		const upstream = brokerProvider(provider);
		if (!upstream?.[record.kind === "oauth" ? "oauth" : "key"])
			throw new HttpError(400, unsupportedEnrollment(provider, record.kind));
		const storage = await AuthStorage.create(join(this.options.home, "credentials", `${accountKey(record.id)}.db`), {
			defaultReservePct: 0,
		});
		if (credential) await storage.credentials.set(provider, credential);
		else await storage.credentials.reload();
		// A pasted key is a literal override, not an OMP login-issued subscription or environment reference.
		const current = storage.credentials.get(provider);
		if (current?.type === "api_key") storage.keys.setRuntime(provider, current.key);
		const bundled = new Map(upstream.models.map((model) => [model.id, model]));
		const ids = record.models?.length ? record.models : bundled.keys();
		const legacy = provider === "anthropic" || provider === "openai" || provider === "openai-codex";
		const known = legacy ? new Map(getBundledModels(provider).map((model) => [model.id, model])) : bundled;
		// Subscriptions start from the bundled list; refreshSubscriptionModels replaces it with the provider's own.
		const models = [...ids].flatMap((id) => {
			const base = known.get(id);
			// TypeSafe serves every model ID its account lists, including IDs the bundled catalog lacks.
			if (provider === "typesafe") {
				const baseUrl = this.options.typesafeBaseUrl;
				return [base ? { ...base, baseUrl } : typeSafeModel(id, baseUrl)];
			}
			// Only legacy configurable providers accept custom model IDs; keep known auxiliary APIs intact.
			if (!base && !legacy) return [];
			const model: Model<Api> = base
				? { ...base }
				: buildModel({
						id,
						name: id,
						api:
							provider === "anthropic"
								? "anthropic-messages"
								: provider === "openai-codex"
									? "openai-codex-responses"
									: "openai-responses",
						provider,
						baseUrl: upstream.models[0]!.baseUrl,
						reasoning: false,
						input: ["text", "image"],
						contextWindow: 200000,
						maxTokens: 16384,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					});
			return [this.routed(record, provider, model)];
		});
		const judges = provider === "typesafe" ? models : openaiJudges(record, models);
		const account: Account = { record, storage, provider, family, models, judges, cooldown: 0, nextDiscovery: 0 };
		this.accounts.get(record.id)?.storage.close();
		this.accounts.set(record.id, account);
		await this.protectFiles(record.id);
		return account;
	}
	/** Points a model the account serves at the account's endpoint and routing headers, as OMP will send it. */
	private routed(record: AccountRecord, provider: string, model: Model<Api>): Model<Api> {
		const legacy = provider === "anthropic" || provider === "openai" || provider === "openai-codex";
		model.provider = provider;
		model.preferWebsockets = false;
		if (record.kind === "oauth") return model;
		// OMP sends a model's headers with its requests; configured routing headers ride on the model.
		if (record.headers) model.headers = { ...model.headers, ...record.headers };
		if (record.baseUrl && record.provider === "codex" && record.source === "config") {
			// Legacy Codex API keys append /responses to the configured base, not /v1/responses.
			model.baseUrl = record.baseUrl;
		} else if (legacy && (record.baseUrl || provider === "anthropic" || provider === "openai")) {
			model.baseUrl = apiRoot(
				record.baseUrl ?? (provider === "anthropic" ? this.options.anthropicBaseUrl : this.options.openaiBaseUrl),
			);
		}
		return model;
	}
	/**
	 * Replaces a subscription account's models with the list its provider gives for the account's sign-in, at most once
	 * per discovery interval. The bundled catalog lags new releases: without this, a model only an API key lists, such
	 * as a new GPT release the ChatGPT plan also serves, always routes to the billed key. A failed read keeps the
	 * current models and is retried sooner. Concurrent callers share one read.
	 */
	refreshSubscriptionModels(account: Account): Promise<void> {
		if (account.record.kind !== "oauth" || account.record.disabled || Date.now() < account.nextDiscovery)
			return Promise.resolve();
		account.discovering ??= (async () => {
			try {
				const models = await discoverSubscriptionModels(account);
				if (models) account.models = models.map((model) => this.routed(account.record, account.provider, model));
				account.nextDiscovery = Date.now() + (models ? DISCOVERY_INTERVAL_MS : DISCOVERY_RETRY_MS);
			} catch {
				account.nextDiscovery = Date.now() + DISCOVERY_RETRY_MS;
			} finally {
				account.discovering = undefined;
			}
		})();
		return account.discovering;
	}
	private async protectFiles(id: string): Promise<void> {
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				await chmod(join(this.options.home, "credentials", `${accountKey(id)}.db${suffix}`), 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
	get(key: string): Account {
		const account = [...this.accounts.values()].find((account) => accountKey(account.record.id) === key);
		if (!account) throw new HttpError(404, "account not found");
		return account;
	}
	async save(): Promise<void> {
		const records = [...this.accounts.values()]
			.filter((account) => account.record.source !== "config")
			.map((account) => account.record);
		await atomicJson(this.metadataPath, { version: 2, accounts: records });
	}
	duplicate(record: AccountRecord, key?: string): void {
		for (const existing of this.accounts.values()) {
			if (existing.record.id === record.id)
				throw new HttpError(409, `An API key account named ${record.name} already exists.`);
			const credential = existing.storage.credentials.get(existing.provider);
			if (key && credential?.type === "api_key" && credential.key === key)
				throw new HttpError(409, `This API key is already added as ${existing.record.name}.`);
		}
	}
	/** Lists an Anthropic or OpenAI key's chat models through OMP's authenticated catalog discovery, sorted. */
	async listModels(
		record: AccountRecord,
		native: string,
		descriptor: ProviderDescriptor,
		key: string,
		signal: AbortSignal,
	): Promise<string[]> {
		const baseUrl = apiRoot(
			record.baseUrl ?? (native === "anthropic" ? this.options.anthropicBaseUrl : this.options.openaiBaseUrl),
		);
		const origin = new URL(baseUrl).origin;
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
		const reply: { status?: number } = {};
		const rows = await descriptor
			.createModelManagerOptions({
				apiKey: key,
				baseUrl,
				fetch: async (input, init) => {
					const request = new Request(input, init);
					// Discovery also reads public reference data; only the provider itself may see the key.
					if (new URL(request.url).origin !== origin) throw new Error("Unexpected discovery endpoint.");
					const response = await fetch(request, {
						redirect: "error",
						signal: AbortSignal.any([request.signal, deadline]),
					});
					reply.status = response.status;
					return response;
				},
			})
			.fetchDynamicModels?.();
		// Discovery returns embedding, speech and judge models as chat rows; the catalog knows which they are.
		const catalog = new Map(getBundledModels(native).map((model) => [model.id, model.kind]));
		const chat = rows?.filter((row) => (row.kind ?? catalog.get(row.id) ?? "chat") === "chat");
		return [...new Set(discoveredIds(chat, reply.status))].sort();
	}
	/** Lists a TypeSafe key's models through OMP's authenticated discovery, in the order TypeSafe reports them. */
	async listTypeSafeModels(key: string, signal: AbortSignal): Promise<string[]> {
		const reply: { status?: number } = {};
		const models = await fetchTypeSafeModels({
			apiKey: key,
			baseUrl: this.options.typesafeBaseUrl,
			signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
			fetch: async (input, init) => {
				const response = await fetch(input, { ...init, redirect: "error" });
				reply.status = response.status;
				return response;
			},
		});
		return discoveredIds(models, reply.status);
	}
	async addKey(input: WireObject, signal: AbortSignal): Promise<Account> {
		const id = input.provider === undefined ? "anthropic" : text(input.provider)?.trim().toLowerCase();
		if (id === undefined) throw new HttpError(400, "provider must be an OMP provider ID");
		const { native, record: provider } = accountProvider(id, "api-key");
		const upstream = provider === "codex" ? undefined : brokerProvider(native);
		if (!upstream?.key) throw new HttpError(400, unsupportedEnrollment(id, "api-key"));
		const name = normalizeName(input.name);
		let key = text(input.key)?.trim() ?? "";
		if (!key) throw new HttpError(400, "name and key are required");
		const record: AccountRecord = {
			id: `${provider}-key-${name}`,
			provider,
			name,
			kind: "api-key",
			createdAt: new Date().toISOString(),
		};
		this.duplicate(record, key);
		if (upstream.key.kind === "legacy")
			record.models = await this.listModels(record, native, upstream.key.descriptor, key, signal);
		else if (upstream.key.kind === "classifier") record.models = await this.listTypeSafeModels(key, signal);
		else {
			try {
				const validated = await validateProviderKey(upstream, upstream.key, key, signal);
				key = validated.key;
				record.models = validated.ids;
			} catch {
				signal.throwIfAborted();
				throw new HttpError(
					400,
					"Provider did not verify this key for chat. Check the key, access, and provider availability.",
				);
			}
		}
		return this.locked(async () => {
			signal.throwIfAborted();
			this.duplicate(record, key);
			const account = await this.register(record, { type: "api_key", key });
			await this.save();
			return account;
		});
	}
	async mutate(account: Account, action: string): Promise<void> {
		await this.locked(async () => {
			if (action === "reset") {
				account.cooldown = 0;
				account.lastStatus = undefined;
				account.subscriptionLimit = false;
				for (const row of account.storage.credentials.list()) account.storage.blocks.deleteAll(row.id);
				return;
			}
			if (account.record.source === "config")
				throw new HttpError(409, "API-key accounts are managed in the broker config.yaml");
			if (action === "delete") {
				await account.storage.credentials.remove(account.provider);
				this.accounts.delete(account.record.id);
				account.storage.close();
			} else account.record.disabled = action === "disable";
			await this.save();
		});
	}
	close(): void {
		for (const account of this.accounts.values()) account.storage.close();
	}
}
export async function boundedText(response: Response, limit: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) {
				void reader.cancel().catch(() => {});
				throw new HttpError(502, "Provider response exceeded the size limit.");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, size).toString("utf8");
}
