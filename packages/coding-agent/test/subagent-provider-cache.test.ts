// Exercises worker caching against the serialized requests produced by the real API adapters.
import { zstdDecompressSync } from "node:zlib";
import { type Api, type Model, normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as anthropicStream } from "../../ai/src/api/anthropic-messages.ts";
import { stream as azureStream } from "../../ai/src/api/azure-openai-responses.ts";
import { stream as codexStream } from "../../ai/src/api/openai-codex-responses.ts";
import { stream as openaiStream } from "../../ai/src/api/openai-responses.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { renderParentConversation } from "../src/extensions/subagent/parent-conversation.ts";
import { registerWorkerCache } from "../src/extensions/subagent/worker-cache.ts";
import type { WorkerRequest } from "../src/extensions/subagent/worker-channel.ts";

interface WireBlock {
	type: string;
	text?: string;
	cache_control?: { type: string; ttl?: string };
}

interface WirePayload {
	system?: WireBlock[];
	tools?: Array<{ name: string; cache_control?: unknown }>;
	messages?: Array<{ role: string; content: string | WireBlock[] }>;
	input?: unknown[];
	prompt_cache_key?: string;
	prompt_cache_options?: Record<string, unknown>;
	cache_control?: unknown;
}

type Hook = (event: never, ctx: ExtensionContext) => unknown;

function model<T extends Api>(api: T, provider = "test"): Model<T> {
	return {
		id: api === "anthropic-messages" ? "claude-opus-5-5" : "gpt-6.1-sol",
		api,
		provider,
		name: "Cache test",
		baseUrl: "https://provider.invalid/v1",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 100,
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
	};
}

function worker(selected: Model<Api>, options: { cwd?: string; effort?: string; name?: string } = {}) {
	vi.stubEnv("PI_SUBAGENT_WORKER_ID", "worker");
	vi.stubEnv("PI_SUBAGENT_AGENT_NAME", options.name ?? "worker");
	const hooks = new Map<string, Hook>();
	const requests: WorkerRequest[] = [];
	const ctx = {
		model: selected,
		cwd: options.cwd ?? "project",
		thinkingLevel: options.effort ?? "high",
	} as ExtensionContext;
	registerWorkerCache(
		{ on: (name: string, handler: Hook) => hooks.set(name, handler) } as unknown as ExtensionAPI,
		async (request) => {
			requests.push(request);
		},
	);
	return {
		requests,
		payload: async (payload: unknown) => hooks.get("before_provider_request")?.({ payload } as never, ctx),
		event: async (data: unknown): Promise<void> => {
			await hooks.get("provider_stream_event")?.(
				{
					data,
					api: selected.api,
					provider: selected.provider,
					model: selected.id,
				} as never,
				ctx,
			);
		},
	};
}

const reference = renderParentConversation([{ role: "user", content: "Keep the API stable.", timestamp: 0 }]);

function context(task = "Implement the endpoint.", conversation: string | undefined = reference): TranscriptContext {
	return normalizeContext({
		systemPrompt: "Worker instructions.\n<cwd>project</cwd>",
		tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
		messages: [
			{
				role: "user",
				timestamp: 0,
				content: [
					...(conversation ? [{ type: "text" as const, text: conversation }] : []),
					{ type: "text", text: task },
				],
			},
		],
	});
}

function sse(events: Array<{ type: string } & Record<string, unknown>>): Response {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function response(api: Api): Response {
	if (api === "anthropic-messages")
		return sse([
			{
				type: "message_start",
				message: {
					id: "reply",
					model: "claude-opus-5-5",
					usage: {
						input_tokens: 10,
						output_tokens: 0,
						cache_read_input_tokens: 90,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
			{ type: "message_stop" },
		]);
	return sse([
		{
			type: "response.completed",
			response: {
				id: "reply",
				status: "completed",
				output: [],
				usage: {
					input_tokens: 100,
					output_tokens: 2,
					total_tokens: 102,
					input_tokens_details: { cached_tokens: 90 },
				},
			},
		},
	]);
}

function transport(api: Api) {
	const captured: Array<{ body: WirePayload; headers: Headers }> = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const bytes = Buffer.from(await request.arrayBuffer());
		const text =
			request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes).toString() : bytes.toString();
		captured.push({ body: JSON.parse(text) as WirePayload, headers: request.headers });
		return response(api);
	};
	return { captured, fetch };
}

function codexToken(): string {
	return `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.test`;
}

afterEach(() => vi.unstubAllEnvs());

describe("worker Anthropic cache payloads", () => {
	it.each(["anthropic", "claude-sub:1a2b3c4d", "pool:claude", "pool:all", "acct:work", "pool:codex"])(
		"marks both reusable boundaries through %s",
		async (provider) => {
			const selected = model("anthropic-messages", provider);
			const child = worker(selected);
			const wire = transport(selected.api);
			const result = await anthropicStream(selected, context(), {
				apiKey: "test-key",
				sessionId: "unique-worker-session",
				fetch: wire.fetch,
				onPayload: child.payload,
				onProviderStreamEvent: child.event,
				maxRetries: 0,
			}).result();
			const payload = wire.captured[0].body;
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(payload.system?.at(-1)).toEqual({
				type: "text",
				text: "Worker instructions.\n<cwd>project</cwd>",
				cache_control: { type: "ephemeral" },
			});
			expect(payload.messages?.[0].content).toEqual([
				{ type: "text", text: reference, cache_control: { type: "ephemeral" } },
				{ type: "text", text: "Implement the endpoint.", cache_control: { type: "ephemeral" } },
			]);
			expect(payload.tools?.[0].cache_control).toEqual({ type: "ephemeral" });
			expect(payload.prompt_cache_options).toBeUndefined();
			expect(child.requests.map((request) => request.type)).toEqual(["cache_wait", "cache_ready"]);
			expect(result.usage).toMatchObject({ input: 10, cacheRead: 90, cacheWrite: 0, totalTokens: 102 });
		},
	);

	it("preserves system instructions and fits OAuth conversation markers in four slots", async () => {
		const selected = model("anthropic-messages", "anthropic");
		const child = worker(selected);
		const wire = transport(selected.api);
		await anthropicStream(selected, context(), {
			apiKey: "sk-ant-oat-test",
			fetch: wire.fetch,
			cacheRetention: "long",
			maxRetries: 0,
			onPayload: async (payload) =>
				child.payload({ ...(payload as WirePayload), cache_control: { type: "ephemeral", ttl: "1h" } }),
		}).result();
		const payload = wire.captured[0].body;
		expect(payload.system).toContainEqual({
			type: "text",
			text: "Worker instructions.\n<cwd>project</cwd>",
			cache_control: { type: "ephemeral", ttl: "1h" },
		});
		expect(payload.system?.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(payload.tools?.[0].cache_control).toBeUndefined();
		expect(JSON.stringify(payload).match(/"cache_control":/g)!.length).toBeLessThanOrEqual(4);
	});

	it.each(["anthropic", "claude-sub:1a2b3c4d", "acct:work"])(
		"honors cacheRetention none through %s",
		async (provider) => {
			const selected = model("anthropic-messages", provider);
			const child = worker(selected);
			const wire = transport(selected.api);
			await anthropicStream(selected, context(), {
				apiKey: "key",
				cacheRetention: "none",
				fetch: wire.fetch,
				onPayload: child.payload,
				maxRetries: 0,
			}).result();
			expect(JSON.stringify(wire.captured[0].body)).not.toContain('"cache_control"');
			expect(wire.captured[0].body.prompt_cache_options).toBeUndefined();
			expect(child.requests).toHaveLength(0);
		},
	);

	it("keeps the reference checkpoint on later growing requests", async () => {
		const selected = model("anthropic-messages");
		const child = worker(selected);
		const wire = transport(selected.api);
		const initial = context();
		const options = {
			apiKey: "key",
			fetch: wire.fetch,
			onPayload: child.payload,
			onProviderStreamEvent: child.event,
			maxRetries: 0,
		};
		const reply = await anthropicStream(selected, initial, options).result();
		await anthropicStream(
			selected,
			normalizeContext({
				messages: [...initial.messages, reply, { role: "user", content: "Continue.", timestamp: 1 }],
			}),
			options,
		).result();
		const payload = wire.captured[1].body;
		expect(payload.messages?.[0].content).toEqual([
			{ type: "text", text: reference, cache_control: { type: "ephemeral" } },
			{ type: "text", text: "Implement the endpoint." },
		]);
		expect(payload.messages?.at(-1)?.content).toEqual([
			{ type: "text", text: "Continue.", cache_control: { type: "ephemeral" } },
		]);
		expect(child.requests.map((request) => request.type)).toEqual(["cache_wait", "cache_ready"]);
	});
});

describe("worker OpenAI cache payloads", () => {
	it.each(["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const)(
		"shares the system key across tasks and checkpoints in %s while keeping request IDs separate",
		async (api) => {
			const keys: Array<string | undefined> = [];
			for (const [sessionId, conversation] of [
				["worker-one", reference],
				["worker-two", reference],
				["worker-later", `${reference} Later checkpoint.`],
				["worker-fresh", ""],
			]) {
				const selected = model(api);
				const child = worker(selected);
				const wire = transport(api);
				const options = {
					apiKey: api === "openai-codex-responses" ? codexToken() : "sk-test",
					sessionId,
					fetch: wire.fetch,
					onPayload: child.payload,
					onProviderStreamEvent: child.event,
					transport: "sse" as const,
					maxRetries: 0,
				};
				const result =
					api === "openai-responses"
						? await openaiStream(
								selected as Model<"openai-responses">,
								context(sessionId, conversation),
								options,
							).result()
						: api === "azure-openai-responses"
							? await azureStream(
									selected as Model<"azure-openai-responses">,
									context(sessionId, conversation),
									options,
								).result()
							: await codexStream(
									selected as Model<"openai-codex-responses">,
									context(sessionId, conversation),
									options,
								).result();
				expect(result.stopReason, result.errorMessage).toBe("stop");
				const { body, headers } = wire.captured[0];
				keys.push(body.prompt_cache_key);
				if (api !== "azure-openai-responses") {
					expect(headers.get("session-id")).toBe(body.prompt_cache_key);
					expect(headers.get("x-client-request-id")).toBe(sessionId);
				}
				expect(result.usage).toMatchObject({ input: 10, cacheRead: 90, cacheWrite: 0 });
			}
			expect(keys[0]).toMatch(/^subagent-[a-f0-9]{48}$/);
			expect(new Set(keys).size).toBe(1);
		},
	);

	it.each(["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const)(
		"honors cacheRetention none in %s",
		async (api) => {
			const selected = model(api);
			const child = worker(selected);
			const wire = transport(api);
			const options = {
				apiKey: api === "openai-codex-responses" ? codexToken() : "sk-test",
				sessionId: "session",
				cacheRetention: "none" as const,
				fetch: wire.fetch,
				onPayload: child.payload,
				transport: "sse" as const,
				maxRetries: 0,
			};
			if (api === "openai-responses")
				await openaiStream(selected as Model<"openai-responses">, context(), options).result();
			else if (api === "azure-openai-responses")
				await azureStream(selected as Model<"azure-openai-responses">, context(), options).result();
			else await codexStream(selected as Model<"openai-codex-responses">, context(), options).result();
			const { body, headers } = wire.captured[0];
			expect(body.prompt_cache_key).toBeUndefined();
			if (api !== "azure-openai-responses") {
				expect(headers.has("session-id")).toBe(false);
				expect(headers.has("x-client-request-id")).toBe(false);
			}
			expect(child.requests).toHaveLength(0);
		},
	);
});

describe("worker cache admission identity and readiness", () => {
	const payload = (task = "one", conversation = reference) => ({
		model: "gpt-6.1-sol",
		prompt_cache_key: "random-session",
		tools: [{ name: "read" }],
		reasoning: { effort: "high" },
		input: [
			{ role: "developer", content: "worker system" },
			{
				role: "user",
				content: [
					{ type: "input_text", text: conversation },
					{ type: "input_text", text: task },
				],
			},
		],
	});

	it("shares exact cutoff keys and system keys without a session or task dependency", async () => {
		const first = worker(model("openai-responses"));
		const second = worker(model("openai-responses"));
		const third = worker(model("openai-responses"));
		const firstPayload = await first.payload(payload("one"));
		const secondPayload = await second.payload({ ...payload("two"), prompt_cache_key: "different-session" });
		const thirdPayload = await third.payload(payload("three", `${reference} extra`));
		expect(firstPayload).toEqual({ ...payload("one"), prompt_cache_key: expect.stringMatching(/^subagent-/) });
		const routingKey = (firstPayload as { prompt_cache_key: string }).prompt_cache_key;
		expect(secondPayload).toEqual({ ...payload("two"), prompt_cache_key: routingKey });
		expect(thirdPayload).toEqual({ ...payload("three", `${reference} extra`), prompt_cache_key: routingKey });
		expect(first.requests[0]).toEqual(second.requests[0]);
		expect(third.requests[0]).toMatchObject({
			sharedKey: "sharedKey" in first.requests[0] ? first.requests[0].sharedKey : undefined,
		});
		expect(third.requests[0]).not.toEqual(first.requests[0]);
	});

	it("shares identical prefixes across profile aliases", async () => {
		const first = worker(model("openai-responses"), { name: "worker" });
		const firstPayload = await first.payload(payload());
		const second = worker(model("openai-responses"), { name: "custom-worker" });
		expect(await second.payload(payload())).toEqual(firstPayload);
		expect(second.requests).toEqual(first.requests);
	});

	it.each(["provider", "model", "effort", "cwd", "tools", "system"])("separates a changed %s", async (field) => {
		const first = worker(model("openai-responses"));
		await first.payload(payload());
		const selected = model("openai-responses", field === "provider" ? "acct:other" : "test");
		if (field === "model") selected.id = "other-model";
		const second = worker(selected, {
			cwd: field === "cwd" ? "other-project" : undefined,
			effort: field === "effort" ? "xhigh" : undefined,
		});
		const next = payload();
		if (field === "tools") next.tools = [{ name: "bash" }];
		if (field === "system") next.input[0].content = "other instructions";
		await second.payload(next);
		expect(second.requests[0]).not.toEqual(first.requests[0]);
	});

	it("does not mistake OpenAI transport acceptance for a prefetched prompt", async () => {
		const child = worker(model("openai-responses"));
		await child.payload(payload());
		for (const type of ["start", "response.created", "response.in_progress", "response.output_item.added"])
			await child.event({ type });
		expect(child.requests).toHaveLength(1);
		await child.event({ type: "response.reasoning_summary_text.delta", delta: "thinking" });
		await child.event({ type: "response.completed", response: { status: "completed" } });
		expect(child.requests.map((request) => request.type)).toEqual(["cache_wait", "cache_ready"]);
	});

	it("reacquires admission when a prestream retry changes the actual prefix", async () => {
		const child = worker(model("openai-responses"));
		await child.payload(payload());
		await child.payload({ ...payload(), tools: [{ name: "strict-fallback" }] });
		expect(child.requests).toHaveLength(2);
		expect(child.requests[0]).not.toEqual(child.requests[1]);
		await child.event({ type: "response.completed", response: { status: "completed" } });
		expect(child.requests[2]).toMatchObject({
			type: "cache_ready",
			key: "key" in child.requests[1] ? child.requests[1].key : undefined,
		});
	});
});
