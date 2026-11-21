import type { Response } from "undici";
import { fetchBroker } from "../accounts/client.ts";

type Family = "codex" | "claude";
/** One search hit as the main model receives it. */
export type SearchLink = { title: string; url: string };
/** One step of a hosted search, in order: the links one search returned, or the search model's text. */
export type SearchEntry = { links: SearchLink[] } | string;
/** Domain filters for one search; callers set at most one list. */
export type DomainFilter = { allowedDomains?: string[]; blockedDomains?: string[] };
/** The ordered steps of a hosted search and how many searches ran. */
export type SearchResult = { entries: SearchEntry[]; searchCount: number };

// Links stay raw until the whole response is read, because Codex titles arrive with the later answer.
type Collected = {
	entries: (string | { raw: readonly unknown[] })[];
	text: string;
	searchCount: number;
	titles: Map<string, string>;
};

const PINNED_ROUTE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/credne\/v1\/route\/a\.[A-Za-z0-9_-]+$/;
// Claude Code's WebSearch side query (2.1.329): the search model searches and summarizes; the caller can search again.
const SEARCH_SYSTEM_PROMPT =
	"You run a web search for another model, which is waiting on the result and can search again. " +
	"Search once, then reply with a brief summary of the results.";
const MAX_SEARCHES = 8;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_LENGTH = 8_000;
const MAX_LINKS_PER_SEARCH = 20;
const MAX_URL_LENGTH = 2_048;
const MAX_TITLE_LENGTH = 200;

/** Runs native hosted web search on a pinned broker account, not a model-only answer. */
export async function searchHosted(
	family: Family,
	baseUrl: string,
	brokerToken: string,
	model: string,
	query: string,
	filter: DomainFilter,
	signal: AbortSignal,
): Promise<SearchResult> {
	if (!PINNED_ROUTE.test(baseUrl)) throw new Error("Hosted web search requires a pinned loopback broker route.");
	const codex = family === "codex";
	const provider = codex ? "Codex" : "Claude";
	const prompt = `Perform a web search for the query: ${query}`;
	const body = codex
		? {
				model,
				stream: false,
				store: false,
				instructions: SEARCH_SYSTEM_PROMPT,
				input: `${prompt}${codexDomainNote(filter)}`,
				tools: [{ type: "web_search" }],
				tool_choice: "required",
				include: ["web_search_call.action.sources"],
				max_output_tokens: 4096,
			}
		: {
				model,
				stream: false,
				system: SEARCH_SYSTEM_PROMPT,
				messages: [{ role: "user", content: prompt }],
				tools: [claudeSearchTool(filter)],
				tool_choice: CLAUDE_SEARCH_TOOL_CHOICE,
				max_tokens: 4096,
			};
	let response: Response;
	try {
		signal.throwIfAborted();
		response = await fetchBroker(`${baseUrl}${codex ? "/responses" : "/v1/messages"}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${brokerToken}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify(body),
			signal,
		});
	} catch {
		signal.throwIfAborted();
		throw new Error(`Could not reach the local broker for ${provider} hosted web search.`);
	}
	const payload = await readResponse(response, provider, signal);
	const error = field(payload, "error");
	if (!response.ok || error != null) {
		const status = response.ok ? "" : ` (HTTP ${response.status})`;
		const detail = errorDetail(field(error, "message") ?? error, brokerToken);
		const message = `${provider} hosted web search failed${status}${detail ? `: ${detail}` : "."}`;
		throw response.status === 429 ? new UsageLimitedSearchError(message) : new Error(message);
	}
	const collected = codex ? readCodex(payload, brokerToken) : readClaude(payload, brokerToken);
	// Anthropic filters domains server-side; the Codex tool has no blocked list, so its links are filtered here.
	return finishHosted(
		collected,
		payload,
		provider,
		brokerToken,
		codex ? filter : {},
		codex ? "status" : "stop_reason",
	);
}

/** A hosted search that failed because the account's usage limit is reached, so another account may serve it. */
export class UsageLimitedSearchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageLimitedSearchError";
	}
}

const CLAUDE_SEARCH_TOOL_CHOICE = { type: "tool", name: "web_search" };

function claudeSearchTool({ allowedDomains, blockedDomains }: DomainFilter) {
	return {
		type: "web_search_20250305",
		name: "web_search",
		max_uses: MAX_SEARCHES,
		...(allowedDomains && { allowed_domains: allowedDomains }),
		...(blockedDomains && { blocked_domains: blockedDomains }),
	};
}

/** The end of a hosted search: the model must have searched, then the links and text are cleaned and capped. */
function finishHosted(
	collected: Collected,
	payload: unknown,
	provider: string,
	secret: string,
	filter: DomainFilter,
	reasonField: "status" | "stop_reason",
): SearchResult {
	if (collected.searchCount === 0) {
		const reason = errorDetail(field(payload, reasonField), secret);
		throw new Error(`${provider} did not run its hosted web search tool${reason ? ` (${reason})` : ""}.`);
	}
	return finishSearch(collected, filter);
}

// The Codex hosted tool takes no domain lists, so the search model is told and its links are filtered after.
function codexDomainNote({ allowedDomains, blockedDomains }: DomainFilter): string {
	if (allowedDomains) return `\nOnly use results from these domains: ${allowedDomains.join(", ")}`;
	if (blockedDomains) return `\nNever use results from these domains: ${blockedDomains.join(", ")}`;
	return "";
}

async function readResponse(response: Response, provider: string, signal: AbortSignal): Promise<unknown> {
	const chunks: Uint8Array[] = [];
	const reader = response.body?.getReader();
	let size = 0;
	if (reader) {
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.length;
				if (size > MAX_RESPONSE_BYTES) break;
				chunks.push(chunk.value);
			}
		} catch {
			signal.throwIfAborted();
			throw new Error(`The local broker did not finish sending the ${provider} hosted web search response.`);
		} finally {
			if (size > MAX_RESPONSE_BYTES) void reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
	signal.throwIfAborted();
	if (size > MAX_RESPONSE_BYTES) throw new Error(`${provider} hosted web search exceeded the response size limit.`);
	try {
		return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
	} catch {
		// A non-JSON HTTP error is still reported by status without exposing its body.
		if (!response.ok) return undefined;
		throw new Error(`The local broker returned invalid JSON for ${provider} hosted web search.`);
	}
}

function readClaude(payload: unknown, brokerToken: string): Collected {
	const collected: Collected = { entries: [], text: "", searchCount: 0, titles: new Map() };
	for (const block of items(field(payload, "content"))) {
		const type = field(block, "type");
		if (type === "server_tool_use") {
			flushText(collected);
		} else if (type === "web_search_tool_result") {
			collected.searchCount++;
			const content = field(block, "content");
			if (Array.isArray(content)) {
				collected.entries.push({ raw: content.filter((result) => field(result, "type") === "web_search_result") });
			} else {
				const code = errorDetail(field(content, "error_code"), brokerToken) ?? "invalid result";
				collected.entries.push(`Web search error: ${code}`);
			}
		} else if (type === "text") {
			appendText(collected, field(block, "text"));
		}
	}
	flushText(collected);
	return collected;
}

function readCodex(payload: unknown, brokerToken: string): Collected {
	const collected: Collected = { entries: [], text: "", searchCount: 0, titles: new Map() };
	for (const item of items(field(payload, "output"))) {
		const type = field(item, "type");
		if (type === "web_search_call") {
			const action = field(item, "action");
			// Page opens and in-page finds are steps of one search, not new searches.
			if (field(action, "type") !== "search") continue;
			flushText(collected);
			collected.searchCount++;
			const status = field(item, "status");
			if (status === "completed") {
				collected.entries.push({ raw: items(field(action, "sources")).filter((s) => field(s, "type") === "url") });
			} else {
				collected.entries.push(`Web search error: ${errorDetail(status, brokerToken) ?? "unknown status"}`);
			}
		} else if (type === "message" && field(item, "phase") !== "commentary") {
			for (const block of items(field(item, "content"))) {
				if (field(block, "type") !== "output_text") continue;
				appendText(collected, field(block, "text"));
				// Codex sources carry no titles; the answer's citations do.
				for (const note of items(field(block, "annotations"))) {
					const url = field(note, "url");
					const title = field(note, "title");
					if (field(note, "type") === "url_citation" && typeof url === "string" && typeof title === "string") {
						collected.titles.set(url, title);
					}
				}
			}
		}
	}
	flushText(collected);
	return collected;
}

function appendText(collected: Collected, text: unknown): void {
	if (typeof text === "string") collected.text += text;
}

function flushText(collected: Collected): void {
	const text = collected.text.trim();
	if (text) collected.entries.push(text);
	collected.text = "";
}

function finishSearch(collected: Collected, filter: DomainFilter): SearchResult {
	const entries: SearchEntry[] = [];
	let textBudget = MAX_TEXT_LENGTH;
	let leftOut = 0;
	for (const entry of collected.entries) {
		if (typeof entry === "string") {
			if (textBudget <= 0) continue;
			entries.push(entry.length > textBudget ? `${entry.slice(0, textBudget - 1).trimEnd()}…` : entry);
			textBudget -= entry.length;
		} else {
			const links = cleanLinks(entry.raw, collected.titles);
			const kept = links.filter((link) => allowedByFilter(link.url, filter));
			leftOut += links.length - kept.length;
			entries.push({ links: kept });
		}
	}
	if (leftOut > 0) entries.push(`${leftOut} ${leftOut === 1 ? "result" : "results"} left out by the domain filter.`);
	return { entries, searchCount: collected.searchCount };
}

function cleanLinks(raw: readonly unknown[], titles: ReadonlyMap<string, string>): SearchLink[] {
	const links = new Map<string, SearchLink>();
	for (const source of raw) {
		const rawUrl = field(source, "url");
		if (typeof rawUrl !== "string" || rawUrl.length > MAX_URL_LENGTH) continue;
		const url = URL.parse(rawUrl);
		if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) continue;
		const href = url.href;
		if (href.length > MAX_URL_LENGTH) continue;
		url.hash = "";
		if (links.has(url.href)) continue;
		const rawTitle = field(source, "title") ?? titles.get(rawUrl);
		const title = typeof rawTitle === "string" ? rawTitle.replace(/[\s\p{Cc}]+/gu, " ").trim() : "";
		links.set(url.href, { title: (title || url.hostname).slice(0, MAX_TITLE_LENGTH), url: href });
		if (links.size === MAX_LINKS_PER_SEARCH) break;
	}
	return [...links.values()];
}

function allowedByFilter(href: string, { allowedDomains, blockedDomains }: DomainFilter): boolean {
	const host = new URL(href).hostname.toLowerCase();
	const matches = (domain: string) => {
		const name = domain.toLowerCase();
		return host === name || host.endsWith(`.${name}`);
	};
	if (allowedDomains) return allowedDomains.some(matches);
	if (blockedDomains) return !blockedDomains.some(matches);
	return true;
}

// Broker and provider responses are wire input; only read checked fields and arrays.
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && Object.hasOwn(value, key)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function items(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function errorDetail(value: unknown, brokerToken: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const redacted = brokerToken ? value.replaceAll(brokerToken, "[redacted]") : value;
	return (
		redacted
			.replace(/[\s\p{Cc}]+/gu, " ")
			.trim()
			.slice(0, 300) || undefined
	);
}
