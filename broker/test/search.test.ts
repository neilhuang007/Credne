// Hosted web search: the broker sends each subscription search the way oh-my-pi's own web_search does.
import { expect, test } from "bun:test";
import { accountKey, apiKey, fakeUpstream, harness, subscription } from "./fixtures.ts";

const searchBody = (modelId: string, query: string) => JSON.stringify({ modelId, sessionId: "session-7", query });

const search = (h: Awaited<ReturnType<typeof harness>>, account: string, body: string) =>
	h.gateway.execute(
		new Request("http://gateway-test", { method: "POST", headers: { "content-type": "application/json" }, body }),
		`a.${accountKey(account)}`,
		"/search",
	);

test("a Claude subscription searches on its Haiku swap with OMP's search request", async () => {
	const upstream = fakeUpstream(() =>
		Response.json({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-haiku-4-5",
			stop_reason: "end_turn",
			content: [
				{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "node lts" } },
				{
					type: "web_search_tool_result",
					tool_use_id: "srv_1",
					content: [
						{ type: "web_search_result", url: "https://nodejs.org/en", title: "Node.js", page_age: "2 days ago" },
					],
				},
				{ type: "text", text: "Node 26 is LTS." },
			],
			usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
		}),
	);
	const h = await harness(upstream.origin);
	try {
		await h.add("claude-plan", "claude", subscription("sk-ant-oat01-plan"), []);
		const response = await search(h, "claude-plan", searchBody("claude-opus-5-5", "node lts site:nodejs.org"));
		expect(response.status).toBe(200);
		expect(response.headers.get("x-credne-account")).toBe(accountKey("claude-plan"));
		const result = (await response.json()) as { provider: string; answer: string; sources: { url: string }[] };
		expect(result).toMatchObject({ provider: "anthropic", answer: "Node 26 is LTS." });
		expect(result.sources.map((source) => source.url)).toEqual(["https://nodejs.org/en"]);

		expect(upstream.calls).toHaveLength(1);
		const [call] = upstream.calls;
		expect(call!.path).toBe("/v1/messages");
		expect(call!.headers.get("authorization")).toBe("Bearer sk-ant-oat01-plan");
		expect(call!.headers.get("anthropic-beta")).toContain("web-search-2025-03-05");
		const body = JSON.parse(call!.body);
		expect(body.model).toBe("claude-haiku-4-5");
		expect(body.messages).toEqual([{ role: "user", content: "node lts site:nodejs.org" }]);
		expect(body.tools).toEqual([
			{ type: "web_search_20250305", name: "web_search", allowed_domains: ["nodejs.org"] },
		]);
		expect(body.stream).toBeUndefined();
		// OMP's OAuth fingerprint: the billing header block with its cch attestation patched in, then the instructions.
		expect(body.system[0].text).toMatch(/^x-anthropic-billing-header: .*cch=(?!00000)[0-9a-f]{5};/);
		expect(JSON.stringify(body.system)).toContain("Always call web_search at least once");
		expect(JSON.parse(body.metadata.user_id)).toMatchObject({ session_id: "session-7" });
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
});

test("a ChatGPT subscription searches on GPT-6 Luna through the Codex backend with OMP's headers", async () => {
	const requests: { url: string; headers: Headers; body: string }[] = [];
	const sse = [
		{ type: "response.created", response: { id: "resp_1", model: "gpt-6-luna" } },
		{
			type: "response.output_item.done",
			item: {
				type: "web_search_call",
				status: "completed",
				action: { type: "search", sources: [{ type: "url", url: "https://nodejs.org/en/about/releases" }] },
			},
		},
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: "Node 26 is LTS.",
						annotations: [
							{ type: "url_citation", url: "https://nodejs.org/en/about/releases", title: "Releases" },
						],
					},
				],
			},
		},
		{ type: "response.completed", response: { id: "resp_1", model: "gpt-6-luna", usage: { input_tokens: 9 } } },
	]
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join("");
	const upstream = fakeUpstream(() => new Response(null, { status: 404 }));
	const h = await harness(upstream.origin, async (request) => {
		requests.push({ url: request.url, headers: request.headers, body: await request.text() });
		return new Response(sse, { headers: { "content-type": "text/event-stream" } });
	});
	const access = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } })).toString("base64url")}.test`;
	try {
		await h.add(
			"plan",
			"codex",
			{ type: "oauth", access, refresh: "fixture", accountId: "acct-9", expires: Date.now() + 3600000 },
			[],
		);
		const response = await search(h, "plan", searchBody("gpt-6-sol", "node lts"));
		expect(response.status).toBe(200);
		const result = (await response.json()) as { provider: string; sources: { url: string; title: string }[] };
		expect(result.provider).toBe("codex");
		expect(result.sources).toEqual([
			expect.objectContaining({ url: "https://nodejs.org/en/about/releases", title: "Releases" }),
		]);

		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(request!.headers.get("authorization")).toBe(`Bearer ${access}`);
		expect(request!.headers.get("chatgpt-account-id")).toBe("acct-9");
		expect(request!.headers.get("originator")).toBe("omp");
		expect(request!.headers.get("user-agent")).toMatch(/^omp\//);
		const body = JSON.parse(request!.body);
		expect(body).toMatchObject({
			model: "gpt-6-luna",
			stream: true,
			store: false,
			include: ["web_search_call.action.sources"],
			tools: [{ type: "web_search", search_context_size: "high" }],
			tool_choice: { type: "web_search" },
			input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "node lts" }] }],
		});
		expect(body.instructions).toContain("Web research assistant");
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
});

test("search refuses API keys and pool routes, and a usage limit benches the account", async () => {
	const upstream = fakeUpstream(() =>
		Response.json({ type: "error", error: { type: "rate_limit_error", message: "limit" } }, { status: 429 }),
	);
	const h = await harness(upstream.origin);
	try {
		await h.add("key", "claude-api", apiKey("sk-ant-key"), ["claude-opus-5-5"]);
		expect((await search(h, "key", searchBody("claude-opus-5-5", "q"))).status).toBe(400);
		await expect(
			h.gateway.execute(new Request("http://gateway-test", { method: "POST", body: "{}" }), "p.all", "/search"),
		).rejects.toThrow("pinned account route");

		const plan = await h.add("claude-plan", "claude", subscription("sk-ant-oat01-plan"), []);
		const limited = await search(h, "claude-plan", searchBody("claude-opus-5-5", "q"));
		expect(limited.status).toBe(429);
		expect(plan.cooldown).toBeGreaterThan(Date.now());
		// The swap and then the session model were tried, as in OMP.
		expect(upstream.calls.map((call) => JSON.parse(call.body).model)).toEqual([
			"claude-haiku-4-5",
			"claude-opus-5-5",
		]);
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
});
