import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Api, type AuthCredential, AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { loadBrokerConfig } from "./config.ts";
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
	cooldown: number;
	lastStatus?: number;
}
export interface AccountOptions {
	home: string;
	anthropicBaseUrl: string;
	openaiBaseUrl: string;
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
		quotaExceeded: cooling && (account.lastStatus === 429 || account.lastStatus === 402),
		retryAfter: cooling ? new Date(account.cooldown).toISOString() : undefined,
		lastError: account.lastStatus
			? { message: `Provider returned HTTP ${account.lastStatus}.`, httpStatus: account.lastStatus }
			: undefined,
		modelCount: account.models.length,
	};
}
export function publicModels(account: Account): Record<string, unknown>[] {
	return account.models.map((model) => ({
		id: model.id,
		displayName: model.name,
		contextLength: model.contextWindow,
		maxCompletionTokens: model.maxTokens,
		thinking: !!model.thinking,
		thinkingLevels: model.thinking?.efforts,
		inputModalities: model.input,
	}));
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
			await this.register(record, key ? { type: "api_key", key, source: "login" } : undefined);
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
				{ type: "api_key", key, source: "login" },
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
		const provider =
			record.provider === "codex" && record.kind === "oauth"
				? "openai-codex"
				: record.provider === "codex" || record.provider?.startsWith("openai")
					? "openai"
					: "anthropic";
		const storage = await AuthStorage.create(join(this.options.home, "credentials", `${accountKey(record.id)}.db`), {
			usageProviderResolver: () => undefined,
			defaultReservePct: 0,
		});
		if (credential) await storage.credentials.set(provider, credential);
		else await storage.credentials.reload();
		// Static login keys rank above environment keys. Runtime overrides also prevent auth retry
		// from ever resolving an inherited provider credential when this account is unavailable.
		const current = storage.credentials.get(provider);
		if (current?.type === "api_key") storage.keys.setRuntime(provider, current.key);
		const family = record.provider === "codex" ? "codex" : provider === "anthropic" ? "claude" : "openai";
		const bundled = getBundledModels(provider);
		const ids = record.models?.length
			? record.models
			: bundled.filter((model) => !model.kind || model.kind === "chat").map((model) => model.id);
		const models = ids.map((id) => {
			const base = bundled.find((model) => model.id === id);
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
						baseUrl: "",
						reasoning: false,
						input: ["text", "image"],
						contextWindow: 200000,
						maxTokens: 16384,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					});
			model.provider = provider;
			model.preferWebsockets = false;
			if (record.baseUrl && record.provider === "codex" && record.source === "config") {
				// Legacy Codex API keys append /responses to the configured base, not /v1/responses.
				model.baseUrl = record.baseUrl;
			} else if (record.baseUrl || provider === "anthropic" || provider === "openai") {
				const baseUrl = (
					record.baseUrl ?? (provider === "anthropic" ? this.options.anthropicBaseUrl : this.options.openaiBaseUrl)
				).replace(/\/+$/, "");
				model.baseUrl = `${baseUrl}${baseUrl.endsWith("/v1") ? "" : "/v1"}`;
			}
			return model;
		});
		const account: Account = { record, storage, provider, family, models, cooldown: 0 };
		this.accounts.get(record.id)?.storage.close();
		this.accounts.set(record.id, account);
		await this.protectFiles(record.id);
		return account;
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
	async credential(account: Account, signal?: AbortSignal): Promise<{ token: string; accountId?: string }> {
		if (account.record.kind === "oauth") {
			const credential = await account.storage.oauth.access(account.provider, undefined, { signal });
			if (!credential) throw new HttpError(401, "Account sign-in must be renewed.");
			return { token: credential.accessToken, accountId: credential.accountId };
		}
		const key = account.storage.credentials.get(account.provider);
		if (key?.type !== "api_key") throw new HttpError(401, "Account credential is unavailable.");
		return { token: key.key };
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
	async listModels(record: AccountRecord, token: string, signal?: AbortSignal): Promise<string[]> {
		const anthropic = !record.provider?.startsWith("openai");
		const base = (record.baseUrl ?? (anthropic ? this.options.anthropicBaseUrl : this.options.openaiBaseUrl)).replace(
			/\/$/,
			"",
		);
		const headers: Record<string, string> = anthropic ? { "anthropic-version": "2023-06-01" } : {};
		if (anthropic) headers["x-api-key"] = token;
		else headers.authorization = `Bearer ${token}`;
		const models: string[] = [];
		let after: string | undefined;
		for (let page = 0; page < 100; page++) {
			const url = new URL(`${base}${base.endsWith("/v1") ? "" : "/v1"}/models`);
			if (anthropic) {
				url.searchParams.set("limit", "1000");
				if (after) url.searchParams.set("after_id", after);
			}
			let response: Response;
			try {
				response = await fetch(url, {
					headers,
					redirect: "error",
					signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
				});
			} catch {
				throw new HttpError(400, "Key validation failed or timed out.");
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new HttpError(400, `Key rejected (HTTP ${response.status}).`);
			}
			const text = await boundedText(response, 2 * 1024 * 1024);
			let data: WireObject;
			try {
				data = object(JSON.parse(text));
			} catch {
				throw new HttpError(400, "Provider returned invalid model data.");
			}
			if (!Array.isArray(data.data)) throw new HttpError(400, "Provider returned invalid model data.");
			models.push(
				...data.data.flatMap((model) => (typeof object(model).id === "string" ? [String(object(model).id)] : [])),
			);
			if (!anthropic || data.has_more !== true) break;
			if (typeof data.last_id !== "string" || data.last_id === after)
				throw new HttpError(400, "Provider model pagination did not finish.");
			after = data.last_id;
		}
		if (!models.length) throw new HttpError(400, "Key has no accessible models.");
		return [...new Set(models)].sort();
	}
	async addKey(input: WireObject, signal: AbortSignal): Promise<Account> {
		const provider =
			input.provider === "openai"
				? "openai-api"
				: input.provider === undefined || ["", "claude", "anthropic"].includes(String(input.provider))
					? "claude-api"
					: undefined;
		if (!provider) throw new HttpError(400, "API keys are supported for Anthropic or OpenAI");
		const name = normalizeName(input.name);
		const key = typeof input.key === "string" ? input.key.trim() : "";
		if (!key) throw new HttpError(400, "name and key are required");
		const record: AccountRecord = {
			id: `${provider}-key-${name}`,
			provider,
			name,
			kind: "api-key",
			createdAt: new Date().toISOString(),
		};
		this.duplicate(record, key);
		record.models = await this.listModels(record, key, signal);
		return this.locked(async () => {
			this.duplicate(record, key);
			const account = await this.register(record, { type: "api_key", key, source: "login" });
			await this.save();
			return account;
		});
	}
	async mutate(account: Account, action: string): Promise<void> {
		await this.locked(async () => {
			if (action === "reset") {
				account.cooldown = 0;
				account.lastStatus = undefined;
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
				await reader.cancel();
				throw new HttpError(502, "Provider response exceeded the size limit.");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, size).toString("utf8");
}
