// Fake providers and a pi-native client for the broker's route tests.
import { spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthCredential, FetchImpl } from "@oh-my-pi/pi-ai";
import { type Account, type AccountRecord, Accounts, accountKey } from "../src/accounts.ts";
import { Gateway } from "../src/gateway.ts";
import { object } from "../src/wire.ts";

export interface UpstreamCall {
	path: string;
	headers: Headers;
	/** The request body as text; gzip is undone, as a provider would. */
	body: string;
	bytes: Uint8Array;
}

/** The credential a call carried: an Anthropic API key, or any bearer token. */
export const callToken = (call: UpstreamCall): string =>
	call.headers.get("x-api-key") ?? call.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

const sseFrame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** An Anthropic Messages stream that says `text`, then calls `tool` when one is given. */
export function anthropicReply(text = "Done.", tool?: { id: string; name: string; input: unknown }): Response {
	const message = {
		id: "msg_test",
		type: "message",
		role: "assistant",
		model: "claude-test",
		content: [],
		usage: { input_tokens: 4, output_tokens: 0 },
	};
	const frames: [string, unknown][] = [
		["message_start", { type: "message_start", message }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
	];
	if (tool) {
		frames.push(
			[
				"content_block_start",
				{
					type: "content_block_start",
					index: 1,
					content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
				},
			],
			[
				"content_block_delta",
				{
					type: "content_block_delta",
					index: 1,
					delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
				},
			],
			["content_block_stop", { type: "content_block_stop", index: 1 }],
		);
	}
	frames.push(
		[
			"message_delta",
			{ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } },
		],
		["message_stop", { type: "message_stop" }],
	);
	return new Response(frames.map(([event, data]) => sseFrame(event, data)).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

/** An OpenAI Responses stream that says `text`. */
export function responsesReply(model: string, text = "Done"): Response {
	const part = { type: "output_text", text, annotations: [] };
	const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [part] };
	const frames = [
		{ type: "response.created", response: { id: "resp_1", model, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
		{
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			item_id: item.id,
			part: { ...part, text: "" },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				model,
				status: "completed",
				output: [item],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
	return new Response(frames.map((frame) => sseFrame(frame.type, frame)).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

/** A provider's error answer. */
export const refusal = (status: number, message: string, headers: HeadersInit = {}): Response =>
	Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status, headers });

/** A fake provider on a loopback port that records every call, in order. */
export function fakeUpstream(respond: (call: UpstreamCall) => Response | Promise<Response>) {
	const calls: UpstreamCall[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const bytes = new Uint8Array(await request.arrayBuffer());
			const raw = request.headers.get("content-encoding") === "gzip" ? Bun.gunzipSync(bytes) : bytes;
			const call: UpstreamCall = {
				path: new URL(request.url).pathname,
				headers: request.headers,
				body: new TextDecoder().decode(raw),
				bytes,
			};
			calls.push(call);
			return respond(call);
		},
	});
	return { calls, server, origin: server.url.origin };
}

/** A pi-native request body as OMP's own client builds it. */
export function piBody(modelId: string, sessionId?: string, extra: Record<string, unknown> = {}): string {
	const { context, options, ...rest } = extra;
	return JSON.stringify({
		modelId,
		context: {
			systemPrompt: ["You are terse."],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			...object(context),
		},
		options: { maxTokens: 64, ...(sessionId === undefined ? {} : { sessionId }), ...object(options) },
		stream: true,
		...rest,
	});
}

/** The headers OMP's pi-native client sends to a gateway, with the caller's broker token. */
export const piHeaders = (token: string, extra: HeadersInit = {}): Headers =>
	new Headers({
		"content-type": "application/json",
		accept: "text/event-stream",
		"x-omp-install-id": "install-1",
		"x-omp-hostname": "test-host",
		"x-omp-app": "credne",
		authorization: `Bearer ${token}`,
		...extra,
	});

export interface PiEvent {
	type: string;
	[key: string]: unknown;
}

/** The events of a pi-native stream, up to its terminal `done` marker. */
export async function piEvents(response: Response): Promise<PiEvent[]> {
	const events: PiEvent[] = [];
	for (const frame of (await response.text()).split("\n\n")) {
		const data = frame
			.split("\n")
			.find((line) => line.startsWith("data:"))
			?.slice(5)
			.trim();
		if (data && data !== "[DONE]") events.push(JSON.parse(data));
	}
	return events;
}

/** The assistant text of a finished pi-native stream. */
export function piText(events: PiEvent[]): string {
	const end = events.find((event) => event.type === "done");
	const content = ((object(end?.message).content ?? []) as unknown[]).map(object);
	return content.map((block) => (block.type === "text" ? String(block.text) : "")).join("");
}

/**
 * Replaces the network for every host but loopback, so no test reaches a real provider. OMP reads usage and
 * refreshes tokens through the global fetch; `respond` answers those requests (default: not found).
 */
export function fakeNetwork(
	respond: (request: Request) => Response | Promise<Response> = () => new Response(null, { status: 404 }),
) {
	const realFetch = globalThis.fetch;
	const network: { fetch: FetchImpl } = globalThis;
	const external: string[] = [];
	const spy = spyOn(network, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
		external.push(url.href);
		return respond(new Request(input, init));
	});
	return { external, restore: () => spy.mockRestore() };
}

export interface Harness {
	home: string;
	accounts: Accounts;
	gateway: Gateway;
	/** Every URL OMP asked of a host other than the fake provider, in order. */
	external: string[];
	/** Adds an account serving `models`; its credential is an API key or an OAuth access token. */
	add(
		id: string,
		provider: AccountRecord["provider"],
		credential: AuthCredential,
		models: string[],
		extra?: Partial<AccountRecord>,
	): Promise<Account>;
	/** Sends a pi-native request to a target (`a.<key>` or `p.<pool>`) as the harness would. */
	send(target: string, body: string, headers?: HeadersInit): Promise<Response>;
	close(): Promise<void>;
}

/** Accounts and a gateway over a temporary home, with the fake provider's origin as every base URL. */
export async function harness(
	origin: string,
	respond?: (request: Request) => Response | Promise<Response>,
): Promise<Harness> {
	const network = fakeNetwork(respond);
	const home = await mkdtemp(join(tmpdir(), "credne-gateway-"));
	const accounts = new Accounts({ home, anthropicBaseUrl: origin, openaiBaseUrl: origin, typesafeBaseUrl: origin });
	await accounts.load();
	const gateway = new Gateway(accounts, 0);
	return {
		home,
		accounts,
		gateway,
		external: network.external,
		add: (id, provider, credential, models, extra) =>
			accounts.register(
				{
					id,
					name: id,
					provider,
					kind: credential.type === "oauth" ? "oauth" : "api-key",
					models,
					createdAt: "",
					...extra,
				},
				credential,
			),
		send: (target, body, headers) =>
			gateway.execute(
				new Request("http://gateway-test", { method: "POST", headers: piHeaders("broker-token", headers), body }),
				target,
				"/pi/stream",
			),
		async close() {
			gateway.close();
			accounts.close();
			network.restore();
			await rm(home, { recursive: true, force: true });
		},
	};
}

export const apiKey = (key: string): AuthCredential => ({ type: "api_key", key, source: "login" });

export const subscription = (access: string, email = `${access}@test.invalid`): AuthCredential => ({
	type: "oauth",
	access,
	refresh: "fixture-refresh",
	email,
	accountId: `${access}-account`,
	orgId: `${access}-org`,
	expires: Date.now() + 3600000,
});

export { accountKey };
