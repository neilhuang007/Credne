import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { isVirtualModel } from "../../core/virtual-models.ts";
import {
	ACCOUNT_PROVIDER_PREFIX,
	ALL_POOL,
	accountProviderId,
	isLocalClaudeProvider,
	POOL_PROVIDER_PREFIX,
} from "../accounts/catalog.ts";
import type { BrokerClient } from "../accounts/client.ts";
import { createAccountBrokerClient } from "../accounts/index.ts";
import { latestServingProvider } from "../accounts/served.ts";
import { resolveModelTier } from "../subagent/model-tiers.ts";
import {
	type DomainFilter,
	type SearchEntry,
	type SearchResult,
	searchClaudeLocally,
	searchHosted,
	UsageLimitedSearchError,
} from "./hosted.ts";

const domainList = (description: string) =>
	Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 50, description }));

/**
 * Registers `web_search`, modeled on Claude Code's WebSearch tool. Claude searches run on a local Claude
 * subscription through the model registry; Codex searches run on a broker subscription. Either way the search
 * model is the light-tier model of the subscription that serves the search, whatever model the session uses.
 */
export default function webSearchExtension(pi: ExtensionAPI): void {
	const client = createAccountBrokerClient();
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description: describeWebSearch(new Date()),
		// Claude Code's WebSearch whenToUse and its system prompt addendum, without the search modes.
		promptGuidelines: [
			"When you are about to answer from memory on something recent or past your knowledge cutoff, use web_search and not memory alone.",
			"When you plan several web searches, send them in the same turn.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "The search query to use" }),
			allowed_domains: domainList("Only include search results from these domains"),
			blocked_domains: domainList("Never include search results from these domains"),
		}),
		async execute(_toolCallId, { query, allowed_domains, blocked_domains }, signal, _onUpdate, ctx) {
			const trimmed = query.trim();
			if (trimmed.length < 2 || trimmed.length > 4096) {
				throw new Error("Enter a search query between 2 and 4096 characters.");
			}
			const allowedDomains = allowed_domains?.length ? allowed_domains : undefined;
			const blockedDomains = blocked_domains?.length ? blocked_domains : undefined;
			if (allowedDomains && blockedDomains) {
				throw new Error("Cannot specify both allowed_domains and blocked_domains in the same request.");
			}
			const timeout = AbortSignal.timeout(120_000);
			const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const filter = { allowedDomains, blockedDomains };
			const local = await searchLocalClaude(ctx, trimmed, filter, deadline);
			if (local.type === "searched") return searchOutput("claude", local.model, trimmed, local.result);
			try {
				const { key, family, model } = await selectSubscription(client, ctx.model, deadline);
				const connection = await client.connect(deadline);
				const baseUrl = client.routeBaseUrl(connection, { type: "account", key });
				const result = await searchHosted(family, baseUrl, connection.token, model, trimmed, filter, deadline);
				return searchOutput(family, model, trimmed, result);
			} catch (error) {
				// The Claude subscriptions were all at their limit and no other subscription could take the search.
				throw local.type === "limited" ? local.error : error;
			}
		},
	});
}

function searchOutput(family: string, model: string, query: string, result: SearchResult) {
	return {
		content: [{ type: "text" as const, text: formatResults(query, result.entries) }],
		details: { family, model, query, searchCount: result.searchCount, entries: result.entries },
	};
}

type LocalSearch =
	| { type: "searched"; model: string; result: SearchResult }
	| { type: "limited"; error: UsageLimitedSearchError }
	| { type: "none" };

/**
 * Search on a local Claude subscription: the account the session is pinned to, or, under a Claude pool or any other
 * Claude selection, the accounts that offer the session's model, the one that answered last first. Each searches on
 * its light-tier model. An account at its usage limit passes the search to the next one.
 */
async function searchLocalClaude(
	ctx: ExtensionContext,
	query: string,
	filter: DomainFilter,
	signal: AbortSignal,
): Promise<LocalSearch> {
	let limited: UsageLimitedSearchError | undefined;
	for (const model of localClaudeModels(ctx)) {
		try {
			return {
				type: "searched",
				model: model.id,
				result: await searchClaudeLocally(ctx.modelRegistry, model, query, filter, signal),
			};
		} catch (error) {
			if (!(error instanceof UsageLimitedSearchError)) throw error;
			limited = error;
		}
	}
	return limited ? { type: "limited", error: limited } : { type: "none" };
}

/**
 * The models to search with, in the order to try them, one per local Claude subscription that offers the session's
 * model. Which subscriptions count follows the session; the model is the subscription's light-tier model, or the
 * session's model when the subscription serves no light-tier model.
 */
function localClaudeModels(ctx: ExtensionContext): Model<Api>[] {
	const active = ctx.model;
	if (!active || active.provider.startsWith(ACCOUNT_PROVIDER_PREFIX)) return [];
	if (!isLocalClaudeProvider(active.provider) && active.api !== "anthropic-messages" && !isVirtualModel(active))
		return [];
	const available = ctx.modelRegistry.getAvailable().filter((model) => isLocalClaudeProvider(model.provider));
	const offering = available.filter((model) => model.id === active.id);
	const pinned = isLocalClaudeProvider(active.provider);
	const served = pinned ? undefined : latestServingProvider(ctx.sessionManager.getBranch());
	// A session pinned to one subscription never searches on another.
	const eligible = pinned
		? offering.filter((model) => model.provider === active.provider)
		: offering.sort((left, right) => Number(right.provider === served) - Number(left.provider === served));
	return eligible.map((model) => lightTierOr(model, available));
}

/** The light-tier model of the subscription that serves `offered`, or `offered` itself when it serves none. */
function lightTierOr(offered: Model<Api>, available: readonly Model<Api>[]): Model<Api> {
	const subscriptionModels = available.filter((model) => model.provider === offered.provider);
	return resolveModelTier("light", subscriptionModels)?.model ?? offered;
}

// Claude Code's full WebSearch description with its Sources requirement. Not US-only: Codex search has no such limit.
function describeWebSearch(now: Date): string {
	const month = now.toLocaleString("en-US", { month: "long", year: "numeric" });
	return `- Allows you to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond your knowledge cutoff
- Searches are performed automatically within a single API call
- Send only a public search query, never private workspace data such as file contents, secrets or internal names

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - Domain filtering is supported to include or block specific websites, but not both in one call

IMPORTANT - Use the correct year in search queries:
  - The current month is ${month}. You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year`;
}

// Claude Code's WebSearch tool result text: each search's links as JSON, the search model's text, and a reminder.
function formatResults(query: string, entries: readonly SearchEntry[]): string {
	let text = `Web search results for query: "${query}"\n\n`;
	for (const entry of entries) {
		if (typeof entry === "string") text += `${entry}\n\n`;
		else if (entry.links.length > 0) text += `Links: ${JSON.stringify(entry.links)}\n\n`;
		else text += "No links found.\n\n";
	}
	text += "\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";
	return text.trim();
}

/**
 * The broker subscription to search on and its model. Which accounts count follows the session: an account must
 * offer the session's model, or, with no pinned account or pool, any model. The search model is the account's
 * light-tier model, or, when it serves none, the session's model (the account's first model if it lacks that one).
 */
async function selectSubscription(client: BrokerClient, active: Model<Api> | undefined, signal: AbortSignal) {
	const provider = active?.provider ?? "";
	const pinned = provider.startsWith(ACCOUNT_PROVIDER_PREFIX);
	const pool = provider.startsWith(POOL_PROVIDER_PREFIX) ? provider.slice(POOL_PROVIDER_PREFIX.length) : undefined;
	const preferred = active?.api === "anthropic-messages" ? "claude" : "codex";
	const accounts = (await client.listAccounts(signal)).filter(
		(account) =>
			account.kind === "oauth" &&
			!account.disabled &&
			!account.unavailable &&
			!account.quotaExceeded &&
			!(account.retryAfter && Date.parse(account.retryAfter) > Date.now()) &&
			(!pinned || accountProviderId(account.id) === provider) &&
			(!pool || pool === ALL_POOL || pool === account.provider),
	);
	accounts.sort((left, right) => Number(right.provider === preferred) - Number(left.provider === preferred));
	for (const account of accounts) {
		const family = account.provider;
		if (family !== "codex" && family !== "claude") continue;
		const models = await client.accountModels(account.key, signal);
		const current = models.find((model) => model.id === active?.id);
		const offered = current ?? (pinned || pool ? undefined : models[0]);
		if (!offered) continue;
		const model = resolveModelTier("light", models)?.model ?? offered;
		return { key: account.key, family, model: model.id } as const;
	}
	throw new Error(
		"No available Claude or ChatGPT subscription for this search. Use /accounts add claude-subscription or /accounts add codex, then select an available subscription model with /model.",
	);
}
