import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setUnpausedProviders } from "@oh-my-pi/pi-ai";
import { Accounts, accountKey } from "../src/accounts.ts";
import { Gateway } from "../src/gateway.ts";
import { array, object, type WireObject } from "../src/wire.ts";

for (const kind of ["api-key", "oauth"] as const) {
	test(`${kind} requests retain shared reference cache boundaries across worker tasks`, async () => {
		const home = await mkdtemp(join(tmpdir(), "credne-cache-wire-"));
		const received: { headers: Headers; body: WireObject }[] = [];
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				received.push({ headers: request.headers, body: object(await request.json()) });
				const events = [
					{
						type: "message_start",
						message: {
							id: "reply",
							type: "message",
							role: "assistant",
							model: "claude-test",
							content: [],
							usage: { input_tokens: 4, output_tokens: 0 },
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
					{ type: "message_stop" },
				];
				return new Response(
					events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		const accounts = new Accounts({
			home,
			anthropicBaseUrl: upstream.url.origin,
			openaiBaseUrl: upstream.url.origin,
		});
		await accounts.load();
		const gateway = new Gateway(accounts, 0);
		if (kind === "oauth") setUnpausedProviders(["anthropic"]);
		try {
			const id = "claude-cache";
			await accounts.register(
				{
					id,
					name: "cache",
					provider: kind === "oauth" ? "claude" : "claude-api",
					kind,
					models: ["claude-test"],
					createdAt: "2026-01-01T00:00:00Z",
				},
				kind === "oauth"
					? {
							type: "oauth",
							access: "sk-ant-oat01-cache-test",
							refresh: "fake-refresh",
							expires: Date.now() + 3600000,
							accountId: "cache-account",
							orgId: "cache-org",
						}
					: { type: "api_key", key: "cache-key", source: "login" },
			);
			const marker = { type: "ephemeral", ttl: "1h" };
			const reference = { type: "text", text: "Shared parent conversation.", cache_control: marker };
			for (const task of ["First worker task.", "Different worker task."]) {
				const response = await gateway.execute(
					new Request("http://gateway-test", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							model: "claude-test",
							max_tokens: 64,
							stream: false,
							system: [{ type: "text", text: "Worker system.", cache_control: marker }],
							messages: [{ role: "user", content: [reference, { type: "text", text: task }] }],
						}),
					}),
					`a.${accountKey(id)}`,
					"/v1/messages",
				);
				expect(response.status).toBe(200);
				expect(await response.text()).toContain("Done.");
				const wire = received.at(-1)!;
				expect(array(object(array(wire.body.messages)[0]).content)).toContainEqual(reference);
				expect(JSON.stringify(wire.body.messages)).toContain(task);
				expect(JSON.stringify(wire.body.system)).toContain("Worker system.");
				expect(JSON.stringify(wire.body).match(/"cache_control":/g)!.length).toBeLessThanOrEqual(4);
				if (kind === "oauth") expect(wire.headers.get("authorization")).toBe("Bearer sk-ant-oat01-cache-test");
				else expect(wire.headers.get("x-api-key")).toBe("cache-key");
			}
		} finally {
			gateway.close();
			accounts.close();
			await upstream.stop(true);
			if (kind === "oauth") setUnpausedProviders([]);
			await rm(home, { recursive: true, force: true });
		}
	}, 10000);
}

test("Claude pools favor subscriptions over API keys even after an API key served the session", async () => {
	const home = await mkdtemp(join(tmpdir(), "credne-claude-pool-"));
	const model = "claude-test";
	const limited = new Set<string>();
	const calls: string[] = [];
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			await request.arrayBuffer();
			const token = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.slice(7) ?? "";
			calls.push(token);
			if (limited.has(token))
				return Response.json(
					{ error: { message: "Rate limited" } },
					{
						status: 429,
						headers: { "retry-after": "60" },
					},
				);
			const events = [
				{
					type: "message_start",
					message: {
						id: "reply",
						type: "message",
						role: "assistant",
						model,
						content: [],
						usage: { input_tokens: 4, output_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
				{ type: "message_stop" },
			];
			return new Response(
				events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
	});
	const accounts = new Accounts({ home, anthropicBaseUrl: upstream.url.origin, openaiBaseUrl: upstream.url.origin });
	const gateway = new Gateway(accounts, 0);
	const apiKeys = ["key-one", "key-two"];
	const subscriptions = ["sk-ant-oat01-one", "sk-ant-oat01-two"];
	const send = async (target: string, session?: string, id = model) => {
		calls.length = 0;
		const headers = new Headers({ "content-type": "application/json" });
		if (session) headers.set("x-session-affinity", session);
		const response = await gateway.execute(
			new Request("http://gateway-test", {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: id,
					max_tokens: 32,
					stream: false,
					messages: [{ role: "user", content: "Hello." }],
				}),
			}),
			target,
			"/v1/messages",
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Done.");
		expect(response.headers.get("x-credne-account")).toBe(accountKey(calls.at(-1)!));
		return [...calls];
	};
	try {
		await accounts.load();
		for (const key of apiKeys) {
			await accounts.register(
				{
					id: key,
					name: key,
					provider: "claude-api",
					kind: "api-key",
					models: [model, "claude-key-only"],
					createdAt: "",
				},
				{ type: "api_key", key, source: "login" },
			);
		}
		for (const access of subscriptions) {
			await accounts.register(
				{ id: access, name: access, provider: "claude", kind: "oauth", models: [model], createdAt: "" },
				{
					type: "oauth",
					access,
					refresh: "fixture-refresh",
					email: `${access}@test.invalid`,
					expires: Date.now() + 3600000,
				},
			);
		}
		for (const pool of ["p.claude", "p.all"]) {
			accounts.routing.strategy = "fill-first";
			const [affine] = await send(pool, "thread");
			expect(affine).toBe(subscriptions[0]);
			expect(await send(pool, undefined, "claude-key-only")).toEqual([apiKeys[0]]);
			expect(await send(`a.${accountKey(apiKeys[0])}`, "thread")).toEqual([apiKeys[0]]);
			accounts.routing.strategy = "round-robin";
			const rotated = [...(await send(pool)), ...(await send(pool))];
			expect(rotated.sort()).toEqual([...subscriptions].sort());
			expect(await send(pool, "thread")).toEqual([affine]);
			limited.add(affine);
			expect(await send(pool, "thread")).toEqual(subscriptions);
			limited.add(subscriptions[1]);
			const fallback = await send(pool, "thread");
			expect(fallback).toHaveLength(2);
			expect(fallback[0]).toBe(subscriptions[1]);
			const paid = fallback[1];
			expect(apiKeys).toContain(paid);
			expect(await send(pool, "thread")).toEqual([paid]);
			limited.delete(affine);
			await accounts.mutate(accounts.accounts.get(affine)!, "reset");
			expect(await send(pool, "thread")).toEqual([affine]);
			limited.clear();
			await accounts.mutate(accounts.accounts.get(subscriptions[1])!, "reset");
		}
	} finally {
		gateway.close();
		accounts.close();
		await upstream.stop(true);
		await rm(home, { recursive: true, force: true });
	}
}, 10000);
