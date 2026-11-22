// Hosted web search on a Claude or ChatGPT subscription, sent by oh-my-pi's own search providers (omp-search/).
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { normalizeAnthropicBaseUrl } from "@oh-my-pi/pi-ai/providers/anthropic-state";
import { type Account, HttpError } from "./accounts.ts";
import { searchAnthropic } from "./omp-search/anthropic.ts";
import type { SearchParams } from "./omp-search/base.ts";
import { searchCodex } from "./omp-search/codex.ts";
import webSearchSystemPrompt from "./omp-search/prompts/web-search.md" with { type: "text" };
import { accountRegistry } from "./omp-search/registry.ts";
import { DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS, SearchProviderError, type SearchResponse } from "./omp-search/types.ts";
import { object, text } from "./wire.ts";

/**
 * One search as the harness asks for it. `query` uses OMP's query syntax (`site:` and `-site:` select domains), and
 * `sessionId` is the chat session's id, which OMP binds Claude's request metadata to.
 */
export interface SearchRequest {
	modelId: string;
	sessionId: string;
	query: string;
}

/** Reads a search request body (wire input). */
export async function readSearchRequest(request: Request): Promise<SearchRequest> {
	let body: Record<string, unknown>;
	try {
		body = object(await request.json());
	} catch {
		throw new HttpError(400, "Invalid JSON body.");
	}
	const modelId = text(body.modelId);
	const sessionId = text(body.sessionId);
	const query = text(body.query)?.trim();
	if (!modelId || !sessionId || !query) throw new HttpError(400, "modelId, sessionId and query are required");
	return { modelId, sessionId, query };
}

/**
 * The models OMP's hosted search tries for a session model, in order: the model's catalog web-search swap on the same
 * account (Claude Haiku 4.5, GPT-6 Luna), then the session model itself. Only Claude and Codex grounding run here.
 * This is OMP's `expandHostedCandidate` (web/search/index.ts) over one account's models.
 */
export function searchModels(account: Account, sessionModel: Model<Api>): Model<Api>[] {
	const swap = account.models.find((model) => model.id === sessionModel.webSearchModel);
	const distinctSwap = swap && swap.id !== sessionModel.id ? swap : undefined;
	return [distinctSwap, sessionModel].filter(
		(model): model is Model<Api> => model?.webSearch === "anthropic" || model?.webSearch === "codex",
	);
}

/**
 * Runs the search on `model` exactly as OMP's web_search would with the account signed in: same provider function,
 * system prompt, timeout and credential handling. A model that answered without sources did not search, which OMP
 * also rejects.
 */
export async function searchOnModel(
	account: Account,
	model: Model<Api>,
	search: SearchRequest,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const params: SearchParams = {
		query: search.query,
		systemPrompt: webSearchSystemPrompt,
		signal,
		timeoutMs: DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1_000,
		authStorage: account.storage,
		// The broker stores Anthropic's base with `/v1`; OMP's catalog model, which its search reads, has none.
		model: model.webSearch === "anthropic" ? { ...model, baseUrl: normalizeAnthropicBaseUrl(model.baseUrl)! } : model,
		modelRegistry: accountRegistry(account.storage),
		sessionId: search.sessionId,
	};
	const response = model.webSearch === "anthropic" ? await searchAnthropic(params) : await searchCodex(params);
	if (response.sources.length === 0 && !response.citations?.length) {
		throw new SearchProviderError(
			model.webSearch === "anthropic" ? "anthropic" : "codex",
			`${model.id} returned no sources; it may not support hosted web search.`,
			502,
		);
	}
	return response;
}
