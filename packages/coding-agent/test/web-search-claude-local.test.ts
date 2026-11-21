import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createVirtualModel } from "../src/core/virtual-models.ts";
import webSearchExtension from "../src/extensions/web-search/index.ts";

// The broker is only asked for Codex searches. A test must never start it.
const broker = vi.hoisted(() => ({
	listAccounts: vi.fn(async (): Promise<never> => {
		throw new Error("The account broker is not installed.");
	}),
}));
vi.mock("../src/extensions/accounts/index.ts", () => ({ createAccountBrokerClient: () => broker }));

function model(provider: string, id: string, api: Api = "anthropic-messages"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

function reply(provider: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider,
		model: "claude-opus-4-8",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...extra,
	};
}

/** The raw events of a Messages stream with one hosted search: the server tool, its results, and the summary. */
const searchEvents = [
	{ type: "message_start", message: { id: "msg_1", content: [] } },
	{
		type: "content_block_start",
		index: 0,
		content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
	},
	{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"pi"}' } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "content_block_start",
		index: 1,
		content_block: {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_1",
			content: [
				{ type: "web_search_result", url: "https://example.com/a#top", title: "Example A", page_age: "1 day" },
				{ type: "web_search_result", url: "https://example.org/b", title: "Example B" },
			],
		},
	},
	{ type: "content_block_stop", index: 1 },
	{ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Summary " } },
	{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "of the results." } },
	{ type: "content_block_stop", index: 2 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" } },
];

interface Attempt {
	model: Model<Api>;
	payload: Record<string, unknown>;
}

/** A model registry whose streams replay `searchEvents`, or fail the way `fail(model)` says. */
function createContext(
	active: Model<Api>,
	available: Model<Api>[],
	options: { branch?: unknown[]; fail?: (model: Model<Api>) => AssistantMessage | undefined } = {},
) {
	const attempts: Attempt[] = [];
	const streamSimple = vi.fn(
		(
			target: Model<Api>,
			_context: unknown,
			streamOptions: {
				onPayload: (payload: unknown, model: Model<Api>) => Promise<unknown> | unknown;
				onProviderStreamEvent: (event: unknown, model: Model<Api>) => Promise<void> | void;
			},
		) => ({
			result: async () => {
				const built = {
					model: target.id,
					max_tokens: 4096,
					thinking: { type: "adaptive" },
					system: [],
					messages: [],
				};
				const sent = (await streamOptions.onPayload(built, target)) as Record<string, unknown>;
				attempts.push({ model: target, payload: sent });
				const failure = options.fail?.(target);
				if (failure) return failure;
				for (const event of searchEvents) await streamOptions.onProviderStreamEvent(event, target);
				return reply(target.provider);
			},
		}),
	);
	const ctx = {
		cwd: process.cwd(),
		model: active,
		modelRegistry: { getAvailable: () => available, streamSimple },
		sessionManager: { getBranch: () => options.branch ?? [] },
	} as unknown as ExtensionContext;
	return { ctx, attempts, streamSimple };
}

async function runSearch(ctx: ExtensionContext, params: Record<string, unknown> = { query: "pi coding agent" }) {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		webSearchExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"builtin:web-search",
	);
	const tool = extension.tools.get("web_search")!.definition;
	return tool.execute("call", params as never, undefined, undefined, ctx as never);
}

const answer = (provider: string, stopReason: "stop" | "error" = "stop") => ({
	type: "message",
	message: { role: "assistant", provider, stopReason },
});

const limitFailure = (provider: string) =>
	reply(provider, { stopReason: "error", errorMessage: '429 {"error":{"type":"rate_limit_error"}}' });

describe("web search on a local Claude subscription", () => {
	const opus = "claude-opus-4-8";
	const subA = model("claude-sub:a", opus);
	const subB = model("claude-sub:b", opus);

	it("runs the hosted search through the model registry and returns its links and summary", async () => {
		const { ctx, attempts } = createContext(subA, [subA, subB]);

		const result = await runSearch(ctx, { query: "pi coding agent", allowed_domains: ["example.com"] });

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain(
			'Links: [{"title":"Example A","url":"https://example.com/a#top"},{"title":"Example B","url":"https://example.org/b"}]',
		);
		expect(text).toContain("Summary of the results.");
		expect(result.details).toMatchObject({ family: "claude", model: opus, query: "pi coding agent", searchCount: 1 });
		// A session pinned to one subscription searches on that subscription only.
		expect(attempts.map((attempt) => attempt.model.provider)).toEqual(["claude-sub:a"]);
		// The model's own request gets the hosted tool, forced, and without thinking.
		expect(attempts[0]!.payload).toEqual({
			model: opus,
			max_tokens: 4096,
			system: [],
			messages: [],
			tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["example.com"] }],
			tool_choice: { type: "tool", name: "web_search" },
		});
		expect(broker.listAccounts).not.toHaveBeenCalled();
	});

	describe("search model", () => {
		const light = "claude-haiku-5-5";
		const subAHaiku = model("claude-sub:a", light);
		const subBHaiku = model("claude-sub:b", light);

		it("is the light-tier model of the subscription, not the session's model", async () => {
			const { ctx, attempts } = createContext(subA, [subA, subAHaiku, subB, subBHaiku]);

			const result = await runSearch(ctx);

			// A session pinned to one subscription searches on that subscription only.
			expect(attempts.map((attempt) => [attempt.model.provider, attempt.model.id])).toEqual([
				["claude-sub:a", light],
			]);
			expect(attempts[0]!.payload).toMatchObject({ model: light });
			expect(attempts[0]!.payload).not.toHaveProperty("thinking");
			expect(result.details).toMatchObject({ family: "claude", model: light });
		});

		it("falls back to the session's model on a subscription that serves no light-tier model", async () => {
			const { ctx, attempts } = createContext(subA, [subA, subB, subBHaiku]);

			const result = await runSearch(ctx);

			expect(attempts.map((attempt) => [attempt.model.provider, attempt.model.id])).toEqual([
				["claude-sub:a", opus],
			]);
			expect(result.details).toMatchObject({ model: opus });
		});

		it("is chosen per subscription under a pool, the one that answered last first", async () => {
			const pool = createVirtualModel({ provider: "pool:claude", id: opus, name: opus });
			const available = [subA, subAHaiku, subB];

			const lastOnB = createContext(pool, available, { branch: [answer("claude-sub:a"), answer("claude-sub:b")] });
			await runSearch(lastOnB.ctx);
			expect(lastOnB.attempts.map((attempt) => [attempt.model.provider, attempt.model.id])).toEqual([
				["claude-sub:b", opus],
			]);

			const lastOnA = createContext(pool, available, { branch: [answer("claude-sub:b"), answer("claude-sub:a")] });
			await runSearch(lastOnA.ctx);
			expect(lastOnA.attempts.map((attempt) => [attempt.model.provider, attempt.model.id])).toEqual([
				["claude-sub:a", light],
			]);
		});

		it("keeps the usage-limit fallthrough, each subscription on its own search model", async () => {
			const pool = createVirtualModel({ provider: "pool:all", id: opus, name: opus });
			const { ctx, attempts } = createContext(pool, [subA, subAHaiku, subB], {
				fail: (target) => (target.provider === "claude-sub:a" ? limitFailure(target.provider) : undefined),
			});

			const result = await runSearch(ctx);

			expect(attempts.map((attempt) => [attempt.model.provider, attempt.model.id])).toEqual([
				["claude-sub:a", light],
				["claude-sub:b", opus],
			]);
			expect(result.details).toMatchObject({ model: opus, searchCount: 1 });
		});

		it("does not use a subscription that serves the light-tier model but not the session's model", async () => {
			const pool = createVirtualModel({ provider: "pool:claude", id: opus, name: opus });
			const { ctx, attempts } = createContext(pool, [subA, subAHaiku, subBHaiku], {
				branch: [answer("claude-sub:b")],
				fail: (target) => limitFailure(target.provider),
			});

			await expect(runSearch(ctx)).rejects.toThrow("Claude hosted web search failed");

			expect(attempts.map((attempt) => [attempt.model.provider, attempt.model.id])).toEqual([
				["claude-sub:a", light],
			]);
		});
	});

	it("searches under a pool on the accounts that offer the model, the one that answered last first", async () => {
		const pool = createVirtualModel({ provider: "pool:claude", id: opus, name: opus });
		const haiku = model("claude-sub:a", "claude-haiku-4-5");
		const { ctx, attempts } = createContext(pool, [subA, subB, haiku], {
			branch: [answer("claude-sub:b"), answer("claude-sub:a", "error")],
		});

		await runSearch(ctx);

		expect(attempts.map((attempt) => attempt.model.provider)).toEqual(["claude-sub:b"]);
	});

	it("passes the search to the next account when one is at its usage limit", async () => {
		const pool = createVirtualModel({ provider: "pool:all", id: opus, name: opus });
		const { ctx, attempts } = createContext(pool, [subA, subB], {
			fail: (target) => (target.provider === "claude-sub:a" ? limitFailure(target.provider) : undefined),
		});

		const result = await runSearch(ctx);

		expect(attempts.map((attempt) => attempt.model.provider)).toEqual(["claude-sub:a", "claude-sub:b"]);
		expect(result.details).toMatchObject({ searchCount: 1 });
	});

	it("reports the usage limit when every Claude subscription is at it and the broker has nothing else", async () => {
		const pool = createVirtualModel({ provider: "pool:claude", id: opus, name: opus });
		const { ctx, attempts } = createContext(pool, [subA, subB], { fail: (target) => limitFailure(target.provider) });

		await expect(runSearch(ctx)).rejects.toThrow("Claude hosted web search failed");

		expect(attempts).toHaveLength(2);
		expect(broker.listAccounts).toHaveBeenCalled();
	});

	it("does not move to another account for a failure that is not a usage limit", async () => {
		const { ctx, attempts } = createContext(
			createVirtualModel({ provider: "pool:claude", id: opus, name: opus }),
			[subA, subB],
			{
				fail: (target) =>
					reply(target.provider, {
						stopReason: "error",
						errorMessage: '529 {"error":{"type":"overloaded_error"}}',
					}),
			},
		);

		await expect(runSearch(ctx)).rejects.toThrow("overloaded_error");

		expect(attempts).toHaveLength(1);
	});

	it("says when the model never ran its search tool", async () => {
		const { ctx, streamSimple } = createContext(subA, [subA]);
		streamSimple.mockImplementationOnce((_target, _context, streamOptions) => ({
			result: async () => {
				for (const event of searchEvents.filter((entry) => entry.index === 2 || entry.type === "message_delta")) {
					await streamOptions.onProviderStreamEvent(event, subA);
				}
				return reply("claude-sub:a");
			},
		}));

		await expect(runSearch(ctx)).rejects.toThrow("Claude did not run its hosted web search tool (end_turn).");
	});

	it("leaves Codex sessions and pinned broker accounts to the broker", async () => {
		const gpt = model("acct:codex-1", "gpt-5", "openai-responses");
		const { ctx, streamSimple } = createContext(gpt, [subA, gpt]);
		await expect(runSearch(ctx)).rejects.toThrow("The account broker is not installed.");
		expect(streamSimple).not.toHaveBeenCalled();

		const pinned = model("acct:claude-api-1", opus);
		const pinnedContext = createContext(pinned, [subA, pinned]);
		await expect(runSearch(pinnedContext.ctx)).rejects.toThrow("The account broker is not installed.");
		expect(pinnedContext.streamSimple).not.toHaveBeenCalled();
	});
});
