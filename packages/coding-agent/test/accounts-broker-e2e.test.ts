// End-to-end: Pi's native adapters -> real credne-broker -> CLIProxyAPI executors and the broker's
// official-API executor -> fake provider upstreams. Runs only when PI_ACCOUNTS_BROKER points at a built broker binary:
//   cd broker && go build -o /tmp/credne-broker ./cmd/credne-broker
//   PI_ACCOUNTS_BROKER=/tmp/credne-broker node ../node_modules/vitest/dist/cli.js --run test/accounts-broker-e2e.test.ts
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClassifierContext, createModels, type Model } from "@earendil-works/pi-ai";
import { getBuiltinClassifierModel } from "@earendil-works/pi-ai/providers/all";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCatalog } from "../src/extensions/accounts/catalog.ts";
import { type BrokerAccount, BrokerClient } from "../src/extensions/accounts/client.ts";
import {
	type AccountProviderSpec,
	type BrokerProviderSpec,
	createAccountProvider,
	providerSpecs,
} from "../src/extensions/accounts/provider.ts";

const brokerBinary = process.env.PI_ACCOUNTS_BROKER;

/**
 * The broker still balances pool:claude and pool:all. The extension serves them as virtual models instead, so the
 * catalog no longer lists them and this test builds the broker pools from the accounts itself.
 */
function brokerPool(name: string, members: readonly BrokerProviderSpec[]): BrokerProviderSpec {
	const models = new Map<string, BrokerProviderSpec["models"][number]>();
	for (const member of members) {
		for (const model of member.models) {
			if (!models.has(model.id)) models.set(model.id, { ...model, provider: `pool:${name}` });
		}
	}
	return {
		id: `pool:${name}`,
		name,
		target: { type: "pool", name },
		family: name,
		subscription: false,
		disabled: false,
		models: [...models.values()],
	};
}

const DECISIONS_ANSWER = {
	model: "gpt-6-luna",
	answers: [{ type: "predicate", name: "needsReview", probability: 0.75 }],
	usage: { input_tokens: 40, output_tokens: 0 },
};

/** Fake Anthropic and OpenAI upstream: answers by API key, fails keys on demand, can hang. */
class FakeUpstream {
	readonly calls = new Map<string, number>();
	readonly failing = new Set<string>();
	/** Decisions requests as the upstream saw them: the API key they carried and their body. */
	readonly decisions: { key: string; body: string }[] = [];
	hangClosed = false;
	readonly server: Server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const key = (request.headers["x-api-key"] as string | undefined) ?? request.headers.authorization?.slice(7) ?? "";
		this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
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
			response.on("close", () => {
				this.hangClosed = true;
			});
			return;
		}
		if (request.url?.includes("/v1/messages")) this.anthropic(response, key);
		else this.responses(response, key);
	});

	count(key: string): number {
		return this.calls.get(key) ?? 0;
	}

	private anthropic(response: ServerResponse, key: string): void {
		sse(response, [
			[
				"message_start",
				{
					type: "message_start",
					message: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						model: "claude-test-1",
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
	let pool: BrokerProviderSpec;
	let allPool: BrokerProviderSpec;
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
		// Map each pinned provider to the API key the upstream saw for it. The OpenAI key has no chat model here.
		for (const spec of specs.filter((entry) => entry.target.type === "account" && entry.models.length > 0)) {
			const before = new Map(upstream.calls);
			await models.completeSimple(spec.models[0]!, user("probe"));
			const key = [...upstream.calls].find(([name, count]) => count !== before.get(name))?.[0];
			if (key) byKey.set(key, spec);
		}
		const pinned = specs.filter((spec) => spec.target.type === "account");
		luna = pinned.find((spec) => spec.classifiers !== undefined)!;
		pool = brokerPool(
			"claude",
			pinned.filter((spec) => spec.family === "claude"),
		);
		allPool = brokerPool("all", pinned);
		models.setProvider(createAccountProvider(pool, client));
		models.setProvider(createAccountProvider(allPool, client));
	}, 60_000);

	afterAll(async () => {
		await client?.shutdown().catch(() => {});
		upstream.server.close();
		upstream.server.closeAllConnections();
		rmSync(home, { recursive: true, force: true });
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
		expect(reply.errorMessage).toContain("rate limited");
		expect(upstream.count("sk-ant-A")).toBe(before);
	});

	it("fails a pool over to a healthy account", async () => {
		upstream.failing.add("sk-ant-A");
		upstream.failing.add("sk-ant-D");
		const reply = await models.completeSimple(first(pool), user("hi"));
		upstream.failing.delete("sk-ant-A");
		upstream.failing.delete("sk-ant-D");
		await resetCooldowns();
		expect(reply.content).toContainEqual(expect.objectContaining({ type: "text", text: "served by sk-ant-B" }));
	});

	it("serves an Anthropic API-key account through the official-API executor", async () => {
		expect(accounts.filter((account) => account.provider === "claude-api")).toEqual([
			expect.objectContaining({ kind: "api-key" }),
		]);
		const spec = byKey.get("sk-ant-D")!;
		expect(spec.models.map((model) => model.id)).toEqual(["claude-test-1"]);
		const reply = await models.completeSimple(first(spec), user("hi"));
		expect(reply.content).toContainEqual(expect.objectContaining({ type: "text", text: "served by sk-ant-D" }));
	});

	it("routes Claude and GPT models through one pool:all provider", async () => {
		expect(allPool.models.map((model) => [model.id, model.api]).sort()).toEqual([
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
		await new Promise((resolve) => setTimeout(resolve, 500));
		abort.abort();
		expect((await pending).stopReason).toBe("aborted");
		await expect.poll(() => upstream.hangClosed, { timeout: 5_000 }).toBe(true);
	});

	it("classifies through an OpenAI API key's Decisions route with the key and the request body unchanged", async () => {
		// The pool route is not exercised: it selects by the key's model list, which the broker's startup load can reset.
		expect(byKey.get("sk-codex-C")!.classifiers).toBeUndefined();
		const context: ClassifierContext = {
			state: { diff: "rename a variable" },
			questions: {
				needsReview: { type: "bool", instructions: "Does it need review?", criteria: { true: "", false: "" } },
			},
		};
		const result = await models.classify(luna.classifiers![0]!, context);
		expect(result).toMatchObject({
			stopReason: "stop",
			answers: { needsReview: { type: "bool", probability: 0.75 } },
		});
		expect(upstream.decisions.map((request) => request.key)).toEqual(["sk-openai-luna"]);
		expect(JSON.parse(upstream.decisions[0]!.body)).toMatchObject({ model: "gpt-6-luna" });
	});

	it("shares one broker between harness processes", async () => {
		const other = new BrokerClient({ home, locateBinary: () => brokerBinary });
		expect(await other.connect()).toEqual(await client.connect());
	});
});
