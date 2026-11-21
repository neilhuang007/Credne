import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker } from "../src/service.ts";
import { array, object } from "../src/wire.ts";

test("OpenAI gateway retains hosted search sources and supports Chat Completions tools", async () => {
	const home = await mkdtemp(join(tmpdir(), "credne-openai-"));
	const seen: { path: string; authorization: string | null; body: Record<string, unknown> }[] = [];
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/v1/models") return Response.json({ data: [{ id: "gpt-test" }] });
			const body = object(await request.json());
			seen.push({ path, authorization: request.headers.get("authorization"), body });
			let payload: string;
			if (path === "/v1/chat/completions") {
				const frames = [
					{
						id: "chat_1",
						object: "chat.completion.chunk",
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									content: "answer",
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											type: "function",
											function: { name: "read", arguments: '{"path":"x"}' },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						id: "chat_1",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
					},
				];
				payload = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
			} else {
				const search = {
					id: "ws_1",
					type: "web_search_call",
					status: "completed",
					action: {
						type: "search",
						query: "query",
						sources: [{ type: "url", title: "Source", url: "https://example.com/source" }],
					},
				};
				const message = {
					id: "msg_1",
					type: "message",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Searched answer.", annotations: [] }],
				};
				const frames = [
					{
						type: "response.created",
						response: { id: "resp_1", object: "response", status: "in_progress", model: "gpt-test", output: [] },
					},
					{ type: "response.output_item.added", output_index: 0, item: { ...search, status: "in_progress" } },
					{ type: "response.output_item.done", output_index: 0, item: search },
					{
						type: "response.output_item.added",
						output_index: 1,
						item: { ...message, content: [], status: "in_progress" },
					},
					{
						type: "response.output_text.delta",
						output_index: 1,
						item_id: "msg_1",
						content_index: 0,
						delta: "Searched answer.",
					},
					{ type: "response.output_item.done", output_index: 1, item: message },
					{
						type: "response.completed",
						response: {
							id: "resp_1",
							object: "response",
							model: "gpt-test",
							status: "completed",
							output: [search, message],
							usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
						},
					},
				];
				payload = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
			}
			return new Response(payload, { headers: { "content-type": "text/event-stream" } });
		},
	});
	await writeFile(
		join(home, "api-accounts.json"),
		JSON.stringify({
			version: 1,
			accounts: [
				{
					id: "openai-api-key-project",
					provider: "openai-api",
					kind: "api-key",
					name: "project",
					apiKey: "project-secret",
					models: ["gpt-test"],
					createdAt: "2026-01-01T00:00:00Z",
				},
			],
		}),
		{ mode: 0o600 },
	);
	const broker = await startBroker({ home, idleTimeout: 0, openaiBaseUrl: upstream.url.origin });
	if (!broker) throw new Error("No test broker");
	const key = Buffer.from("openai-api-key-project").toString("base64url");
	const request = (path: string, body: unknown) =>
		fetch(`${broker.state.url}/credne/v1/route/a.${key}${path}`, {
			method: "POST",
			headers: { authorization: `Bearer ${broker.state.token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		const search = await request("/responses", {
			model: "gpt-test",
			stream: false,
			store: false,
			instructions: "Search once.",
			input: "query",
			tools: [{ type: "web_search" }],
			tool_choice: "required",
			include: ["web_search_call.action.sources"],
			max_output_tokens: 128,
		});
		expect(search.status).toBe(200);
		expect(search.headers.get("x-credne-account")).toBe(key);
		const payload = object(await search.json());
		expect(JSON.stringify(payload.output)).toContain("https://example.com/source");
		expect(JSON.stringify(payload.output)).toContain("web_search_call");
		expect(object(array(seen[0].body.tools)[0]).type).toBe("web_search");
		expect(seen[0].body.include).toContain("web_search_call.action.sources");
		expect(seen[0].authorization).toBe("Bearer project-secret");
		const chat = await request("/chat/completions", {
			model: "gpt-test",
			stream: true,
			messages: [{ role: "user", content: "hello" }],
			tools: [
				{
					type: "function",
					function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
				},
			],
		});
		expect(chat.status).toBe(200);
		const wire = await chat.text();
		expect(wire).toContain("tool_calls");
		expect(wire).toContain("[DONE]");
		expect(seen.at(-1)?.path).toBe("/v1/chat/completions");
	} finally {
		await broker.close();
		await upstream.stop(true);
		await rm(home, { recursive: true, force: true });
	}
}, 20000);
