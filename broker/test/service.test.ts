import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker } from "../src/service.ts";
import { array, object } from "../src/wire.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
function events(content: Record<string, unknown>[], stop = "end_turn"): Response {
	const frames: [string, unknown][] = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: "claude-test",
					content: [],
					usage: { input_tokens: 4, output_tokens: 0 },
				},
			},
		],
	];
	for (const [index, block] of content.entries()) {
		frames.push(["content_block_start", { type: "content_block_start", index, content_block: block }]);
		frames.push(["content_block_stop", { type: "content_block_stop", index }]);
	}
	frames.push(
		["message_delta", { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 2 } }],
		["message_stop", { type: "message_stop" }],
	);
	return new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
async function fixture(options: { idleTimeout?: number; maxConcurrency?: number } = {}) {
	const home = await mkdtemp(join(tmpdir(), "credne-broker-"));
	cleanup.push(() => rm(home, { recursive: true, force: true }));
	const received: { key: string | null; headers: Headers; body: Record<string, unknown> }[] = [];
	let rejected: string | undefined;
	let held: Promise<void> | undefined;
	const arrivals = new Set<() => void>();
	const aborted = Promise.withResolvers<void>();
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			if (new URL(request.url).pathname === "/v1/models")
				return Response.json({ data: [{ id: "claude-test" }], has_more: false });
			const body = object(await request.json());
			const key = request.headers.get("x-api-key");
			received.push({ key, headers: request.headers, body });
			for (const arrival of arrivals) arrival();
			request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			if (key === rejected)
				return Response.json(
					{ error: { message: "rate limited secret-sk-ant-A cbk-do-not-leak" } },
					{ status: 429, headers: { "retry-after": "60" } },
				);
			if (held) await held;
			if (array(body.tools).some((tool) => object(tool).type === "web_search_20250305"))
				return events([
					{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "query" } },
					{
						type: "web_search_tool_result",
						tool_use_id: "srv_1",
						content: [
							{
								type: "web_search_result",
								title: "Source",
								url: "https://example.com",
								encrypted_content: "opaque",
							},
						],
					},
					{ type: "text", text: "Search result." },
				]);
			return events(
				[
					{ type: "text", text: "Visible answer." },
					{ type: "tool_use", id: "tool_1", name: "read", input: { path: "x" } },
				],
				"tool_use",
			);
		},
	});
	cleanup.push(async () => upstream.stop(true));
	await writeFile(
		join(home, "api-accounts.json"),
		JSON.stringify({
			version: 1,
			accounts: ["A", "B"].map((letter) => ({
				id: `claude-api-key-${letter}`,
				provider: "claude-api",
				kind: "api-key",
				name: letter,
				apiKey: `secret-sk-ant-${letter}`,
				models: ["claude-test"],
				createdAt: "2026-01-01T00:00:00Z",
			})),
		}),
		{ mode: 0o600 },
	);
	const broker = await startBroker({
		home,
		idleTimeout: options.idleTimeout ?? 0,
		maxConcurrency: options.maxConcurrency,
		anthropicBaseUrl: upstream.url.origin,
	});
	if (!broker) throw new Error("Fixture broker did not start");
	cleanup.push(() => broker.close());
	const request = (path: string, init: RequestInit = {}) =>
		fetch(`${broker.state.url}/credne/v1${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${broker.state.token}`,
				"content-type": "application/json",
				...Object.fromEntries(new Headers(init.headers)),
			},
		});
	const send = (target: string, body: Record<string, unknown> = {}, headers?: HeadersInit) =>
		request(`/route/${target}/v1/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "claude-test",
				max_tokens: 128,
				messages: [{ role: "user", content: "hello" }],
				stream: false,
				...body,
			}),
		});
	const waitForCalls = async (count: number) => {
		if (received.length >= count) return;
		const ready = Promise.withResolvers<void>();
		const check = () => {
			if (received.length >= count) ready.resolve();
		};
		arrivals.add(check);
		try {
			await ready.promise;
		} finally {
			arrivals.delete(check);
		}
	};
	return {
		home,
		broker,
		request,
		send,
		received,
		waitForCalls,
		aborted: aborted.promise,
		reject: (key?: string) => {
			rejected = key;
		},
		hold: (wait?: Promise<void>) => {
			held = wait;
		},
	};
}

describe("shared broker public contract", () => {
	test("streaming pinned rate limits retain status and pool retries before any frame is emitted", async () => {
		const f = await fixture();
		const accounts = array(object(await (await f.request("/accounts")).json()).accounts).map(object);
		f.reject("secret-sk-ant-A");
		const pinned = await f.send(`a.${accounts[0].key}`, { stream: true });
		expect(pinned.status).toBe(429);
		expect(pinned.headers.get("retry-after")).toBe("60");
		expect(await pinned.text()).not.toContain("message_start");
		expect(f.received.every((call) => call.key === "secret-sk-ant-A")).toBe(true);
		await f.request(`/accounts/${accounts[0].key}/reset`, { method: "POST" });
		const pooled = await f.send("p.claude", { stream: true });
		expect(pooled.status).toBe(200);
		expect(pooled.headers.get("x-credne-account")).toBe(String(accounts[1].key));
		const wire = await pooled.text();
		expect(wire).toContain("tool_use");
		expect(wire).not.toContain("rate limited");
	}, 20000);

	test("malformed management JSON is a caller error", async () => {
		const f = await fixture();
		for (const path of ["/api-keys", "/logins", "/logins/unknown/callback"]) {
			const response = await f.request(path, { method: "POST", body: "{broken" });
			expect(response.status).toBe(400);
			expect(await response.text()).toContain("Invalid JSON");
		}
	});

	test("gateway sends only selected key, keeps tools, and never falls back from a pin", async () => {
		const f = await fixture();
		const accounts = array(object(await (await f.request("/accounts")).json()).accounts).map(object);
		const key = String(accounts[0].key);
		const good = await f.send(`a.${key}`, {}, { cookie: "caller-cookie", "x-api-key": f.broker.state.token });
		expect(good.status).toBe(200);
		expect(good.headers.get("x-credne-account")).toBe(key);
		const payload = object(await good.json());
		expect(JSON.stringify(payload)).toContain("tool_use");
		expect(f.received[0].key).toBe("secret-sk-ant-A");
		expect(f.received[0].headers.get("cookie")).toBeNull();
		expect(f.received[0].headers.get("authorization")).toBeNull();
		f.reject("secret-sk-ant-A");
		const pinned = await f.send(`a.${key}`);
		const error = await pinned.text();
		expect(pinned.status).toBe(429);
		expect(pinned.headers.get("retry-after")).toBe("60");
		expect(error).not.toContain("secret-sk-ant");
		expect(error).not.toContain(f.broker.state.token);
		expect(f.received.every((call) => call.key === "secret-sk-ant-A")).toBe(true);
		const pooled = await f.send("p.claude");
		expect(pooled.status).toBe(200);
		await pooled.body?.cancel();
		expect(f.received.at(-1)?.key).toBe("secret-sk-ant-B");
	}, 20000);

	test("gate rejects foreign Host/Origin, invalid tokens and unexposed routes", async () => {
		const f = await fixture();
		for (const headers of [new Headers({ host: "evil.test" }), new Headers({ origin: "https://evil.test" })])
			expect((await f.request("/accounts", { headers })).status).toBe(403);
		expect((await fetch(`${f.broker.state.url}/credne/v1/accounts`)).status).toBe(401);
		expect(
			(
				await fetch(`${f.broker.state.url}/v1/models`, {
					headers: { authorization: `Bearer ${f.broker.state.token}` },
				})
			).status,
		).toBe(404);
		const publicText = await (await f.request("/accounts")).text();
		expect(publicText).not.toContain("secret-sk-ant");
		expect(object(await (await f.request("/health")).json()).backend).toBe("oh-my-pi");
	});

	test("native hosted search is a real upstream tool and retains native search result blocks", async () => {
		const f = await fixture();
		const accounts = array(object(await (await f.request("/accounts")).json()).accounts).map(object);
		const response = await f.send(`a.${accounts[0].key}`, {
			tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
			tool_choice: { type: "tool", name: "web_search" },
		});
		expect(response.status).toBe(200);
		const payload = await response.text();
		expect(payload).toContain("web_search_tool_result");
		expect(payload).toContain("https://example.com");
		expect(object(array(f.received[0].body.tools)[0]).type).toBe("web_search_20250305");
	}, 20000);

	test("validation, duplicate concurrency, disable/reset/delete, and owner-only discovery", async () => {
		const f = await fixture();
		const add = () =>
			f.request("/api-keys", {
				method: "POST",
				body: JSON.stringify({ provider: "claude", name: "new", key: "unique-key" }),
			});
		const added = await Promise.all([add(), add()]);
		expect(added.map((response) => response.status).sort()).toEqual([200, 409]);
		const account = object(object(await added.find((response) => response.status === 200)!.json()).account);
		const key = String(account.key);
		expect((await f.request(`/accounts/${key}/disable`, { method: "POST" })).status).toBe(200);
		expect((await f.send(`a.${key}`)).status).toBe(403);
		expect((await f.request(`/accounts/${key}/enable`, { method: "POST" })).status).toBe(200);
		expect((await f.request(`/accounts/${key}/reset`, { method: "POST" })).status).toBe(200);
		expect((await f.request(`/accounts/${key}`, { method: "DELETE" })).status).toBe(200);
		expect((await f.request(`/accounts/${key}/models`)).status).toBe(404);
		const record = object(JSON.parse(await readFile(join(f.home, "broker.json"), "utf8")));
		expect(record.token).toBe(f.broker.state.token);
		if (process.platform !== "win32") expect((await stat(join(f.home, "broker.json"))).mode & 0o777).toBe(0o600);
	});

	test("sessions remain affine; pool account changes rewrite private reasoning without dropping tools", async () => {
		const f = await fixture();
		const headers = { "x-session-affinity": "conversation-one" };
		const first = await f.send("p.claude", {}, headers);
		const firstKey = first.headers.get("x-credne-account");
		await first.body?.cancel();
		const second = await f.send("p.claude", {}, headers);
		expect(second.headers.get("x-credne-account")).toBe(firstKey);
		await second.body?.cancel();
		await f.request(`/accounts/${firstKey}/disable`, { method: "POST" });
		const next = await f.send(
			"p.claude",
			{
				thinking: { type: "enabled", budget_tokens: 1024 },
				messages: [
					{ role: "user", content: "question" },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "private summary", signature: "signed-by-other-account" },
							{ type: "text", text: "visible history" },
							{ type: "tool_use", id: "old_tool", name: "read", input: {} },
						],
					},
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "old_tool", content: "result" }] },
				],
			},
			headers,
		);
		expect(next.status).toBe(200);
		await next.body?.cancel();
		const wire = JSON.stringify(f.received.at(-1)?.body);
		expect(wire).not.toContain("signed-by-other-account");
		expect(wire).toContain("visible history");
		expect(wire).toContain("old_tool");
	});

	test("live daemon is shared and discovery removed only on owner shutdown", async () => {
		const f = await fixture();
		expect(await startBroker({ home: f.home, idleTimeout: 0 })).toBeUndefined();
		await f.broker.close();
		expect(await Bun.file(join(f.home, "broker.json")).exists()).toBe(false);
	});

	test("streaming retains tool framing and client cancellation reaches upstream", async () => {
		const f = await fixture({ maxConcurrency: 1 });
		const accounts = array(object(await (await f.request("/accounts")).json()).accounts).map(object);
		const response = await f.send(`a.${accounts[0].key}`, { stream: true });
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const wire = await response.text();
		expect(wire).toContain("content_block_start");
		expect(wire).toContain("tool_use");
		expect(wire).toContain("message_stop");
		const hold = Promise.withResolvers<void>();
		f.hold(hold.promise);
		const abort = new AbortController();
		const pending = f.request(`/route/a.${accounts[0].key}/v1/messages`, {
			method: "POST",
			signal: abort.signal,
			body: JSON.stringify({
				model: "claude-test",
				max_tokens: 32,
				messages: [{ role: "user", content: "wait" }],
				stream: true,
			}),
		});
		void pending.catch(() => {});
		await f.waitForCalls(2);
		abort.abort();
		await f.aborted;
		hold.resolve();
		await expect(pending).rejects.toThrow();
	}, 20000);

	test("idle expiry does not terminate an active upstream request", async () => {
		const f = await fixture({ idleTimeout: 100 });
		const hold = Promise.withResolvers<void>();
		f.hold(hold.promise);
		const response = f.send("p.claude");
		await f.waitForCalls(1);
		// Integration test: the daemon's platform interval must run while real HTTP is pending.
		await Bun.sleep(150);
		expect((await f.request("/health")).status).toBe(200);
		hold.resolve();
		const finished = await response;
		expect(finished.status).toBe(200);
		await finished.body?.cancel();
	}, 20000);
});
