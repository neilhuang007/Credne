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
