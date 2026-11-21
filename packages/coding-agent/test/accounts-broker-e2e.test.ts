// End-to-end: Pi's native adapters -> shared oh-my-pi daemon -> fake provider upstreams.
// Runs from packages/coding-agent when PI_ACCOUNTS_BROKER points at a compiled daemon:
//   (cd ../../broker && bun run build)
//   PI_ACCOUNTS_BROKER=../../broker/dist/credne-broker node ../../node_modules/vitest/dist/cli.js --run test/accounts-broker-e2e.test.ts
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClassifierContext, createModels, type Model } from "@earendil-works/pi-ai";
import { getBuiltinClassifierModel } from "@earendil-works/pi-ai/providers/all";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCatalog } from "../src/extensions/accounts/catalog.ts";
import { type BrokerAccount, BrokerClient } from "../src/extensions/accounts/client.ts";
import { type AccountProviderSpec, createAccountProvider, providerSpecs } from "../src/extensions/accounts/provider.ts";

const brokerBinary = process.env.PI_ACCOUNTS_BROKER;

const CLAUDE_SUBSCRIPTION_MODEL = "claude-sonnet-5";
const CLAUDE_SUBSCRIPTION_TOKEN = "sk-ant-oat01-fixture";
const CLAUDE_SUBSCRIPTION_FILE = "claude-fixture.json";

const DECISIONS_ANSWER = {
	model: "gpt-6-luna",
	answers: [{ type: "predicate", name: "needsReview", probability: 0.75 }],
	usage: { input_tokens: 40, output_tokens: 0 },
};

/** Fake Anthropic and OpenAI upstream: answers by API key, fails keys on demand, can hang. */
class FakeUpstream {
	readonly calls = new Map<string, number>();
	readonly failing = new Set<string>();
	readonly auth = new Map<string, string>();
	/** Decisions requests as the upstream saw them: the API key they carried and their body. */
	readonly decisions: { key: string; body: string }[] = [];
	readonly hangStarted = Promise.withResolvers<void>();
	hangClosed = false;
	readonly server: Server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const key = (request.headers["x-api-key"] as string | undefined) ?? request.headers.authorization?.slice(7) ?? "";
		this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
		this.auth.set(key, request.headers.authorization ?? "");
		if (this.failing.has(key)) {
			response.writeHead(429, { "content-type": "application/json", "retry-after": "3" });
			response.end(
				JSON.stringify({
					type: "error",
					error: { type: "rate_limit_error", message: `key ${key} is rate limited` },
				}),
			);
			return;
		}
		if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			const data = key.startsWith("sk-openai-")
				? [{ id: "gpt-6-luna" }]
				: [{ id: "claude-test-1", display_name: "Claude Test", max_tokens: 8192 }];
			response.end(JSON.stringify({ data }));
			return;
		}
		if (request.url === "/v1/decisions") {
			this.decisions.push({ key, body });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(DECISIONS_ANSWER));
			return;
		}
		if (body.includes("HANG")) {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.flushHeaders();
			this.hangStarted.resolve();
			response.on("close", () => {
				this.hangClosed = true;
			});
			return;
		}
		if (request.url?.includes("/v1/messages")) {
			const { model } = JSON.parse(body) as { model: string };
			this.anthropic(response, key, model);
		} else this.responses(response, key);
	});

	count(key: string): number {
		return this.calls.get(key) ?? 0;
	}

	private anthropic(response: ServerResponse, key: string, model: string): void {
		sse(response, [
			[
				"message_start",
				{
					type: "message_start",
					message: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						model,
						content: [],
						stop_reason: null,
						usage: { input_tokens: 12, output_tokens: 0 },
					},
				},
			],
			[
				"content_block_start",
				{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
			],
			[
				"content_block_delta",
				{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
			],
			[
				"content_block_delta",
				{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
			],
			["content_block_stop", { type: "content_block_stop", index: 0 }],
			["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
			[
				"content_block_delta",
				{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: `served by ${key}` } },
			],
			["content_block_stop", { type: "content_block_stop", index: 1 }],
			[
				"content_block_start",
				{
					type: "content_block_start",
					index: 2,
					content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
				},
			],
			[
				"content_block_delta",
				{
					type: "content_block_delta",
					index: 2,
					delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
				},
			],
			["content_block_stop", { type: "content_block_stop", index: 2 }],
			["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }],
			["message_stop", { type: "message_stop" }],
		]);
	}

	private responses(response: ServerResponse, key: string): void {
		const item = {
			id: "msg_1",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: `served by ${key}`, annotations: [] }],
		};
		sse(response, [
			[
				"response.created",
				{ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
			],
			[
				"response.output_item.added",
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...item, status: "in_progress", content: [] },
				},
			],
			[
				"response.content_part.added",
				{
					type: "response.content_part.added",
					item_id: "msg_1",
					output_index: 0,
					content_index: 0,
					part: { type: "output_text", text: "" },
				},
			],
			[
				"response.output_text.delta",
				{
					type: "response.output_text.delta",
					item_id: "msg_1",
					output_index: 0,
					content_index: 0,
					delta: `served by ${key}`,
				},
			],
			["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
			[
				"response.completed",
				{
					type: "response.completed",
					response: {
						id: "resp_1",
						status: "completed",
						output: [item],
						usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
					},
				},
			],
		]);
	}
}

function sse(response: ServerResponse, events: [string, unknown][]): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	response.end();
}

function user(text: string) {
	return { messages: [{ role: "user" as const, content: text, timestamp: Date.now() }] };
}

describe.skipIf(!brokerBinary)("account broker end to end", () => {
	const upstream = new FakeUpstream();
	const home = mkdtempSync(join(tmpdir(), "pi-broker-e2e-"));
	let client: BrokerClient;
	const models = createModels();
	const byKey = new Map<string, AccountProviderSpec>();
	let pool: AccountProviderSpec;
	let allPool: AccountProviderSpec;
	let openaiPool: AccountProviderSpec;
	let subscription: AccountProviderSpec;
	let luna: AccountProviderSpec;
	let accounts: BrokerAccount[];

	const first = (spec: AccountProviderSpec) => spec.models[0] as Model<"anthropic-messages">;
	const resetCooldowns = async () => {
		for (const account of await client.listAccounts()) await client.resetCooldown(account.key);
	};

	beforeAll(async () => {
		upstream.server.listen(0, "127.0.0.1");
		await once(upstream.server, "listening");
		const url = `http://127.0.0.1:${(upstream.server.address() as AddressInfo).port}`;
		client = new BrokerClient({
			home,
			locateBinary: () => brokerBinary,
			args: ["--idle-timeout", "2m", "--anthropic-base-url", url, "--openai-base-url", url],
		});
		const group = (name: string, key: string, model: string) =>
			`    - name: ${name}\n      base-url: ${url}\n      models:\n        - name: ${model}\n      keys:\n        - api-key: ${key}\n`;
		writeFileSync(
			join(home, "config.yaml"),
			`routing:\n  retry:\n    request-retry: 0\napi-keys:\n  claude:\n${group("work", "sk-ant-A", "claude-test-1")}${group("personal", "sk-ant-B", "claude-test-1")}  codex:\n${group("codex", "sk-codex-C", "gpt-test")}`,
		);
		// Seed a broker-owned subscription fixture. Browser sign-in is covered with a mock broker, not live OAuth.
		mkdirSync(join(home, "auths"));
		writeFileSync(
			join(home, "auths", CLAUDE_SUBSCRIPTION_FILE),
			JSON.stringify({
				type: "claude",
				access_token: CLAUDE_SUBSCRIPTION_TOKEN,
				refresh_token: "fixture-refresh",
				expired: new Date(Date.now() + 3_600_000).toISOString(),
				email: "fixture@example.com",
			}),
		);
		// An official-API key account, validated against the fake upstream's GET /v1/models.
		await client.addApiKey("direct", "sk-ant-D");
		// An OpenAI API key: it lists gpt-6-luna, so it serves the Decisions classifier.
		await client.addApiKey("luna", "sk-openai-luna", "openai");
		accounts = await client.listAccounts();
		const accountModels = new Map(
			await Promise.all(accounts.map(async (a) => [a.key, await client.accountModels(a.key)] as const)),
		);
		const builtinLuna = getBuiltinClassifierModel("openai", "gpt-6-luna");
		const specs = providerSpecs(
			buildCatalog(
				accounts,
				accountModels,
				() => undefined,
				(provider, id) => (provider === "openai" && id === builtinLuna.id ? builtinLuna : undefined),
			),
		);
		for (const spec of specs) models.setProvider(createAccountProvider(spec, client));
		subscription = specs.find((spec) => spec.id === "acct:claude-fixture")!;
		// Map the API-key providers to the key the upstream saw. The OpenAI key has no chat model here.
		for (const spec of specs.filter(
			(entry) => entry.target.type === "account" && entry.models.length > 0 && entry !== subscription,
		)) {
			const before = new Map(upstream.calls);
			await models.completeSimple(spec.models[0]!, user("probe"));
			const key = [...upstream.calls].find(([name, count]) => count !== before.get(name))?.[0];
			if (key) byKey.set(key, spec);
		}
		const pinned = specs.filter((spec) => spec.target.type === "account");
		luna = pinned.find((spec) => spec.classifiers !== undefined)!;
		pool = specs.find((spec) => spec.id === "pool:claude")!;
		allPool = specs.find((spec) => spec.id === "pool:all")!;
		openaiPool = specs.find((spec) => spec.id === "pool:openai")!;
	}, 60_000);

	afterAll(async () => {
		await client?.shutdown().catch(() => {});
		upstream.server.close();
		upstream.server.closeAllConnections();
		// Shutdown acknowledges before the broker closes its SQLite handles on Windows.
		rmSync(home, { recursive: true, force: true, maxRetries: 10 });
	});

	it("streams thinking, text, tool calls and usage natively through a pinned Claude account", async () => {
		const reply = await models.completeSimple(first(byKey.get("sk-ant-A")!), user("read a.txt"));
		expect(reply.stopReason).toBe("toolUse");
		expect(reply.content).toEqual([
			expect.objectContaining({ type: "thinking", thinking: "plan", thinkingSignature: "sig" }),
			expect.objectContaining({ type: "text", text: "served by sk-ant-A" }),
			expect.objectContaining({ type: "toolCall", name: "read", arguments: { path: "a.txt" } }),
		]);
		expect(reply.usage).toMatchObject({ input: 12, output: 20 });
	});

	it("streams a Claude subscription through the pinned and Claude pool routes", async () => {
		expect(accounts.find((account) => account.id === CLAUDE_SUBSCRIPTION_FILE)).toMatchObject({
			provider: "claude",
			kind: "oauth",
			email: "fixture@example.com",
		});
		for (const spec of [subscription, pool]) {
			const model = spec.models.find((entry) => entry.id === CLAUDE_SUBSCRIPTION_MODEL)!;
			const reply = await models.completeSimple(model, user("hi"));
			expect(reply.content).toContainEqual(
				expect.objectContaining({
					type: "text",
					text: `served by ${CLAUDE_SUBSCRIPTION_TOKEN}`,
				}),
			);
		}
		expect(upstream.auth.get(CLAUDE_SUBSCRIPTION_TOKEN)).toBe(`Bearer ${CLAUDE_SUBSCRIPTION_TOKEN}`);
		expect(JSON.parse(readFileSync(join(home, "auths", CLAUDE_SUBSCRIPTION_FILE), "utf8"))).toMatchObject({
			access_token: CLAUDE_SUBSCRIPTION_TOKEN,
		});
	});

	it("streams the Responses protocol through a Codex account", async () => {
		const reply = await models.completeSimple(byKey.get("sk-codex-C")!.models[0]!, user("hi"));
		expect(reply).toMatchObject({
			stopReason: "stop",
			content: [expect.objectContaining({ text: "served by sk-codex-C" })],
		});
	});

	it("reports a pinned account failure and never falls back", async () => {
		upstream.failing.add("sk-ant-B");
		const before = upstream.count("sk-ant-A");
		const reply = await models.completeSimple(first(byKey.get("sk-ant-B")!), user("hi"), { maxRetries: 0 });
		upstream.failing.delete("sk-ant-B");
		await resetCooldowns();
		expect(reply.stopReason).toBe("error");
		expect(upstream.count("sk-ant-A")).toBe(before);
	});

	it("fails a pool over to a healthy account", async () => {
		upstream.failing.add("sk-ant-A");
		upstream.failing.add("sk-ant-D");
		const reply = await models.completeSimple(pool.models.find((model) => model.id === "claude-test-1")!, user("hi"));
		upstream.failing.delete("sk-ant-A");
		upstream.failing.delete("sk-ant-D");
		await resetCooldowns();
		expect(reply.content).toContainEqual(expect.objectContaining({ type: "text", text: "served by sk-ant-B" }));
	});

	it("serves a newly added Anthropic API key through the daemon", async () => {
		const spec = byKey.get("sk-ant-D")!;
		expect(spec.models.map((model) => model.id)).toEqual(["claude-test-1"]);
		const reply = await models.completeSimple(first(spec), user("hi"));
		expect(reply.content).toContainEqual(expect.objectContaining({ type: "text", text: "served by sk-ant-D" }));
	});

	it("routes Claude and GPT models through one pool:all provider", async () => {
		const expected = ["claude-test-1", "gpt-test", CLAUDE_SUBSCRIPTION_MODEL];
		expect(
			allPool.models
				.filter((model) => expected.includes(model.id))
				.map((model) => [model.id, model.api])
				.sort(),
		).toEqual([
			[CLAUDE_SUBSCRIPTION_MODEL, "anthropic-messages"],
			["claude-test-1", "anthropic-messages"],
			["gpt-test", "openai-responses"],
		]);
		const claude = await models.completeSimple(allPool.models.find((m) => m.id === "claude-test-1")!, user("hi"));
		expect(claude.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringMatching(/^served by sk-ant-[ABD]$/) }),
		);
		const gpt = await models.completeSimple(allPool.models.find((m) => m.id === "gpt-test")!, user("hi"));
		expect(gpt).toMatchObject({
			stopReason: "stop",
			content: [expect.objectContaining({ text: "served by sk-codex-C" })],
		});
	});

	it("cancels the upstream request when Pi aborts", async () => {
		const abort = new AbortController();
		const pending = models.completeSimple(first(byKey.get("sk-ant-A")!), user("HANG"), { signal: abort.signal });
		await upstream.hangStarted.promise;
		abort.abort();
		expect((await pending).stopReason).toBe("aborted");
		await expect.poll(() => upstream.hangClosed, { timeout: 5_000 }).toBe(true);
	});

	it("classifies through the pinned and pool Decisions routes with the OpenAI API key", async () => {
		expect(byKey.get("sk-codex-C")!.classifiers).toBeUndefined();
		const context: ClassifierContext = {
			state: { diff: "rename a variable" },
			questions: {
				needsReview: { type: "bool", instructions: "Does it need review?", criteria: { true: "", false: "" } },
			},
		};
		for (const spec of [luna, openaiPool]) {
			const result = await models.classify(spec.classifiers![0]!, context);
			expect(result.stopReason, `${spec.id}: ${result.errorMessage}`).toBe("stop");
			expect(result.answers).toMatchObject({ needsReview: { type: "bool", probability: 0.75 } });
		}
		expect(upstream.decisions.map((request) => request.key)).toEqual(["sk-openai-luna", "sk-openai-luna"]);
		for (const request of upstream.decisions) {
			expect(JSON.parse(request.body)).toMatchObject({ model: "gpt-6-luna" });
		}
	});
});
