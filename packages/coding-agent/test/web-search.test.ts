// Covers the web_search tool: which subscription it asks the broker to search on, and what the model receives.
import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type * as brokerClient from "../src/extensions/accounts/client.ts";
import type { BrokerAccount, BrokerModel } from "../src/extensions/accounts/client.ts";
import webSearchExtension from "../src/extensions/web-search/index.ts";

// No test reaches a real broker: the client is a fake and `fetchBroker` records the request it would send.
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

const found = {
	provider: "anthropic",
	model: "claude-haiku-4-5",
	answer: "Node 26 is the active LTS.",
	sources: [
		{ title: "Node.js releases", url: "https://nodejs.org/en/about/releases", publishedDate: "2 days ago" },
		{ title: "not a link", url: "javascript:alert(1)" },
	],
};

function account(id: string, provider: string, kind: BrokerAccount["kind"] = "oauth"): BrokerAccount {
	return {
		id,
		key: `key-${id}`,
		provider,
		kind,
		source: "test",
		status: "active",
		disabled: false,
		unavailable: false,
		quotaExceeded: false,
		modelCount: 0,
	};
}

const served = (...ids: string[]): BrokerModel[] => ids.map((id) => ({ id, thinking: true }));

function session(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "omp-native",
		provider,
		baseUrl: "http://127.0.0.1/credne-broker",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

async function runSearch(
	active: Model<Api>,
	accounts: BrokerAccount[],
	models: Record<string, BrokerModel[]>,
	args: Record<string, unknown> = { query: "node lts" },
) {
	broker.listAccounts.mockResolvedValue(accounts);
	broker.accountModels.mockImplementation(async (key: string) => models[key] ?? []);
	const ctx = {
		cwd: process.cwd(),
		model: active,
		sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
	} as unknown as ExtensionContext;
	const extension = await loadExtensionFromFactory(
		webSearchExtension,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"builtin:web-search",
	);
	const tool = extension.tools.get("web_search")!.definition;
	return tool.execute("call", args as never, undefined, undefined, ctx as never);
}

type BrokerCall = [url: string, options: { body: string; headers: Record<string, string> }];

const sent = () =>
	(fetchBroker.mock.calls as BrokerCall[]).map(([url, options]) => ({
		url,
		authorization: options.headers.authorization,
		body: JSON.parse(options.body) as { modelId: string; sessionId: string; query: string },
	}));

beforeEach(() => {
	fetchBroker.mockReset();
	fetchBroker.mockImplementation(async () => Response.json(found));
});

describe("web_search on a broker subscription", () => {
	it("asks the pool's subscription to search with the session model and session, never an API key", async () => {
		const result = await runSearch(
			session("pool:all", "claude-opus-5-5"),
			[account("key", "claude-api", "api-key"), account("plan", "claude")],
			{ "key-key": served("claude-opus-5-5"), "key-plan": served("claude-opus-5-5") },
		);
		expect(sent()).toEqual([
			{
				url: "http://127.0.0.1:1234/credne/v1/route/a.key-plan/search",
				authorization: "Bearer broker-token",
				body: { modelId: "claude-opus-5-5", sessionId: "session-1", query: "node lts" },
			},
		]);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Node 26 is the active LTS.");
		expect(text).toContain("1. [Node.js releases](https://nodejs.org/en/about/releases) (2 days ago)");
		expect(text).not.toContain("javascript:");
	});

	it("sends domain filters as oh-my-pi site: directives", async () => {
		await runSearch(
			session("pool:codex", "gpt-6-sol"),
			[account("plan", "codex")],
			{ "key-plan": served("gpt-6-sol") },
			{
				query: "release notes",
				blocked_domains: ["reddit.com", "x.com"],
			},
		);
		expect(sent()[0]!.body.query).toBe("release notes -site:reddit.com -site:x.com");
	});

	it("tries the next subscription after a usage limit and searches only on a pinned account", async () => {
		fetchBroker.mockImplementationOnce(async () =>
			Response.json({ error: { message: "account a: usage limit" } }, { status: 429 }),
		);
		const models = { "key-a": served("gpt-6-sol"), "key-b": served("gpt-6-sol") };
		await runSearch(session("pool:all", "gpt-6-sol"), [account("a", "codex"), account("b", "codex")], models);
		expect(sent().map((request) => request.url.split("/").at(-2))).toEqual(["a.key-a", "a.key-b"]);

		fetchBroker.mockClear();
		await runSearch(session("acct:b", "gpt-6-sol"), [account("a", "codex"), account("b", "codex")], models);
		expect(sent().map((request) => request.url.split("/").at(-2))).toEqual(["a.key-b"]);
	});

	it("reports a missing subscription and a broker refusal", async () => {
		await expect(
			runSearch(session("pool:all", "gpt-6-sol"), [account("key", "openai-api", "api-key")], {
				"key-key": served("gpt-6-sol"),
			}),
		).rejects.toThrow("No available Claude or ChatGPT subscription");
		fetchBroker.mockImplementation(async () =>
			Response.json({ error: { message: "gpt-6-sol has no hosted web search." } }, { status: 400 }),
		);
		await expect(
			runSearch(session("pool:codex", "gpt-6-sol"), [account("plan", "codex")], { "key-plan": served("gpt-6-sol") }),
		).rejects.toThrow("gpt-6-sol has no hosted web search.");
	});
});
