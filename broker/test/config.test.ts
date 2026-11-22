import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountKey } from "../src/accounts.ts";
import { BrokerConfigError, loadBrokerConfig } from "../src/config.ts";
import { type BrokerHandle, startBroker } from "../src/service.ts";
import { object } from "../src/wire.ts";
import { fakeNetwork, fakeUpstream, piBody, refusal } from "./fixtures.ts";

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

test("config accounts keep legacy pins, and their endpoints and headers reach the provider through OMP", async () => {
	const home = await mkdtemp(join(tmpdir(), "credne-config-"));
	const configPath = join(home, "config.yaml");
	let broker: BrokerHandle | undefined;
	// Local origins stand in for the hosts: OMP's Anthropic transport only dials HTTPS hosts itself.
	const upstream = fakeUpstream(() => refusal(400, "A fixture failure"));
	const network = fakeNetwork();
	try {
		await writeFile(configPath, configured, { mode: 0o600 });
		const config = await loadBrokerConfig(home);
		expect(config.routing).toEqual({ strategy: "fill-first", affinity: false, retries: 0 });
		expect(config.accounts.map((account) => account.id)).toEqual(ids);
		const local = configured
			.replace("https://claude.example", upstream.origin)
			.replace("https://codex.example", upstream.origin)
			.replace("https://openai.example", upstream.origin);
		await writeFile(configPath, local, { mode: 0o600 });
		const localIds = (await loadBrokerConfig(home)).accounts.map((account) => account.id);
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
		const systemOne = {
			model: "gpt-6-luna",
			state: "hello",
			questions: { easy: { type: "noul", instructions: "Hi?" } },
		};
		for (const [index, route, body] of [
			[0, "pi/stream", JSON.parse(piBody("anthropic/claude-north", "north"))],
			[1, "pi/stream", JSON.parse(piBody("anthropic/claude-south", "south"))],
			[3, "pi/stream", JSON.parse(piBody("openai/gpt-test", "codex"))],
			[4, "systemone", systemOne],
		] as const) {
			const key = accountKey(localIds[index]);
			const response = await request(`/route/a.${key}/${route}`, body);
			expect(response.headers.get("x-credne-account")).toBe(key);
			// A pinned stream answers at once; the provider request follows as the body is read.
			await response.text();
		}
		expect(
			upstream.calls.map(({ path, body, headers }) => [
				path,
				object(JSON.parse(body)).model,
				headers.get("x-route"),
				headers.get("x-existing"),
			]),
		).toEqual([
			["/custom/v1/messages", "claude-north", "north", "foo"],
			["/custom/v1/messages", "claude-south", "south", null],
			["/gateway/responses", "gpt-test", null, null],
			// OMP's System One route sends no model headers, so the configured routing header does not apply to it.
			["/v1/decisions", "gpt-6-luna", null, null],
		]);
		expect(upstream.calls[0].headers.get("x-api-key")).toBe("same-fixture");
		expect(upstream.calls[2].headers.get("authorization")).toBe("Bearer codex-fixture");
		expect(upstream.calls[3].headers.get("authorization")).toBe("Bearer openai-fixture");
	} finally {
		await broker?.close();
		network.restore();
		await upstream.server.stop(true);
		await rm(home, { recursive: true, force: true });
	}
}, 20000);

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
