import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type BrokerHandle, startBroker } from "../src/service.ts";
import { array, object } from "../src/wire.ts";
import { piBody, piEvents, piText } from "./fixtures.ts";

async function fixture(upstream: (request: Request) => Promise<Response> | Response) {
	const home = await mkdtemp(join(tmpdir(), "credne-providers-"));
	const realFetch = globalThis.fetch;
	const network: { fetch: FetchImpl } = globalThis;
	const transport = spyOn(network, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		return new URL(request.url).hostname === "127.0.0.1" ? realFetch(request) : upstream(request);
	});
	let broker: BrokerHandle | undefined;
	const restart = async () => {
		await broker?.close();
		broker = await startBroker({ home, idleTimeout: 0 });
		if (!broker) throw new Error("No test broker");
		return broker.state.url;
	};
	const close = async () => {
		try {
			await broker?.close();
		} finally {
			transport.mockRestore();
			await rm(home, { recursive: true, force: true });
		}
	};
	try {
		await restart();
	} catch (error) {
		await close();
		throw error;
	}
	return {
		restart,
		close,
		metadata: () => readFile(join(home, "omp-accounts.json"), "utf8"),
		request: (
			path: string,
			body?: Record<string, unknown>,
			method = body === undefined ? "GET" : "POST",
			extra?: HeadersInit,
		) => {
			if (!broker) throw new Error("No test broker");
			const headers = new Headers(extra);
			headers.set("authorization", `Bearer ${broker.state.token}`);
			return fetch(`${broker.state.url}/credne/v1${path}`, { method, headers, body: JSON.stringify(body) });
		},
	};
}

test("provider discovery exposes only enrollable chat methods and requires the broker token", async () => {
	const f = await fixture(() => {
		throw new Error("Discovery must not contact providers");
	});
	try {
		const url = await f.restart();
		const denied = await fetch(`${url}/credne/v1/providers`);
		expect(denied.status).toBe(401);
		await denied.body?.cancel();
		const offered = await f.request("/providers");
		expect(offered.status).toBe(200);
		expect(offered.headers.get("cache-control")).toBe("no-store");
		const providers = array(object(await offered.json()).providers).map(object);
		const byId = new Map(providers.map((provider) => [provider.id, provider.authMethods]));
		expect(byId.size).toBe(providers.length);
		expect(byId.get("anthropic")).toEqual(["api-key", "oauth"]);
		expect(byId.get("openai-codex")).toEqual(["oauth"]);
		expect(byId.get("deepseek")).toEqual(["api-key"]);
		expect(byId.get("openrouter")).toEqual(["api-key"]);
		expect(byId.get("xai-oauth")).toEqual(["oauth"]);
		// TypeSafe's models are classifiers, not chat models, yet its key is enrollable.
		expect(providers).toContainEqual({ id: "typesafe", name: "TypeSafe", authMethods: ["api-key"] });
		for (const id of [
			"amazon-bedrock",
			"azure",
			"google-antigravity",
			"cursor",
			"github-copilot",
			"gitlab-duo-agent",
			"kimi-code",
			"tavily",
			"local",
		])
			expect(byId.has(id)).toBe(false);
		for (const [path, provider] of [
			["/logins", "openrouter"],
			["/logins", "google-antigravity"],
			["/logins", "github-copilot"],
			["/api-keys", "amazon-bedrock"],
			["/api-keys", "openai-codex"],
			["/api-keys", "unknown-provider"],
		]) {
			const response = await f.request(path, { provider, name: "test", key: "must-not-leak" });
			expect(response.status).toBe(400);
			expect(await response.text()).not.toContain("must-not-leak");
		}
	} finally {
		await f.close();
	}
});

test("OMP key enrollment validates via its own declared probe and keeps catalog chat metadata", async () => {
	let requests = 0;
	const key = "deepseek-explicit-fixture-key";
	const f = await fixture((request) => {
		requests++;
		expect(request.url).toBe("https://api.deepseek.com/v1/models");
		expect(request.redirect).toBe("error");
		if (request.headers.get("authorization") !== `Bearer ${key}`)
			return Response.json({ error: "private provider diagnostic" }, { status: 401 });
		return Response.json({ data: [] });
	});
	try {
		const rejected = await f.request("/api-keys", { provider: "deepseek", name: "bad", key: "wrong" });
		expect(rejected.status).toBe(400);
		expect(await rejected.text()).not.toContain("private provider diagnostic");
		const response = await f.request("/api-keys", { provider: "deepseek", name: "primary", key });
		expect(response.status).toBe(200);
		const account = object(object(await response.json()).account);
		expect(account).toMatchObject({ id: "deepseek-key-primary", provider: "deepseek", kind: "api-key" });
		const path = `/accounts/${account.key}/models`;
		const models = array(object(await (await f.request(path)).json()).models).map(object);
		const reference = getBundledModel("deepseek", String(models[0].id));
		expect(models[0]).toMatchObject({
			kind: "chat",
			// The identity OMP resolves the model to, for callers that replay history under it.
			provider: reference.provider,
			api: reference.api,
			displayName: reference.name,
			inputModalities: reference.input,
			maxCompletionTokens: reference.maxTokens,
		});
		expect(JSON.stringify(models)).not.toContain("https://");
		expect(await f.metadata()).not.toContain(key);
		await f.restart();
		expect(array(object(await (await f.request(path)).json()).models)).toEqual(models);
		expect(requests).toBe(2);
	} finally {
		await f.close();
	}
});

test("Google model discovery and inference use different OMP-owned auth placement", async () => {
	const key = "google-fixture-key";
	const id = "gemini-2.5-flash";
	let sent = 0;
	const f = await fixture(async (request) => {
		const url = new URL(request.url);
		expect(url.origin).toBe("https://generativelanguage.googleapis.com");
		if (request.method === "GET") {
			expect(url.pathname).toBe("/v1beta/models");
			expect(url.searchParams.get("key")).toBe(key);
			return Response.json({
				models: [id, "unbundled-id"].map((model) => ({
					name: `models/${model}`,
					supportedGenerationMethods: ["generateContent"],
				})),
			});
		}
		sent++;
		expect(url.pathname).toBe(`/v1beta/models/${id}:streamGenerateContent`);
		expect(request.headers.get("x-goog-api-key")).toBe(key);
		expect(request.headers.get("authorization")).toBeNull();
		expect(request.headers.get("cookie")).toBeNull();
		expect(await request.text()).toContain("hello Google");
		return new Response(
			`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Hello from OMP." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 } })}\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	try {
		const enrolled = await f.request("/api-keys", { provider: "google", name: "ai-studio", key });
		expect(enrolled.status).toBe(200);
		const account = object(object(await enrolled.json()).account);
		const models = array(object(await (await f.request(`/accounts/${account.key}/models`)).json()).models);
		expect(models.map((model) => object(model).id)).toEqual([id]);
		const reply = await f.request(
			"/route/p.google/pi/stream",
			JSON.parse(
				piBody(`google/${id}`, "google-session", {
					context: { messages: [{ role: "user", content: "hello Google", timestamp: 1 }] },
				}),
			),
			"POST",
			{ "x-goog-api-key": "caller-key-must-not-be-used", cookie: "private-cookie" },
		);
		expect(reply.status).toBe(200);
		expect(reply.headers.get("x-credne-account")).toBe(String(account.key));
		expect(piText(await piEvents(reply))).toBe("Hello from OMP.");
		expect(sent).toBe(1);
	} finally {
		await f.close();
	}
}, 15000);

test("OMP device login polls privately and the saved token serves a pinned request", async () => {
	const model = "grok-4.5";
	const access = `fixture.${Buffer.from(JSON.stringify({ sub: "fixture-account" })).toString("base64url")}.test`;
	const release = Promise.withResolvers<void>();
	const f = await fixture(async (request) => {
		switch (request.url) {
			case "https://auth.x.ai/oauth2/device/code":
				return Response.json({
					user_code: "TEST-123",
					device_code: "private-device-code",
					verification_uri: "https://auth.x.ai/activate",
					interval: 1,
					expires_in: 120,
				});
			case "https://auth.x.ai/.well-known/openid-configuration":
				return Response.json({ token_endpoint: "https://auth.x.ai/oauth2/token" });
			case "https://auth.x.ai/oauth2/token":
				expect(new URLSearchParams(await request.text()).get("device_code")).toBe("private-device-code");
				await release.promise;
				return Response.json({ access_token: access, refresh_token: "private-refresh-token", expires_in: 3600 });
			case "https://auth.x.ai/oauth2/userinfo":
				expect(request.headers.get("authorization")).toBe(`Bearer ${access}`);
				return Response.json({ sub: "fixture-account", email: "user@example.test" });
			case "https://api.x.ai/v1/responses": {
				expect(request.headers.get("authorization")).toBe(`Bearer ${access}`);
				expect(object(await request.json()).model).toBe(model);
				const item = { id: "answer", type: "message", role: "assistant", content: [] };
				const frames = [
					{ type: "response.output_item.added", output_index: 0, item },
					{
						type: "response.output_text.delta",
						output_index: 0,
						item_id: item.id,
						content_index: 0,
						delta: "Grok fixture reply",
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: { ...item, content: [{ type: "output_text", text: "Grok fixture reply" }] },
					},
					{
						type: "response.completed",
						response: {
							id: "fixture",
							status: "completed",
							output: [],
							usage: { input_tokens: 6, output_tokens: 3, total_tokens: 9 },
						},
					},
				];
				return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			}
			default:
				throw new Error("Unexpected xAI login endpoint");
		}
	});
	try {
		const started = object(await (await f.request("/logins", { provider: "xai-oauth" })).json());
		expect(started).toMatchObject({
			flow: "device",
			url: "https://auth.x.ai/activate",
			instructions: "Enter code: TEST-123",
		});
		expect(JSON.stringify(started)).not.toContain("private-device-code");
		const path = `/logins/${started.state}`;
		const callback = await f.request(`${path}/callback`, { redirectUrl: "https://auth.x.ai/activate?code=ignored" });
		expect(callback.status).toBe(409);
		await callback.body?.cancel();
		expect(await (await f.request(path)).json()).toEqual({ status: "wait" });
		release.resolve();
		let status = object(await (await f.request(path)).json());
		const deadline = Date.now() + 5000;
		while (status.status === "wait" && Date.now() < deadline) {
			await Bun.sleep(10);
			status = object(await (await f.request(path)).json());
		}
		expect(status).toMatchObject({
			status: "ok",
			account: { provider: "xai-oauth", kind: "oauth", email: "user@example.test" },
		});
		for (const output of [JSON.stringify(status), await f.metadata()]) {
			expect(output).not.toContain(access);
			expect(output).not.toMatch(/private-device-code|TEST-123|private-refresh-token/);
		}
		await f.restart();
		const route = await f.request(
			`/route/a.${object(status.account).key}/pi/stream`,
			JSON.parse(piBody(model, "grok-session")),
		);
		expect(route.status).toBe(200);
		expect(piText(await piEvents(route))).toBe("Grok fixture reply");
	} finally {
		release.resolve();
		await f.close();
	}
});
