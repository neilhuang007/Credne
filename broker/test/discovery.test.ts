// Subscription model discovery: a subscription serves the models its provider lists for it, not only the bundled ones.
import { expect, test } from "bun:test";
import { publicModels } from "../src/accounts.ts";
import {
	accountKey,
	anthropicReply,
	apiKey,
	callToken,
	fakeUpstream,
	harness,
	piBody,
	piEvents,
	piText,
	responsesReply,
	subscription,
} from "./fixtures.ts";

const newModel = "gpt-6.9-test";
const access = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.test`;
const codexListing = {
	models: [
		{
			slug: newModel,
			display_name: "GPT-6.9 Test",
			context_window: 400000,
			supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
			input_modalities: ["text", "image"],
		},
		{ slug: "gpt-5.4" },
	],
};

test("a ChatGPT subscription serves the models its provider lists, and the pool prefers it for a new one", async () => {
	const upstream = fakeUpstream(() => responsesReply(newModel));
	const listings: Request[] = [];
	const h = await harness(upstream.origin, (request) => {
		if (!new URL(request.url).pathname.endsWith("/codex/models")) return new Response(null, { status: 404 });
		listings.push(request);
		return Response.json(codexListing);
	});
	const record = { baseUrl: upstream.origin };
	try {
		await h.add("paid", "openai-api", apiKey("test-key"), [newModel], record);
		const plan = await h.add(
			"plan",
			"codex",
			{ type: "oauth", access, refresh: "fixture", accountId: "acct-1", expires: Date.now() + 3600000 },
			[],
			record,
		);
		expect(plan.models.some((model) => model.id === newModel)).toBe(false);

		await Promise.all([h.accounts.refreshSubscriptionModels(plan), h.accounts.refreshSubscriptionModels(plan)]);
		// Concurrent callers share one read with the account's own sign-in.
		expect(listings).toHaveLength(1);
		expect(listings[0]!.headers.get("authorization")).toBe(`Bearer ${access}`);
		expect(listings[0]!.headers.get("chatgpt-account-id")).toBe("acct-1");
		expect(plan.models.map((model) => model.id).sort()).toEqual(["gpt-5.4", newModel]);
		expect(publicModels(plan).find((model) => model.id === newModel)).toMatchObject({
			provider: "openai-codex",
			api: "openai-codex-responses",
			displayName: "GPT-6.9 Test",
			contextLength: 400000,
		});
		expect(plan.models.every((model) => model.preferWebsockets === false)).toBe(true);

		const response = await h.send("p.all", piBody(newModel, "chat"));
		expect(response.headers.get("x-credne-account")).toBe(accountKey("plan"));
		expect(piText(await piEvents(response))).toBe("Done");
		expect(upstream.calls.map(callToken)).toEqual([access]);

		// Within the discovery interval, another model request reads nothing.
		await h.accounts.refreshSubscriptionModels(plan);
		expect(listings).toHaveLength(1);
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
});

test("a failed listing keeps the bundled models, and API keys are never listed this way", async () => {
	const upstream = fakeUpstream(() => responsesReply(newModel));
	const external: string[] = [];
	const h = await harness(upstream.origin, (request) => {
		external.push(request.url);
		return new Response("down", { status: 503 });
	});
	try {
		const plan = await h.add("plan", "codex", subscription(access), []);
		const bundled = plan.models.map((model) => model.id);
		await h.accounts.refreshSubscriptionModels(plan);
		expect(plan.models.map((model) => model.id)).toEqual(bundled);
		expect(external.length).toBeGreaterThan(0);

		const key = await h.add("paid", "openai-api", apiKey("test-key"), [newModel]);
		const before = external.length;
		await h.accounts.refreshSubscriptionModels(key);
		expect(external).toHaveLength(before);
		expect(key.models.map((model) => model.id)).toEqual([newModel]);
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
});

test("a Claude subscription lists its models with its own sign-in at the Anthropic endpoint", async () => {
	const claudeModel = "claude-test-9";
	const upstream = fakeUpstream((call) =>
		call.path === "/v1/models"
			? Response.json({ data: [{ id: claudeModel, display_name: "Claude Test 9", type: "model" }], has_more: false })
			: anthropicReply("Hello."),
	);
	const h = await harness(upstream.origin);
	try {
		const plan = await h.add("claude-plan", "claude", subscription("sk-ant-oat01-plan"), []);
		await h.accounts.refreshSubscriptionModels(plan);
		const listing = upstream.calls.find((call) => call.path === "/v1/models");
		expect(listing?.headers.get("authorization")).toBe("Bearer sk-ant-oat01-plan");
		expect(listing?.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
		const listed = publicModels(plan);
		expect(listed[0]).toMatchObject({ id: claudeModel, provider: "anthropic", api: "anthropic-messages" });
		// Anthropic's listing is not authoritative in OMP: bundled IDs it omits stay, including OMP's Haiku search swap.
		expect(listed.map((model) => model.id)).toContain("claude-haiku-4-5");
		const response = await h.send("p.claude", piBody(claudeModel, "chat"));
		expect(response.headers.get("x-credne-account")).toBe(accountKey("claude-plan"));
		expect(piText(await piEvents(response))).toBe("Hello.");
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
});
