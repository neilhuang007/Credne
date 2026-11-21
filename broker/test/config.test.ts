import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { accountKey } from "../src/accounts.ts";
import { BrokerConfigError, loadBrokerConfig } from "../src/config.ts";
import { type BrokerHandle, startBroker } from "../src/service.ts";
import { object } from "../src/wire.ts";

const configured = `
routing:
  strategy: fill-first
  session-affinity: false
  retry:
    request-retry: 0
api-keys:
  claude:
    - name: A team
      base-url: " https://claude.example/custom "
      headers:
        X-Route: " north "
        X-Existing: foo
      models: [{ name: claude-north }]
      keys:
        - api-key: " same-fixture "
        - api-key: same-fixture
          headers: { X-Route: south }
          models: [{ name: claude-south }]
        - api-key: same-fixture
  codex:
    - name: Codex gateway
      base-url: https://codex.example/gateway
      models: [{ name: gpt-test }]
      keys: [{ api-key: codex-fixture }]
  openai:
    - base-url: https://openai.example
      models: [{ name: gpt-6-luna }]
      headers: { X-Route: decisions }
      keys: [{ api-key: openai-fixture }]
`;

// These fixtures pin CLIProxyAPI 8.0.70's ID digest, duplicate counting, and unchanged OMP OpenAI IDs.
const ids = [
	"claude:apikey:8de1fc2e6baf",
	"claude:apikey:9769269db720",
	"claude:apikey:8de1fc2e6baf-1",
	"codex:apikey:b17ef64112ce",
	"config-openai-2aea2960365f3a45d8c9200d",
];

test("config accounts retain legacy pins, separate header variants and use their original endpoints", async () => {
	const home = await mkdtemp(join(tmpdir(), "credne-config-"));
	const configPath = join(home, "config.yaml");
	let broker: BrokerHandle | undefined;
	const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
	const network: { fetch: FetchImpl } = globalThis;
	const realFetch = globalThis.fetch;
	const transport = spyOn(network, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.hostname === "127.0.0.1") return realFetch(request);
		if (!["claude.example", "codex.example", "openai.example"].includes(url.hostname))
			throw new Error("Unexpected network request");
		requests.push({ url: url.href, body: object(await request.json()), headers: request.headers });
		return Response.json({ error: { message: "A fixture failure" } }, { status: 429 });
	});
	try {
		await writeFile(configPath, configured, { mode: 0o600 });
		const config = await loadBrokerConfig(home);
		expect(config.routing).toEqual({ strategy: "fill-first", affinity: false, retries: 0 });
		expect(config.accounts.map((account) => account.id)).toEqual(ids);
		broker = await startBroker({ home, idleTimeout: 0 });
		if (!broker) throw new Error("No test broker");
		const request = (path: string, body?: unknown) =>
			fetch(`${broker!.state.url}/credne/v1${path}`, {
				method: body ? "POST" : "GET",
				headers: { authorization: `Bearer ${broker!.state.token}`, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		const publicList = await (await request("/accounts")).text();
		expect(publicList).not.toMatch(/same-fixture|codex-fixture|openai-fixture/);
		for (const [index, route, model] of [
			[0, "v1/messages", "claude-north"],
			[1, "v1/messages", "claude-south"],
			[3, "responses", "gpt-test"],
			[4, "decisions", "gpt-6-luna"],
		] as const) {
			const key = accountKey(ids[index]);
			const response = await request(
				`/route/a.${key}/${route}`,
				route === "v1/messages"
					? { model, max_tokens: 20, messages: [{ role: "user", content: "hello" }] }
					: { model, input: "hello" },
			);
			expect(response.status).toBe(429);
			expect(response.headers.get("x-credne-account")).toBe(key);
			await response.body?.cancel();
		}
		expect(
			requests.map(({ url, body, headers }) => [url, body.model, headers.get("x-route"), headers.get("x-existing")]),
		).toEqual([
			["https://claude.example/custom/v1/messages?beta=true", "claude-north", "north", "foo"],
			["https://claude.example/custom/v1/messages?beta=true", "claude-south", "south", null],
			["https://codex.example/gateway/responses", "gpt-test", null, null],
			["https://openai.example/v1/decisions", "gpt-6-luna", "decisions", null],
		]);
		expect(requests[0].headers.get("x-api-key")).toBe("same-fixture");
		expect(requests[2].headers.get("authorization")).toBe("Bearer codex-fixture");
		expect(requests[3].headers.get("authorization")).toBe("Bearer openai-fixture");
	} finally {
		await broker?.close();
		transport.mockRestore();
		await rm(home, { recursive: true, force: true });
	}
}, 10000);

test("incompatible config options fail closed without exposing values", async () => {
	const home = await mkdtemp(join(tmpdir(), "credne-bad-config-"));
	const configPath = join(home, "config.yaml");
	const key = "secret-value-not-for-logs";
	try {
		for (const [source, message] of [
			[`openai-compatibility: [{ name: ${key} }]`, "an unrecognized option"],
			[`api-keys:\n  ${key}: [{ keys: [{ api-key: ${key} }] }]`, "unsupported provider"],
			[`api-keys:\n  claude: [{ prefix: ${key}, keys: [{ api-key: ${key} }] }]`, "prefix option"],
			[`api-keys:\n  claude: [{ keys: [{ api-key: ${key}, proxy-url: ${key} }] }]`, "proxy-url option"],
			[
				`api-keys:\n  openai: [{ headers: { Authorization: ${key} }, keys: [{ api-key: ${key} }] }]`,
				"reserved header",
			],
			[`api-keys:\n  codex: [{ keys: [{ api-key: ${key} }] }]`, "requires a base-url"],
			[
				`routing: { strategy: weighted-round-robin }\napi-keys: {claude: [{keys: [{api-key: ${key}}]}]}`,
				"routing.strategy",
			],
		]) {
			await writeFile(configPath, source, { mode: 0o600 });
			const failure = await loadBrokerConfig(home).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(BrokerConfigError);
			expect(String(failure)).toContain(message);
			expect(String(failure)).not.toContain(key);
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
