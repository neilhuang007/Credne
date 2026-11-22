import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker } from "../src/service.ts";
import { array, object } from "../src/wire.ts";
import { anthropicReply, piBody, piEvents, piText, refusal } from "./fixtures.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
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
			// OMP would wait out the provider's hint; this answer tells it to give up at once.
			if (key === rejected) return refusal(429, "rate limited", { "retry-after": "60", "x-should-retry": "false" });
			if (held) await held;
			return anthropicReply("Visible answer.", { id: "tool_1", name: "read", input: { path: "x" } });
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
	const send = (target: string, session = "conversation", headers?: HeadersInit, init: RequestInit = {}) =>
		request(`/route/${target}/pi/stream`, {
			method: "POST",
			headers,
			body: piBody("anthropic/claude-test", session),
			...init,
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
		accounts: async () => array(object(await (await request("/accounts")).json()).accounts).map(object),
		reject: (key?: string) => {
			rejected = key;
		},
		hold: (wait?: Promise<void>) => {
			held = wait;
		},
	};
}

describe("shared broker public contract", () => {
	test("a pinned limit is recorded without a failover; a pool moves on before any frame is emitted", async () => {
		const f = await fixture();
		const accounts = await f.accounts();
		f.reject("secret-sk-ant-A");
		const pinned = await f.send(`a.${accounts[0].key}`);
		expect(pinned.status).toBe(200);
		expect(pinned.headers.get("x-credne-account")).toBe(String(accounts[0].key));
		expect((await piEvents(pinned)).at(-1)).toMatchObject({ type: "error" });
		expect(f.received.every((call) => call.key === "secret-sk-ant-A")).toBe(true);
		// The limit benches the account; a pinned request is then refused without a call.
		const cooling = await f.send(`a.${accounts[0].key}`);
		expect(cooling.status).toBe(429);
		expect(cooling.headers.get("retry-after")).not.toBeNull();
		expect(f.received).toHaveLength(1);
		await f.request(`/accounts/${accounts[0].key}/reset`, { method: "POST" });
		const pooled = await f.send("p.claude", "pooled");
		expect(pooled.status).toBe(200);
		expect(pooled.headers.get("x-credne-account")).toBe(String(accounts[1].key));
		const events = await piEvents(pooled);
		expect(piText(events)).toBe("Visible answer.");
		// The refused account's attempt never reached the caller.
		expect(events.some((event) => event.type === "error")).toBe(false);
	}, 20000);

	test("malformed management JSON is a caller error", async () => {
		const f = await fixture();
		for (const path of ["/api-keys", "/logins", "/logins/unknown/callback"]) {
			const response = await f.request(path, { method: "POST", body: "{broken" });
			expect(response.status).toBe(400);
			expect(await response.text()).toContain("Invalid JSON");
		}
	});

	test("gateway sends only the selected key, keeps tools, and never falls back from a pin", async () => {
		const f = await fixture();
		const accounts = await f.accounts();
		const key = String(accounts[0].key);
		const good = await f.send(`a.${key}`, "conversation", {
			cookie: "caller-cookie",
			"x-api-key": f.broker.state.token,
		});
		expect(good.status).toBe(200);
		expect(good.headers.get("x-credne-account")).toBe(key);
		const events = await piEvents(good);
		expect(JSON.stringify(events)).toContain("toolCall");
		expect(f.received[0].key).toBe("secret-sk-ant-A");
		expect(f.received[0].headers.get("cookie")).toBeNull();
		// OMP sends an API key both ways; the caller's broker token is in neither.
		expect(f.received[0].headers.get("authorization")).toBe("Bearer secret-sk-ant-A");
		f.reject("secret-sk-ant-A");
		const pinned = await f.send(`a.${key}`);
		const error = await pinned.text();
		expect(error).not.toContain("secret-sk-ant");
		expect(error).not.toContain(f.broker.state.token);
		expect(f.received.every((call) => call.key === "secret-sk-ant-A")).toBe(true);
		const pooled = await f.send("p.claude", "another");
		expect(pooled.status).toBe(200);
		expect(piText(await piEvents(pooled))).toBe("Visible answer.");
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
		// The chat protocols OMP's pi-native route replaced are not exposed.
		for (const path of ["/v1/messages", "/responses", "/chat/completions", "/decisions"]) {
			const gone = await f.request(`/route/p.claude${path}`, { method: "POST", body: "{}" });
			expect(gone.status).toBe(404);
			await gone.body?.cancel();
		}
		const publicText = await (await f.request("/accounts")).text();
		expect(publicText).not.toContain("secret-sk-ant");
		expect(object(await (await f.request("/health")).json()).backend).toBe("oh-my-pi");
	});

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

	test("a conversation stays on its account until that account is unavailable", async () => {
		const f = await fixture();
		const first = await f.send("p.claude", "conversation-one");
		const firstKey = first.headers.get("x-credne-account");
		await first.body?.cancel();
		const second = await f.send("p.claude", "conversation-one");
		expect(second.headers.get("x-credne-account")).toBe(firstKey);
		await second.body?.cancel();
		await f.request(`/accounts/${firstKey}/disable`, { method: "POST" });
		const next = await f.send("p.claude", "conversation-one");
		expect(next.status).toBe(200);
		expect(next.headers.get("x-credne-account")).not.toBe(firstKey);
		await next.body?.cancel();
	});

	test("live daemon is shared and discovery removed only on owner shutdown", async () => {
		const f = await fixture();
		expect(await startBroker({ home: f.home, idleTimeout: 0 })).toBeUndefined();
		await f.broker.close();
		expect(await Bun.file(join(f.home, "broker.json")).exists()).toBe(false);
	});

	test("streaming retains tool framing and client cancellation reaches the provider", async () => {
		const f = await fixture({ maxConcurrency: 1 });
		const accounts = await f.accounts();
		const response = await f.send(`a.${accounts[0].key}`);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const events = await piEvents(response);
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining(["start", "text_delta", "toolcall_end", "done"]),
		);
		const hold = Promise.withResolvers<void>();
		f.hold(hold.promise);
		const abort = new AbortController();
		// A pinned stream answers at once; its frames follow the provider.
		const pending = await f.send(`a.${accounts[0].key}`, "waiting", undefined, { signal: abort.signal });
		await f.waitForCalls(2);
		abort.abort();
		await f.aborted;
		hold.resolve();
		await pending.body?.cancel().catch(() => {});
		// The cancelled request released its slot: the one-request limit still admits the next.
		f.hold(undefined);
		const next = await f.send(`a.${accounts[0].key}`, "after");
		expect(piText(await piEvents(next))).toBe("Visible answer.");
	}, 20000);

	test("idle expiry does not terminate an active provider request", async () => {
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
		expect(piText(await piEvents(finished))).toBe("Visible answer.");
	}, 20000);
});
