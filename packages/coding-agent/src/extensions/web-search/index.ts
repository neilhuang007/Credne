// The `web_search` tool: hosted search on a Claude or ChatGPT subscription, sent by the broker through oh-my-pi.
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import {
	ACCOUNT_PROVIDER_PREFIX,
	ALL_POOL,
	accountProviderId,
	familyOf,
	POOL_PROVIDER_PREFIX,
} from "../accounts/catalog.ts";
import { type BrokerAccount, type BrokerClient, fetchBroker } from "../accounts/client.ts";
import { createAccountBrokerClient } from "../accounts/index.ts";
import { matchesServingAccount, observeServingAccount, type ServingAccount } from "../serving-account.ts";

/** One source of a search result. */
export interface SearchSource {
	title: string;
	url: string;
	publishedDate?: string;
}

/** A finished search as the broker reports it. */
export interface SearchResult {
	provider: string;
	model?: string;
	answer?: string;
	sources: SearchSource[];
	/** What oh-my-pi's query post-filter changed, such as sources removed outside a domain filter. */
	notes: string[];
}

/**
 * Registers `web_search`. The broker runs the search with oh-my-pi's own web search providers on a Claude or ChatGPT
 * subscription, so the request is the one oh-my-pi sends; API keys are never used for it.
 */
export default function webSearchExtension(pi: ExtensionAPI): void {
	const client = createAccountBrokerClient();
	const servingAccount = observeServingAccount(pi);
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description: describeWebSearch(new Date()),
		parameters: Type.Object({
			query: Type.String({ description: "The search query to use" }),
		}),
		async execute(_toolCallId, { query }, signal, _onUpdate, ctx) {
			const trimmed = query.trim();
			if (trimmed.length < 2 || trimmed.length > 4096) {
				throw new Error("Enter a search query between 2 and 4096 characters.");
			}
			const timeout = AbortSignal.timeout(120_000);
			const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const sessionId = ctx.sessionManager.getSessionId();
			let limited: Error | undefined;
			for await (const { account, modelId } of eligibleSubscriptions(
				client,
				ctx.model,
				servingAccount(ctx),
				deadline,
			)) {
				const answer = await searchAccount(client, account.key, { modelId, sessionId, query: trimmed }, deadline);
				if (answer.type === "limited") {
					limited = new Error(answer.message);
					continue;
				}
				return {
					content: [{ type: "text" as const, text: formatResults(trimmed, answer.result) }],
					details: { account: account.id, query: trimmed, ...answer.result },
				};
			}
			throw (
				limited ??
				new Error(
					"No available Claude or ChatGPT subscription for this search. Use /accounts add claude-subscription or /accounts add codex, then select an available subscription model with /model.",
				)
			);
		},
	});
}

// Claude Code's concise WebSearch description, keeping only its lines that hold for this tool.
function describeWebSearch(now: Date): string {
	const month = now.toLocaleString("en-US", { month: "long", year: "numeric" });
	return `Search the web.

- The current month is ${month} — use this when searching for recent information.`;
}

/** The tool result text: the search model's answer, then every source as a numbered markdown link. */
function formatResults(query: string, result: SearchResult): string {
	const sources = result.sources.map(
		(source, index) =>
			`${index + 1}. [${source.title}](${source.url})${source.publishedDate ? ` (${source.publishedDate})` : ""}`,
	);
	return [
		`Web search results for query: "${query}"`,
		result.answer?.trim() || "The search returned sources without a summary.",
		`Sources:\n${sources.join("\n")}`,
		...(result.notes.length > 0 ? [`Notes:\n${result.notes.map((note) => `- ${note}`).join("\n")}`] : []),
	].join("\n\n");
}

/**
 * The subscriptions to search on, best first, with the session model each one serves. A session pinned to an
 * account searches only there; a pool searches its subscriptions that offer the session's model; a session outside
 * the broker uses any subscription's first model. The broker then picks oh-my-pi's search model for it (Claude Haiku
 * on Claude, GPT-6 Luna on ChatGPT).
 */
async function* eligibleSubscriptions(
	client: BrokerClient,
	active: Model<Api> | undefined,
	serving: ServingAccount | undefined,
	signal: AbortSignal,
): AsyncGenerator<{ account: BrokerAccount; modelId: string }> {
	const provider = active?.provider ?? "";
	const pinned = provider.startsWith(ACCOUNT_PROVIDER_PREFIX);
	const pool = provider.startsWith(POOL_PROVIDER_PREFIX) ? provider.slice(POOL_PROVIDER_PREFIX.length) : undefined;
	const accounts = (await client.listAccounts(signal)).filter(
		(account) =>
			account.kind === "oauth" &&
			(account.provider === "claude" || account.provider === "codex") &&
			!account.disabled &&
			!account.unavailable &&
			!account.quotaExceeded &&
			!(account.retryAfter && Date.parse(account.retryAfter) > Date.now()) &&
			(!pinned || accountProviderId(account.id) === provider) &&
			(!pool || pool === ALL_POOL || pool === familyOf(account.provider)),
	);
	if (serving) {
		accounts.sort(
			(left, right) => Number(matchesServingAccount(right, serving)) - Number(matchesServingAccount(left, serving)),
		);
	}
	for (const account of accounts) {
		signal.throwIfAborted();
		const models = await client.accountModels(account.key, signal);
		const offered = models.find((model) => model.id === active?.id) ?? (pinned || pool ? undefined : models[0]);
		if (offered) yield { account, modelId: offered.id };
	}
}

/** Asks the broker to search on one pinned account. A usage limit lets the next subscription try. */
async function searchAccount(
	client: BrokerClient,
	key: string,
	request: { modelId: string; sessionId: string; query: string },
	signal: AbortSignal,
): Promise<{ type: "found"; result: SearchResult } | { type: "limited"; message: string }> {
	const connection = await client.connect(signal);
	const response = await fetchBroker(`${client.routeBaseUrl(connection, { type: "account", key })}/search`, {
		method: "POST",
		headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
		body: JSON.stringify(request),
		signal,
	});
	const payload: unknown = await response.json().catch(() => undefined);
	if (!response.ok) {
		const message = brokerError(payload) ?? `Hosted web search failed (HTTP ${response.status}).`;
		if (response.status === 429) return { type: "limited", message };
		throw new Error(message);
	}
	return { type: "found", result: parseResult(payload) };
}

// Broker responses are wire input: read only checked fields.
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && Object.hasOwn(value, key)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function optionalText(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function brokerError(payload: unknown): string | undefined {
	return optionalText(field(field(payload, "error"), "message"));
}

function parseResult(payload: unknown): SearchResult {
	const rawSources = field(payload, "sources");
	const rawNotes = field(payload, "notes");
	const sources = (Array.isArray(rawSources) ? rawSources : []).flatMap((source): SearchSource[] => {
		const url = optionalText(field(source, "url"));
		const parsed = url ? URL.parse(url) : null;
		if (!url || !parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return [];
		const title =
			optionalText(field(source, "title"))
				?.replace(/[\s\p{Cc}]+/gu, " ")
				.trim() || parsed.hostname;
		const publishedDate = optionalText(field(source, "publishedDate"));
		return [{ title: title.slice(0, 200), url, ...(publishedDate && { publishedDate }) }];
	});
	return {
		provider: optionalText(field(payload, "provider")) ?? "unknown",
		model: optionalText(field(payload, "model")),
		answer: optionalText(field(payload, "answer"))?.slice(0, 16_000),
		sources,
		notes: (Array.isArray(rawNotes) ? rawNotes : [])
			.flatMap((note) => (typeof note === "string" && note ? [note.slice(0, 500)] : []))
			.slice(0, 10),
	};
}
