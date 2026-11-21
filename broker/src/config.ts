// Loads supported user configuration and derives IDs compatible with the legacy broker.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { object, type WireObject } from "./wire.ts";

export class BrokerConfigError extends Error {}

interface ConfigAccount {
	id: string;
	provider: "claude-api" | "codex" | "openai-api";
	key: string;
	name: string;
	baseUrl?: string;
	models?: string[];
	headers?: Record<string, string>;
}

interface Config {
	routing: { affinity: boolean; retries: number; strategy: "round-robin" | "fill-first" };
	accounts: ConfigAccount[];
}

/** Reads only local account and routing settings; errors never include user-supplied values. */
export async function loadBrokerConfig(home: string): Promise<Config> {
	let config: WireObject = {};
	try {
		const value: unknown = parse(await readFile(join(home, "config.yaml"), "utf8"));
		if (value !== null) config = mapping(value, "config.yaml");
	} catch (error) {
		if (error instanceof BrokerConfigError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			// YAML diagnostics can quote the user's API key or other secrets.
			throw new BrokerConfigError("Cannot read broker config.yaml. Check the file and YAML syntax.");
		}
	}
	if (config["claude-api-key"] != null || config["codex-api-key"] != null)
		throw new BrokerConfigError("Use grouped api-keys.claude and api-keys.codex in config.yaml.");
	if (config["proxy-url"] || object(config.requests)["proxy-url"])
		throw new BrokerConfigError("config.yaml: global proxy-url is not supported by the OMP broker.");

	checkFields(config, "config.yaml", ["api-keys", "routing", "config-version"]);
	const routing = config.routing == null ? {} : mapping(config.routing, "routing");
	checkFields(routing, "routing", ["strategy", "session-affinity", "retry"]);
	const retry = routing.retry == null ? {} : mapping(routing.retry, "routing.retry");
	checkFields(retry, "routing.retry", ["request-retry"]);
	const strategy = routing.strategy ?? "round-robin";
	const affinity = routing["session-affinity"] ?? true;
	const retries = retry["request-retry"] ?? 1;
	if (strategy !== "round-robin" && strategy !== "fill-first")
		throw new BrokerConfigError("routing.strategy must be round-robin or fill-first.");
	if (typeof affinity !== "boolean") throw new BrokerConfigError("routing.session-affinity must be a boolean.");
	if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || retries > 10)
		throw new BrokerConfigError("routing.retry.request-retry must be an integer from 0 to 10.");

	const groups = config["api-keys"] == null ? {} : mapping(config["api-keys"], "api-keys");
	return { routing: { strategy, affinity, retries }, accounts: configAccounts(groups) };
}

const supportedGroup = ["name", "base-url", "keys", "models", "headers", "auth_index", "auth-index"];
const supportedKey = ["api-key", "models", "headers", "auth_index", "auth-index"];
const knownUnsupported = new Set([
	"proxy-url",
	"prefix",
	"connection-pool",
	"priority",
	"weight",
	"excluded-models",
	"disable-cooling",
	"request-retry",
	"request-scoped-errors",
	"websockets",
	"alpha-search",
	"disable-codex-cloaking",
	"rebuild-mid-system-message",
	"native-tool-search",
	"cloak",
	"fingerprint-profile",
	"experimental-cch-signing",
	"cooldown",
	"force-model-prefix",
	"max-retry-interval",
	"max-retry-credentials",
	"base-url",
]);

function configAccounts(providers: WireObject): ConfigAccount[] {
	const records: ConfigAccount[] = [];
	const counts = new Map<string, number>();
	for (const [family, groups] of Object.entries(providers)) {
		if (family !== "claude" && family !== "codex" && family !== "openai" && family !== "anthropic")
			throw new BrokerConfigError("api-keys contains an unsupported provider. Use claude, codex or openai.");
		const provider = family === "codex" ? "codex" : family === "openai" ? "openai-api" : "claude-api";
		for (const [groupIndex, rawGroup] of sequence(groups, `api-keys.${family}`).entries()) {
			const groupPath = `api-keys.${family}[${groupIndex}]`;
			const group = mapping(rawGroup, groupPath);
			checkFields(group, groupPath, supportedGroup);
			const baseUrl = optionalString(group["base-url"], `${groupPath}.base-url`);
			if (baseUrl) validateBaseUrl(baseUrl, groupPath);
			const name = optionalString(group.name, `${groupPath}.name`);
			const keys = sequence(group.keys, `${groupPath}.keys`);
			if (family === "codex" && keys.length && !baseUrl)
				throw new BrokerConfigError(`${groupPath}: a Codex API-key group requires a base-url.`);
			for (const [keyIndex, rawKey] of keys.entries()) {
				const keyPath = `${groupPath}.keys[${keyIndex}]`;
				const entry = mapping(rawKey, keyPath);
				checkFields(entry, keyPath, supportedKey);
				const key = optionalString(entry["api-key"], `${keyPath}.api-key`);
				if (!key) throw new BrokerConfigError(`${keyPath} requires a nonempty api-key.`);
				// CLIProxyAPI replaces whole models/headers fields at key scope, not individual items.
				const models = modelIds(entry.models ?? group.models, keyPath);
				const headers = requestHeaders(entry.headers ?? group.headers, keyPath);
				const legacy = family === "claude" || family === "codex";
				const baseId = legacy
					? legacyId(family, key, baseUrl, headers)
					: `config-${family}-${createHash("sha256")
							.update(`${entry["api-key"]}\0${group["base-url"] ?? ""}`)
							.digest("hex")
							.slice(0, 24)}`;
				const index = counts.get(baseId) ?? 0;
				counts.set(baseId, index + 1);
				if (index && !legacy)
					throw new BrokerConfigError(
						`${keyPath} duplicates an API key and base-url already configured for this provider.`,
					);
				const id = index ? `${baseId}-${index}` : baseId;
				records.push({ id, provider, key, name: name ?? id, baseUrl, models, headers });
			}
		}
	}
	return records;
}

function legacyId(family: "claude" | "codex", key: string, baseUrl?: string, headers?: Record<string, string>): string {
	// CLIProxyAPI 8.0.70 hashes kind, key, base, proxy, prefix and sorted name/value pairs,
	// separated by NUL. Proxy and prefix are empty for the supported configuration subset.
	const kind = `${family}:apikey`;
	const headerPairs = Object.keys(headers ?? {})
		.sort()
		.map((name) => `${name}\0${headers?.[name]}\0`)
		.join("");
	const digest = createHash("sha256")
		.update([kind, key, baseUrl ?? "", "", "", headerPairs].join("\0"))
		.digest("hex");
	return `${kind}:${digest.slice(0, 12)}`;
}

function checkFields(record: WireObject, path: string, allowed: string[]): void {
	for (const [field, value] of Object.entries(record)) {
		if (allowed.includes(field) || value == null) continue;
		if ((field === "proxy-url" || field === "prefix") && typeof value === "string" && trim(value) === "") continue;
		const detail = knownUnsupported.has(field) ? `the ${field} option` : "an unrecognized option";
		throw new BrokerConfigError(`${path}: ${detail} is not supported by the OMP broker.`);
	}
}

function optionalString(value: unknown, path: string): string | undefined {
	if (value == null) return undefined;
	if (typeof value !== "string") throw new BrokerConfigError(`${path} must be a string.`);
	return trim(value) || undefined;
}

function trim(value: string): string {
	// Go strings.TrimSpace follows Unicode White_Space rather than JavaScript's trim set.
	return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

function validateBaseUrl(value: string, path: string): void {
	try {
		const url = new URL(value);
		if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)
			return;
	} catch {
		// Invalid URL errors can quote the URL; report the field only.
	}
	throw new BrokerConfigError(`${path}.base-url must be an HTTP(S) URL without credentials, query or fragment.`);
}

function modelIds(value: unknown, path: string): string[] | undefined {
	if (value == null) return undefined;
	const models: string[] = [];
	for (const raw of sequence(value, `${path}.models`)) {
		const model = typeof raw === "string" ? { name: raw } : mapping(raw, `${path}.models`);
		const name = optionalString(model.name, `${path}.models[].name`);
		if (!name) throw new BrokerConfigError(`${path}.models requires a model name.`);
		const alias = optionalString(model.alias, `${path}.models[].alias`);
		if ((alias && alias !== name) || Object.keys(model).some((field) => field !== "name" && field !== "alias"))
			throw new BrokerConfigError(
				`${path}.models accepts literal model names only; aliases and model overrides are not supported.`,
			);
		models.push(name);
	}
	return models;
}

const forbiddenHeaders = new Set([
	"authorization",
	"proxy-authorization",
	"x-api-key",
	"cookie",
	"cookie2",
	"host",
	"origin",
	"content-length",
	"content-encoding",
	"content-type",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"te",
	"trailer",
	"upgrade",
	"proxy-connection",
	"accept-encoding",
	"chatgpt-account-id",
]);

function requestHeaders(value: unknown, path: string): Record<string, string> | undefined {
	if (value == null) return undefined;
	const checked = new Headers();
	const normalized: [string, string][] = [];
	for (const [rawName, rawValue] of Object.entries(mapping(value, `${path}.headers`))) {
		const name = trim(rawName);
		if (typeof rawValue !== "string") throw new BrokerConfigError(`${path}.headers values must be strings.`);
		const header = trim(rawValue);
		if (!name || !header) continue;
		try {
			const lower = name.toLowerCase();
			if (forbiddenHeaders.has(lower) || lower.startsWith("x-credne-") || checked.has(name)) throw new Error();
			checked.set(name, header);
		} catch {
			throw new BrokerConfigError(`${path}.headers contains an invalid, repeated, or reserved header.`);
		}
		normalized.push([name, header]);
	}
	return Object.fromEntries(normalized);
}

function mapping(value: unknown, path: string): WireObject {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new BrokerConfigError(`${path} must be a mapping.`);
	return object(value);
}

function sequence(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) throw new BrokerConfigError(`${path} must be a list.`);
	return value;
}
