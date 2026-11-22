import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Message,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
	type Tool,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { APP_NAME } from "../src/config.ts";
import {
	OMP_NATIVE_API,
	type OmpIdentity,
	type OmpIdentityLookup,
	ompNativeStreams,
} from "../src/extensions/accounts/omp-native.ts";
import { chunkedBody, ompTurn, sseResponse, sseText } from "./omp-native-test-utils.ts";

const routeBase = "http://127.0.0.1:4100/credne/v1/route/a.QWNjb3VudA";
const timestamp = 1_700_000_000_000;
const model: Model<Api> = {
	id: "claude-test-1",
	name: "Claude test",
	api: OMP_NATIVE_API,
	provider: "acct:claude-test",
	baseUrl: routeBase,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

interface PiNativeBody {
	modelId: string;
	context: { systemPrompt?: string[]; messages: Record<string, unknown>[]; tools?: Record<string, unknown>[] };
	options: Record<string, unknown>;
	stream: boolean;
}

interface Exchange {
	events: AssistantMessageEvent[];
	message: AssistantMessage;
	fetch: ReturnType<typeof vi.fn>;
	/** The first request the adapter sent. */
	sent: { url: string; method: string | undefined; headers: Headers; body: PiNativeBody };
}

const unidentified: OmpIdentityLookup = () => undefined;

/** Streams one request through the adapter against a fake broker route and collects everything it produced. */
async function exchange(
	respond: () => Response | Promise<Response>,
	context: Context,
	options: SimpleStreamOptions = {},
	requestModel: Model<Api> = model,
	identify: OmpIdentityLookup = unidentified,
): Promise<Exchange> {
	const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond());
	const stream = ompNativeStreams(identify).streamSimple(requestModel, normalizeContext(context), {
		apiKey: "broker-token",
		fetch,
		...options,
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const [url, init] = fetch.mock.calls[0] ?? [];
	return {
		events,
		message: await stream.result(),
		fetch,
		sent: {
			url: String(url),
			method: init?.method,
			headers: new Headers(init?.headers),
			body: init ? (JSON.parse(String(init.body)) as PiNativeBody) : (undefined as never),
		},
	};
}

const okResponse = () => sseResponse(ompTurn().start().text("ok").done("stop", { input: 1, output: 1 }).sse());
const hello: Message = { role: "user", content: "hi", timestamp };
const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: OMP_NATIVE_API,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage,
		stopReason: "stop",
		timestamp,
		...extra,
	};
}

const noObject = { type: "object", properties: {} };
function tool(name: string, extra: Partial<Tool> = {}): Tool {
	return { name, description: `The ${name} tool`, parameters: noObject, ...extra };
}

describe("omp-native request", () => {
	it("posts the pi-native request to the route's pi/stream path with the broker token", async () => {
		const { sent } = await exchange(okResponse, { systemPrompt: "Be brief.", messages: [hello] });

		expect(sent.url).toBe(`${routeBase}/pi/stream`);
		expect(sent.method).toBe("POST");
		expect(Object.fromEntries(sent.headers)).toEqual({
			accept: "text/event-stream",
			authorization: "Bearer broker-token",
			"content-type": "application/json",
			"x-omp-app": APP_NAME,
		});
		// The bare model ID: the broker resolves it on the route's account or pool.
		expect(sent.body).toMatchObject({
			modelId: "claude-test-1",
			stream: true,
			context: { systemPrompt: ["Be brief."], messages: [{ role: "user", content: "hi", timestamp }] },
		});
		expect(sent.body.context).not.toHaveProperty("tools");
	});

	it("does not double the slash of a base URL that ends with one", async () => {
		const { sent } = await exchange(okResponse, { messages: [hello] }, {}, { ...model, baseUrl: `${routeBase}/` });
		expect(sent.url).toBe(`${routeBase}/pi/stream`);
		expect(sent.body.context).not.toHaveProperty("systemPrompt");
	});

	it("folds later system messages into one prompt and one tool set", async () => {
		const context = {
			messages: [
				{
					role: "system",
					content: "Base rules.",
					sections: { rules: "<rules>Be brief.</rules>", stale: "<stale/>" },
					toolsAdded: [tool("read"), tool("grep")],
					timestamp: 0,
				},
				hello,
				{
					role: "system",
					content: "Extra rules.",
					sections: { rules: "<rules>Be terse.</rules>", stale: null },
					toolsAdded: [tool("bash")],
					toolsRemoved: [{ name: "grep" }],
					timestamp,
				},
				{ role: "user", content: "again", timestamp },
			],
		} satisfies Context;
		const { sent } = await exchange(okResponse, context);

		// The base prompt carries the later instructions; each section is a block, updated or removed by name.
		expect(sent.body.context.systemPrompt).toEqual(["Base rules.\n\nExtra rules.", "<rules>Be terse.</rules>"]);
		expect(sent.body.context.messages.map((message) => message.role)).toEqual(["user", "user"]);
		expect(sent.body.context.tools?.map((entry) => entry.name)).toEqual(["read", "bash"]);
	});

	it("maps strict and grammar-constrained tools to strict and customFormat", async () => {
		const tools: Tool[] = [
			tool("read", {
				parameters: Type.Object({ path: Type.String() }),
				constrainedSampling: { type: "json_schema", strict: "prefer" },
			}),
			tool("code", { constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } } }),
			tool("pattern", { constrainedSampling: { type: "grammar", variants: { openai_regex: "[a-z]+" } } }),
			tool("plain", { constrainedSampling: false }),
			tool("unset"),
		];
		const { sent } = await exchange(okResponse, { tools, messages: [hello] });

		expect(sent.body.context.tools).toEqual([
			{
				name: "read",
				description: "The read tool",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				strict: true,
			},
			{
				name: "code",
				description: "The code tool",
				parameters: noObject,
				customFormat: { syntax: "lark", definition: "start: /.+/" },
			},
			{
				name: "pattern",
				description: "The pattern tool",
				parameters: noObject,
				customFormat: { syntax: "regex", definition: "[a-z]+" },
			},
			{ name: "plain", description: "The plain tool", parameters: noObject },
			{ name: "unset", description: "The unset tool", parameters: noObject },
		]);
	});

	it("converts a multi-turn transcript with images, reasoning, tool calls and results", async () => {
		const image = { type: "image" as const, data: "aGk=", mimeType: "image/png" };
		const usage = {
			input: 10,
			output: 20,
			cacheRead: 5,
			cacheWrite: 7,
			cacheWrite1h: 3,
			reasoning: 4,
			totalTokens: 42,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, totalFromProvider: true },
		};
		const transcript: Message[] = [
			{ role: "user", content: [{ type: "text", text: "read a.txt" }, image], timestamp },
			assistant(
				[
					{ type: "thinking", thinking: "plan", thinkingSignature: "sig-A" },
					{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "enc-1", redacted: true },
					{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true },
					{ type: "text", text: "Reading it.", textSignature: "text-sig" },
					{
						type: "toolCall",
						id: "toolu_1",
						name: "read",
						arguments: { path: "a.txt" },
						thoughtSignature: "thought",
						namespace: "files",
						argumentsError: "not shown",
					},
				],
				{
					usage,
					stopReason: "toolUse",
					responseId: "msg_1",
					responseModel: "claude-test-1-20260101",
					providerThinkingLevel: "high",
					thinkingLevel: "high",
					durationMs: 900,
					rawStopReason: "tool_use",
					endTurn: false,
				},
			),
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "read",
				content: [{ type: "text", text: "contents" }, image],
				details: { path: "a.txt" },
				isError: true,
				timestamp,
				durationMs: 12,
			},
			{ role: "user", content: "thanks", timestamp },
		];
		const { sent } = await exchange(okResponse, { messages: transcript });

		expect(sent.body.context.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "read a.txt" }, image], timestamp },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "plan", thinkingSignature: "sig-A" },
					{ type: "redactedThinking", data: "enc-1" },
					{ type: "text", text: "Reading it.", textSignature: "text-sig" },
					{
						type: "toolCall",
						id: "toolu_1",
						name: "read",
						arguments: { path: "a.txt" },
						thoughtSignature: "thought",
						namespace: "files",
					},
				],
				// Pi's own identity: no oh-my-pi identity is known here.
				api: OMP_NATIVE_API,
				provider: "acct:claude-test",
				model: "claude-test-1",
				responseId: "msg_1",
				upstreamModel: "claude-test-1-20260101",
				usage: {
					input: 10,
					output: 20,
					cacheRead: 5,
					cacheWrite: 7,
					totalTokens: 42,
					reasoningTokens: 4,
					cttl: { ephemeral5m: 4, ephemeral1h: 3 },
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				},
				stopReason: "toolUse",
				timestamp,
			},
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "read",
				content: [{ type: "text", text: "contents" }, image],
				isError: true,
				timestamp,
			},
			{ role: "user", content: "thanks", timestamp },
		]);
	});

	describe("identity of earlier turns", () => {
		const anthropic: OmpIdentity = { provider: "anthropic", api: "anthropic-messages" };
		const known = new Map([
			["acct:claude-test/claude-test-1", anthropic],
			["pool:claude/claude-test-1", anthropic],
		]);
		const identify = vi.fn<OmpIdentityLookup>((piProvider, modelId) => known.get(`${piProvider}/${modelId}`));
		const signedTurn = (extra: Partial<AssistantMessage>) =>
			assistant(
				[
					{ type: "thinking", thinking: "plan", thinkingSignature: "sig-A" },
					{ type: "text", text: "Earlier answer." },
				],
				extra,
			);
		const sentTurn = async (turn: AssistantMessage, requestModel: Model<Api> = model) => {
			const { sent } = await exchange(okResponse, { messages: [hello, turn, hello] }, {}, requestModel, identify);
			return sent.body.context.messages[1] as { provider: string; api: string; model: string; content: unknown[] };
		};

		it.each(["acct:claude-test", "pool:claude"])(
			"sends oh-my-pi's provider and API with the bare model ID and the signed reasoning for a turn of %s",
			async (provider) => {
				const turn = await sentTurn(signedTurn({ provider }));
				expect(turn).toMatchObject({ provider: "anthropic", api: "anthropic-messages", model: "claude-test-1" });
				expect(turn.content).toContainEqual({ type: "thinking", thinking: "plan", thinkingSignature: "sig-A" });
			},
		);

		it("finds the identity of the turn's own provider, not the request's", async () => {
			const otherAccount: Model<Api> = { ...model, provider: "acct:claude-other" };
			const turn = await sentTurn(signedTurn({ provider: "acct:claude-test" }), otherAccount);
			expect(turn).toMatchObject({ provider: "anthropic", api: "anthropic-messages" });
			expect(identify).toHaveBeenCalledWith("acct:claude-test", "claude-test-1");
		});

		it.each([
			["a pool row serving the ID through different providers", { provider: "pool:all" }],
			["an unknown provider", { provider: "acct:gone" }],
			["a model the provider does not list", { provider: "acct:claude-test", model: "claude-removed" }],
		])("keeps Pi's identity for %s", async (_name, extra) => {
			const turn = await sentTurn(signedTurn(extra));
			expect(turn).toMatchObject({ provider: extra.provider, api: OMP_NATIVE_API });
		});

		it("leaves turns of other APIs alone without asking for their identity", async () => {
			identify.mockClear();
			const turn = await sentTurn(signedTurn({ provider: "acct:claude-test", api: "anthropic-messages" }));
			expect(turn).toMatchObject({ provider: "acct:claude-test", api: "anthropic-messages" });
			expect(identify).not.toHaveBeenCalled();
		});
	});

	it.each([
		["stop", "stop"],
		["length", "length"],
		["toolUse", "toolUse"],
		["error", "error"],
		["aborted", "aborted"],
		["pending", "stop"],
		["deferred", "stop"],
	] as const)("sends a recorded %s turn as %s", async (recorded, sent) => {
		const turn = assistant([{ type: "text", text: "earlier" }], { stopReason: recorded, errorMessage: "boom" });
		const { sent: request } = await exchange(okResponse, { messages: [hello, turn, hello] });
		expect(request.body.context.messages[1]).toMatchObject({ stopReason: sent, errorMessage: "boom" });
	});

	it("sends Pi's options in oh-my-pi's names and keeps connection-level options to itself", async () => {
		const signal = new AbortController().signal;
		const onResponse = vi.fn();
		const requestModel: Model<Api> = {
			...model,
			samplingParams: { min_p: 0.05, top_p: 0.5 },
			samplingParamsByThinkingLevel: { high: { top_p: 0.8, top_k: 20 } },
		};
		const { sent } = await exchange(
			okResponse,
			{ messages: [hello] },
			{
				reasoning: "high",
				maxTokens: 1000,
				temperature: 0.2,
				sessionId: "session-1",
				cacheRetention: "long",
				toolChoice: "none",
				thinkingBudgets: { high: 5000 },
				disableContinuation: true,
				maxRetryDelayMs: 5000,
				headers: { "x-extra": "1", "x-suppressed": null },
				metadata: { user_id: "u-1" },
				samplingParams: { top_p: 0.9, repetition_penalty: 1.1, frequency_penalty: "high", custom_knob: 3 },
				signal,
				onResponse,
				transport: "websocket",
				timeoutMs: 1,
				maxRetries: 4,
				websocketConnectTimeoutMs: 2,
				env: { SECRET: "x" },
			},
			requestModel,
		);

		expect(sent.body.options).toEqual({
			temperature: 0.2,
			// The model's, the thinking level's and the request's parameters merge, the request's last.
			minP: 0.05,
			topP: 0.9,
			topK: 20,
			repetitionPenalty: 1.1,
			maxTokens: 1000,
			reasoning: "high",
			thinkingBudgets: { high: 5000 },
			toolChoice: "none",
			sessionId: "session-1",
			cacheRetention: "long",
			statefulResponses: false,
			maxRetryDelayMs: 5000,
			headers: { "x-extra": "1" },
			metadata: { user_id: "u-1" },
		});
	});

	it("lets the sampling parameters override the temperature and fits the default output cap to the context", async () => {
		const requestModel: Model<Api> = { ...model, samplingParams: { temperature: 0.7 } };
		const { sent } = await exchange(okResponse, { messages: [hello] }, { temperature: 0.2 }, requestModel);
		expect(sent.body.options).toEqual({ temperature: 0.7, maxTokens: 64_000, sessionId: expect.any(String) });

		const small: Model<Api> = { ...model, contextWindow: 10_000, maxTokens: 64_000 };
		const capped = await exchange(okResponse, { messages: [hello] }, {}, small);
		expect(capped.sent.body.options.maxTokens).toBeLessThan(10_000);
	});

	it("always sends a session ID: Pi's when it has one, otherwise a fresh one per request", async () => {
		// The broker refuses a request without one. Compaction, summaries and classifier fallbacks pass none.
		const sessionIdOf = async (options: SimpleStreamOptions) =>
			(await exchange(okResponse, { messages: [hello] }, options)).sent.body.options.sessionId;

		expect(await sessionIdOf({ sessionId: "session-1" })).toBe("session-1");
		const first = await sessionIdOf({});
		const second = await sessionIdOf({});
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(second).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).not.toBe(first);
		// A blank ID is no ID: the broker would refuse it too.
		expect(await sessionIdOf({ sessionId: "  " })).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("lets onPayload inspect and replace the request body", async () => {
		const onPayload = vi.fn(async (payload: unknown) => ({ ...(payload as object), modelId: "replaced" }));
		const { sent } = await exchange(okResponse, { messages: [hello] }, { onPayload });

		expect(onPayload).toHaveBeenCalledWith(expect.objectContaining({ modelId: "claude-test-1" }), model);
		expect(sent.body.modelId).toBe("replaced");
	});

	it("fails without sending anything when the provider resolved no broker token", async () => {
		const { events, message, fetch } = await exchange(okResponse, { messages: [hello] }, { apiKey: undefined });
		expect(fetch).not.toHaveBeenCalled();
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(message).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("No broker token") });
	});
});

describe("omp-native response", () => {
	const turnWithEverything = () =>
		ompTurn()
			.start()
			.thinking("plan", "sig-A", ["pl", "an"])
			.text("Reading it.", ["Reading ", "it."], "text-sig")
			.toolCall("toolu_1", "read", { path: "a.txt" }, ['{"path":', '"a.txt"}'])
			.done(
				"toolUse",
				{
					input: 12,
					output: 20,
					cacheRead: 5,
					cacheWrite: 7,
					reasoningTokens: 4,
					cttl: { ephemeral5m: 4, ephemeral1h: 3 },
				},
				{ responseId: "msg_1", upstreamModel: "claude-test-1-20260101" },
			);

	it("turns oh-my-pi's events into Pi's, with indexes, signatures, usage, cost and stop reason", async () => {
		const { events, message } = await exchange(() => sseResponse(turnWithEverything().sse()), { messages: [hello] });

		expect(events.map((event) => [event.type, "contentIndex" in event ? event.contentIndex : undefined])).toEqual([
			["start", undefined],
			["thinking_start", 0],
			["thinking_delta", 0],
			["thinking_delta", 0],
			["thinking_end", 0],
			["text_start", 1],
			["text_delta", 1],
			["text_delta", 1],
			["text_end", 1],
			["toolcall_start", 2],
			["toolcall_delta", 2],
			["toolcall_delta", 2],
			["toolcall_end", 2],
			["done", undefined],
		]);
		expect(
			events.filter((event) => event.type.endsWith("_delta")).map((event) => (event as { delta: string }).delta),
		).toEqual(["pl", "an", "Reading ", "it.", '{"path":', '"a.txt"}']);
		const end = events.find((event) => event.type === "toolcall_end");
		expect(end).toMatchObject({
			toolCall: { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } },
		});

		// Pi's identity, not oh-my-pi's.
		expect(message).toMatchObject({
			role: "assistant",
			api: OMP_NATIVE_API,
			provider: "acct:claude-test",
			model: "claude-test-1",
			stopReason: "toolUse",
			responseId: "msg_1",
			responseModel: "claude-test-1-20260101",
		});
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "plan", thinkingSignature: "sig-A" },
			{ type: "text", text: "Reading it.", textSignature: "text-sig" },
			{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } },
		]);
		expect(message.usage).toMatchObject({
			input: 12,
			output: 20,
			cacheRead: 5,
			cacheWrite: 7,
			cacheWrite1h: 3,
			reasoning: 4,
			totalTokens: 44,
		});
		// Priced from Pi's entry (3 / 15 / 0.3 / 3.75 per million, 1h writes at twice the input price), not oh-my-pi's.
		expect(message.usage.cost.total).toBeCloseTo(0.0003705, 10);
		expect(message.usage.cost.totalFromProvider).toBe(false);
		// Every event shares the turn, which is the final message.
		const partials = events.flatMap((event) => ("partial" in event ? [event.partial] : []));
		expect(new Set(partials).size).toBe(1);
		expect(partials[0]).toBe(message);
	});

	it("takes the finished message as the record when oh-my-pi corrected the turn after streaming it", async () => {
		const turn = ompTurn()
			.start()
			.text("Hel", ["Hel"])
			.correct(0, { text: "Hello" })
			.done("stop", { input: 1, output: 1 });
		const { message } = await exchange(() => sseResponse(turn.sse()), { messages: [hello] });
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("decodes the same turn when every frame carries the turn as it ends, ahead of its event", async () => {
		const live = ompTurn({ live: true })
			.start()
			.thinking("plan", "sig-A")
			.redacted("enc-1")
			.text("Done.")
			.toolCall("toolu_1", "read", { path: "a.txt" });
		live.done("toolUse", { input: 1, output: 1 });
		const { events, message } = await exchange(() => sseResponse(live.sse()), { messages: [hello] });

		expect(events.map((event) => [event.type, "contentIndex" in event ? event.contentIndex : undefined])).toEqual([
			["start", undefined],
			["thinking_start", 0],
			["thinking_delta", 0],
			["thinking_end", 0],
			["thinking_start", 1],
			["thinking_end", 1],
			["text_start", 2],
			["text_delta", 2],
			["text_end", 2],
			["toolcall_start", 3],
			["toolcall_delta", 3],
			["toolcall_end", 3],
			["done", undefined],
		]);
		expect(message.content).toHaveLength(4);
	});

	it("shows redacted reasoning as a Pi redacted block and skips blocks Pi cannot show, keeping indexes aligned", async () => {
		const turn = ompTurn()
			.start()
			.redacted("enc-1")
			.foreign({ type: "anthropicServerTool", block: { type: "server_tool_use", id: "srv_1", name: "web_search" } })
			.text("Answer.")
			.done("stop", { input: 1, output: 1 });
		const { events, message } = await exchange(() => sseResponse(turn.sse()), { messages: [hello] });

		expect(events.map((event) => [event.type, "contentIndex" in event ? event.contentIndex : undefined])).toEqual([
			["start", undefined],
			["thinking_start", 0],
			["thinking_end", 0],
			["text_start", 1],
			["text_delta", 1],
			["text_end", 1],
			["done", undefined],
		]);
		expect(events[2]).toMatchObject({ type: "thinking_end", content: "[Reasoning redacted]" });
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "enc-1", redacted: true },
			{ type: "text", text: "Answer." },
		]);
	});

	it("ignores frames it does not know and generated images", async () => {
		const turn = ompTurn().start().text("ok");
		turn.frames.splice(
			1,
			0,
			{ type: "future_frame", contentIndex: 0 },
			{ type: "image_end", contentIndex: 3, content: {} },
		);
		turn.done("length", { input: 1, output: 1 });
		const { events, message } = await exchange(() => sseResponse(turn.sse()), { messages: [hello] });
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(message.stopReason).toBe("length");
	});

	it("does not trust a content index outside the turn", async () => {
		const turn = ompTurn().start().text("ok");
		turn.frames.push({ type: "text_delta", contentIndex: -1, delta: "x", partial: turn.partial });
		turn.frames.push({ type: "text_delta", contentIndex: "__proto__", delta: "x", partial: turn.partial });
		turn.frames.push({ type: "text_delta", contentIndex: 9, delta: "x", partial: turn.partial });
		turn.done("stop", { input: 1, output: 1 });
		const { message } = await exchange(() => sseResponse(turn.sse()), { messages: [hello] });
		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
	});

	it("reads frames split anywhere, CRLF line ends, keepalive comments and multi-line data", async () => {
		const turn = ompTurn().start().text("héllo ✓ wörld", ["héllo ", "✓ wörld"]).done("stop", { input: 1, output: 1 });
		const multiLine = 'data: {"type":\ndata: "start"}\n\n';
		const text = `: keepalive\n\n${multiLine}${sseText(turn.frames.slice(1))}: late keepalive\n\n`.replaceAll(
			"\n",
			"\r\n",
		);
		const { message } = await exchange(() => sseResponse(chunkedBody(text, 1)), { messages: [hello] });

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "héllo ✓ wörld" }]);
	});

	it("reports each response and wire frame to the caller's observers, response first", async () => {
		const order: string[] = [];
		const onResponse = vi.fn(() => {
			order.push("response");
		});
		const onProviderStreamEvent = vi.fn((frame: unknown) => {
			order.push((frame as { type: string }).type);
		});
		const respond = () =>
			sseResponse(ompTurn().start().text("a").done("stop", { input: 1, output: 1 }).sse(), {
				headers: { "x-credne-account": "QWNjb3VudA", "x-request-id": "req-1" },
			});
		await exchange(respond, { messages: [hello] }, { onResponse, onProviderStreamEvent });

		expect(onResponse).toHaveBeenCalledWith(
			{
				status: 200,
				headers: expect.objectContaining({ "x-credne-account": "QWNjb3VudA", "x-request-id": "req-1" }),
			},
			model,
		);
		expect(order).toEqual(["response", "start", "text_start", "text_delta", "text_end", "done"]);
	});

	describe("failures", () => {
		it("ends with the error event of a turn, keeping its content and the usage it reports", async () => {
			const turn = ompTurn()
				.start()
				.text("Partial", ["Par", "tial"])
				.error("error", "529 overloaded_error", { input: 7, output: 2 });
			const { events, message } = await exchange(() => sseResponse(turn.sse()), { messages: [hello] });

			expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
			expect(message).toMatchObject({ stopReason: "error", errorMessage: "529 overloaded_error" });
			expect(message.content).toEqual([{ type: "text", text: "Partial" }]);
			expect(message.usage).toMatchObject({ input: 7, output: 2 });
		});

		it("ends with oh-my-pi's aborted turn", async () => {
			const turn = ompTurn().start().text("Partial").error("aborted", "Request was aborted");
			const { events, message } = await exchange(() => sseResponse(turn.sse()), { messages: [hello] });
			expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
			expect(message.stopReason).toBe("aborted");
		});

		it("ends with the gateway's failure envelope, which carries no turn, after what arrived", async () => {
			const turn = ompTurn().start().text("Partial").failure("upstream connection reset");
			const { events, message } = await exchange(() => sseResponse(turn.sse()), { messages: [hello] });

			expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
			expect(message).toMatchObject({ stopReason: "error", errorMessage: "upstream connection reset" });
			expect(message.content).toEqual([{ type: "text", text: "Partial" }]);
		});

		it.each([
			{
				name: "oh-my-pi's error envelope",
				status: 429,
				statusText: "Too Many Requests",
				body: { error: { type: "rate_limit_error", message: "Claude · work is rate limited until 14:05" } },
				message: "429 Too Many Requests: Claude · work is rate limited until 14:05",
			},
			{
				name: "the broker's own error",
				status: 401,
				statusText: "Unauthorized",
				body: { error: "missing or invalid broker token" },
				message: "401 Unauthorized: missing or invalid broker token",
			},
			{
				name: "a body that is not JSON",
				status: 502,
				statusText: "Bad Gateway",
				body: "upstream down",
				message: "502 Bad Gateway: upstream down",
			},
		])("ends with an error that names the HTTP status for $name", async ({ status, statusText, body, message }) => {
			const onResponse = vi.fn();
			const respond = () =>
				new Response(typeof body === "string" ? body : JSON.stringify(body), {
					status,
					statusText,
					headers: { "x-credne-account": "QWNjb3VudA" },
				});
			const result = await exchange(respond, { messages: [hello] }, { onResponse });

			expect(result.events.map((event) => event.type)).toEqual(["error"]);
			expect(result.message).toMatchObject({ stopReason: "error", errorMessage: message, content: [] });
			expect(onResponse).toHaveBeenCalledWith(
				{ status, headers: expect.objectContaining({ "x-credne-account": "QWNjb3VudA" }) },
				model,
			);
		});

		it("ends with an error when the stream closes before a terminal event, with or without [DONE]", async () => {
			const frames = ompTurn().start().text("Partial").frames;
			for (const terminator of [true, false]) {
				const { message } = await exchange(() => sseResponse(sseText(frames, { terminator })), {
					messages: [hello],
				});
				expect(message).toMatchObject({
					stopReason: "error",
					errorMessage: expect.stringContaining("before a terminal event"),
				});
				expect(message.content).toEqual([{ type: "text", text: "Partial" }]);
			}
		});

		it("ends with an error for an event that is not JSON", async () => {
			const { message } = await exchange(() => sseResponse("data: {not json\n\n"), { messages: [hello] });
			expect(message).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("not JSON") });
		});

		it("ends an aborted request as aborted, with the content received so far", async () => {
			const controller = new AbortController();
			const frames = ompTurn().start().text("Partial").frames;
			const encoder = new TextEncoder();
			const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const signal = init?.signal as AbortSignal;
				return sseResponse(
					new ReadableStream<Uint8Array>({
						start(body) {
							body.enqueue(encoder.encode(sseText(frames, { terminator: false })));
							signal.addEventListener("abort", () => body.error(signal.reason), { once: true });
						},
					}),
				);
			});
			const stream = ompNativeStreams(unidentified).streamSimple(model, normalizeContext({ messages: [hello] }), {
				apiKey: "broker-token",
				fetch,
				signal: controller.signal,
			});
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) {
				events.push(event);
				if (event.type === "text_end") controller.abort();
			}

			expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
			const message = await stream.result();
			expect(message.stopReason).toBe("aborted");
			expect(message.content).toEqual([{ type: "text", text: "Partial" }]);
		});
	});
});
