import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker } from "../src/service.ts";
import { array, object } from "../src/wire.ts";
import { fakeNetwork } from "./fixtures.ts";

const openaiList = ["gpt-5.4", "text-embedding-3-small", "whisper-1", "gpt-6-luna", "gpt-6-luna-decisions", "dall-e-3"];

/** A fake provider whose `/v1/models` answers by key: `bad` is refused, `empty` lists nothing, `garbled` is not JSON. */
function fakeModelList() {
	const calls: { path: string; search: string; headers: Headers }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			calls.push({ path: url.pathname, search: url.search, headers: request.headers });
			const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.slice(7) ?? "";
			if (key.endsWith("bad")) return Response.json({ error: "private diagnostic" }, { status: 401 });
			if (key.endsWith("empty")) return Response.json({ data: [] });
			if (key.endsWith("garbled")) return new Response("<html>not json</html>");
			const ids = request.headers.has("x-api-key") ? ["claude-b", "claude-a", "claude-b"] : openaiList;
			return Response.json({ data: ids.map((id) => ({ id })), has_more: false });
		},
	});
	return { calls, server };
}

async function fixture(options: { anthropicBaseUrl?: string; openaiBaseUrl?: string } = {}) {
	const home = await mkdtemp(join(tmpdir(), "credne-enrollment-"));
	const network = fakeNetwork();
	const upstream = fakeModelList();
	const origin = upstream.server.url.origin;
	const broker = await startBroker({
		home,
		idleTimeout: 0,
		anthropicBaseUrl: options.anthropicBaseUrl ?? origin,
		openaiBaseUrl: options.openaiBaseUrl ?? origin,
	});
	if (!broker) throw new Error("No test broker");
	const call = (path: string, body?: unknown) =>
		fetch(`${broker.state.url}/credne/v1${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${broker.state.token}` },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	return {
		upstream,
		network,
		call,
		models: async (account: unknown) =>
			array(object(await (await call(`/accounts/${object(account).key}/models`)).json()).models).map(object),
		async close() {
			await broker.close();
			await upstream.server.stop(true);
			network.restore();
			await rm(home, { recursive: true, force: true });
		},
	};
}

test("Anthropic and OpenAI keys are verified and listed through OMP's catalog discovery", async () => {
	const f = await fixture();
	try {
		for (const [provider, key] of [
			["claude", "sk-ant-bad"],
			["openai", "sk-bad"],
		]) {
			const response = await f.call("/api-keys", { provider, name: "refused", key });
			expect(response.status).toBe(400);
			const text = await response.text();
			expect(text).toContain("Key rejected (HTTP 401)");
			expect(text).not.toMatch(/private diagnostic|sk-ant-bad|sk-bad/);
		}
		for (const [key, message] of [
			["sk-empty", "Key has no accessible models."],
			["sk-garbled", "Provider returned invalid model data."],
		]) {
			const response = await f.call("/api-keys", { provider: "openai", name: "refused", key });
			expect(response.status).toBe(400);
			expect(await response.text()).toContain(message);
		}
		expect(array(object(await (await f.call("/accounts")).json()).accounts)).toEqual([]);

		const claude = object(
			object(await (await f.call("/api-keys", { provider: "claude", name: "Work", key: "sk-ant-good" })).json())
				.account,
		);
		expect(claude).toMatchObject({ id: "claude-api-key-work", provider: "claude-api", modelCount: 2 });
		const claudeModels = await f.models(claude);
		expect(claudeModels.map((model) => model.id)).toEqual(["claude-a", "claude-b"]);
		for (const model of claudeModels)
			expect(model).toMatchObject({ provider: "anthropic", api: "anthropic-messages" });
		const openai = object(
			object(await (await f.call("/api-keys", { provider: "openai", name: "Work", key: "sk-good" })).json()).account,
		);
		// Embedding, speech and judge models are not chat models, and an image model is not even a Responses model.
		const openaiModels = await f.models(openai);
		expect(openaiModels.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-6-luna"]);
		for (const model of openaiModels) expect(model).toMatchObject({ provider: "openai", api: "openai-responses" });

		const sent = f.upstream.calls.filter((call) => call.headers.get("x-api-key") === "sk-ant-good");
		expect(sent.map((call) => call.path)).toEqual(["/v1/models"]);
		const bearer = f.upstream.calls.filter((call) => call.headers.get("authorization") === "Bearer sk-good");
		expect(bearer.map((call) => call.path)).toEqual(["/v1/models"]);
		// Only the provider itself ever sees a key: discovery's reference data is not fetched.
		expect(f.network.external).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a key that cannot be checked is refused as a validation failure", async () => {
	const f = await fixture({ openaiBaseUrl: "http://127.0.0.1:1" });
	try {
		const response = await f.call("/api-keys", { provider: "openai", name: "offline", key: "sk-offline" });
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Key validation failed or timed out.");
	} finally {
		await f.close();
	}
});
