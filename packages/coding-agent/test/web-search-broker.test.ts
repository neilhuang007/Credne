// Covers the search model of a broker subscription: its light-tier model, else the session's model.
import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type * as brokerClient from "../src/extensions/accounts/client.ts";
import type { BrokerAccount, BrokerModel } from "../src/extensions/accounts/client.ts";
import { ACCOUNT_HEADER } from "../src/extensions/accounts/provider.ts";
import webSearchExtension from "../src/extensions/web-search/index.ts";

// No test reaches a real broker or provider: the client is a fake and `fetchBroker` records the request it would send.
const broker = vi.hoisted(() => ({
	listAccounts: vi.fn(),
	accountModels: vi.fn(),
	connect: vi.fn(async () => ({ url: "http://127.0.0.1:1234", token: "broker-token", pid: 1 })),
	routeBaseUrl: (_connection: unknown, target: { key: string }) =>
		`http://127.0.0.1:1234/credne/v1/route/a.${target.key}`,
}));
const fetchBroker = vi.hoisted(() => vi.fn());
vi.mock("../src/extensions/accounts/index.ts", () => ({ createAccountBrokerClient: () => broker }));
vi.mock("../src/extensions/accounts/client.ts", async (importOriginal) => ({
	...(await importOriginal<typeof brokerClient>()),
	fetchBroker,
}));

const codexReply = {
	output: [
		{
			type: "web_search_call",
			status: "completed",
			action: { type: "search", sources: [{ type: "url", url: "https://example.com/a" }] },
		},
		{ type: "message", content: [{ type: "output_text", text: "Summary of the results.", annotations: [] }] },
	],
};

const claudeReply = {
	content: [
		{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
		{
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_1",
			content: [{ type: "web_search_result", url: "https://example.com/a", title: "Example A" }],
		},
		{ type: "text", text: "Summary of the results." },
	],
	stop_reason: "end_turn",
};

function account(id: string, provider: "codex" | "claude"): BrokerAccount {
	return {
		id,
		key: `key-${id}`,
		provider,
		kind: "oauth",
		source: "test",
		status: "active",
		disabled: false,
		unavailable: false,
		quotaExceeded: false,
		modelCount: 0,
	};
}

const served = (...ids: string[]): BrokerModel[] => ids.map((id) => ({ id, thinking: true }));

function session(provider: string, id: string, api: Api): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "http://127.0.0.1/credne-broker",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

/** Runs one search for a session on `active`, with the broker's accounts and what each account serves. */
async function runSearch(
	active: Model<Api>,
	accounts: BrokerAccount[],
	models: Record<string, BrokerModel[]>,
	options: { servedKey?: string; branch?: unknown[] } = {},
) {
	broker.listAccounts.mockResolvedValue(accounts);
	broker.accountModels.mockImplementation(async (key: string) => models[key] ?? []);
	const ctx = {
		cwd: process.cwd(),
		model: active,
		sessionManager: { getSessionId: () => "search-test", getBranch: () => options.branch ?? [] },
		modelRegistry: {
			streamSimple: () => {
				throw new Error("Hosted web search must never use the agent stream.");
			},
		},
	} as unknown as ExtensionContext;
	const extension = await loadExtensionFromFactory(
		webSearchExtension,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"builtin:web-search",
	);
	if (options.servedKey) {
		const emit = async <T extends { type: string }>(event: T) => {
			for (const handler of extension.handlers.get(event.type) ?? []) await handler(event, ctx);
		};
		await emit({ type: "before_provider_request", payload: {} } as const);
		await emit({
			type: "after_provider_response",
			status: 200,
			headers: { [ACCOUNT_HEADER]: options.servedKey },
		} as const);
		await emit({ type: "provider_stream_event", provider: active.provider, model: active.id, data: {} } as const);
	}
	const tool = extension.tools.get("web_search")!.definition;
	return tool.execute("call", { query: "pi coding agent" } as never, undefined, undefined, ctx as never);
}

function sentRequest(): { url: string; model: string } {
	const [url, options] = fetchBroker.mock.calls[0] as [string, { body: string }];
	return { url, model: JSON.parse(options.body).model };
}

describe("web search on a broker subscription", () => {
	const codexSession = session("acct:codex-1", "gpt-6.2-sol", "openai-responses");
	const codex = account("codex-1", "codex");

	beforeEach(() => {
		fetchBroker.mockReset();
		fetchBroker.mockImplementation(async () => new Response(JSON.stringify(codexReply), { status: 200 }));
	});

	it("searches on the light-tier model of the account, not the session's model", async () => {
		const result = await runSearch(codexSession, [codex], { [codex.key]: served("gpt-6.2-sol", "gpt-6-luna") });

		expect(sentRequest()).toEqual({
			url: `http://127.0.0.1:1234/credne/v1/route/a.${codex.key}/responses`,
			model: "gpt-6-luna",
		});
		expect(result.details).toMatchObject({ family: "codex", model: "gpt-6-luna", searchCount: 1 });
	});

	it("falls back to the session's model when the account serves no light-tier model", async () => {
		const result = await runSearch(codexSession, [codex], { [codex.key]: served("gpt-6.2-sol", "gpt-6.1-terra") });

		expect(sentRequest().model).toBe("gpt-6.2-sol");
		expect(result.details).toMatchObject({ model: "gpt-6.2-sol" });
	});

	it("does not use a pinned account that serves the light-tier model but not the session's model", async () => {
		await expect(runSearch(codexSession, [codex], { [codex.key]: served("gpt-6-luna") })).rejects.toThrow(
			"No available Claude or ChatGPT subscription",
		);

		expect(fetchBroker).not.toHaveBeenCalled();
	});

	it("searches on the light-tier model of a Claude account served by the broker", async () => {
		const claude = account("claude-api-1", "claude");
		fetchBroker.mockImplementation(async () => new Response(JSON.stringify(claudeReply), { status: 200 }));

		const result = await runSearch(session("acct:claude-api-1", "claude-opus-5-5", "anthropic-messages"), [claude], {
			[claude.key]: served("claude-opus-5-5", "claude-haiku-5-5"),
		});

		expect(sentRequest()).toEqual({
			url: `http://127.0.0.1:1234/credne/v1/route/a.${claude.key}/v1/messages`,
			model: "claude-haiku-5-5",
		});
		expect(result.details).toMatchObject({ family: "claude", model: "claude-haiku-5-5" });
	});

	it("starts on the Claude subscription that served the pool and tries the next on a usage limit", async () => {
		const first = account("claude-1", "claude");
		const second = account("claude-2", "claude");
		const opus = "claude-opus-5-5";
		fetchBroker.mockResolvedValueOnce(Response.json({ error: { message: "Usage limit" } }, { status: 429 }));
		fetchBroker.mockResolvedValueOnce(Response.json(claudeReply));

		const result = await runSearch(
			session("pool:claude", opus, "anthropic-messages"),
			[second, first],
			{ [first.key]: served(opus, "claude-haiku-5-5"), [second.key]: served(opus) },
			{ servedKey: first.key },
		);

		expect(fetchBroker.mock.calls.map(([url]) => url)).toEqual(
			[first, second].map(({ key }) => `http://127.0.0.1:1234/credne/v1/route/a.${key}/v1/messages`),
		);
		expect(result.details).toMatchObject({ family: "claude", model: opus, searchCount: 1 });
	});

	it("does not prefer a paid account even when it answered most recently", async () => {
		const paid = { ...account("claude-api", "claude"), kind: "api-key" as const };
		const subscription = account("claude-1", "claude");
		const opus = "claude-opus-5-5";
		fetchBroker.mockResolvedValueOnce(Response.json(claudeReply));
		await runSearch(
			session("pool:claude", opus, "anthropic-messages"),
			[paid, subscription],
			{ [paid.key]: served(opus), [subscription.key]: served(opus) },
			{ servedKey: paid.key },
		);
		expect(sentRequest().url).toContain(`/route/a.${subscription.key}/`);
	});

	it.each([
		["matching preceding pool selection", "pool:claude", "acct:claude-2", "key-claude-2"],
		["answer from a different selection", "acct:claude-2", "acct:claude-2", "key-claude-1"],
		["answer without a pinned account", "pool:claude", "pool:claude", "key-claude-1"],
	])("restores pool affinity only with explicit evidence: %s", async (_label, previous, reply, expected) => {
		const first = account("claude-1", "claude");
		const second = account("claude-2", "claude");
		const opus = "claude-opus-5-5";
		fetchBroker.mockResolvedValueOnce(Response.json(claudeReply));
		await runSearch(
			session("pool:claude", opus, "anthropic-messages"),
			[first, second],
			{ [first.key]: served(opus), [second.key]: served(opus) },
			{
				branch: [
					{ type: "model_change", provider: previous, modelId: opus },
					{ type: "message", message: { role: "assistant", model: opus, provider: reply, stopReason: "stop" } },
				],
			},
		);
		expect(sentRequest().url).toContain(`/route/a.${expected}/`);
	});
});
