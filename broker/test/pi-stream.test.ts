import { expect, test } from "bun:test";
import { AuthStorage, setUnpausedProviders } from "@oh-my-pi/pi-ai";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway/server";
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
	piHeaders,
	piText,
	refusal,
	responsesReply,
	subscription,
} from "./fixtures.ts";

test("a pinned request reaches the provider exactly as OMP's own gateway server sends it", async () => {
	const upstream = fakeUpstream(() => anthropicReply("Hello from the fake."));
	const h = await harness(upstream.origin);
	try {
		const account = await h.add("claude-key", "claude-api", apiKey("sk-ant-key"), ["claude-test"]);
		const body = piBody("anthropic/claude-test", "session-1", {
			context: {
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } } },
					},
				],
			},
			options: { cacheRetention: "long" },
		});
		// OMP's own server over the same model and key: the request the broker must not alter.
		const storage = await AuthStorage.create(":memory:");
		storage.keys.setRuntime("anthropic", "sk-ant-key");
		const reference = createAuthGatewayRouter({ storage, resolveModel: () => account.models[0] });
		const direct = await reference.route(
			new Request("http://gateway/v1/pi/stream", { method: "POST", headers: piHeaders("gateway-token"), body }),
			"loopback",
		);
		expect(piText(await piEvents(direct))).toBe("Hello from the fake.");
		reference.close();
		storage.close();

		const response = await h.send(`a.${accountKey("claude-key")}`, body);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-credne-account")).toBe(accountKey("claude-key"));
		expect(piText(await piEvents(response))).toBe("Hello from the fake.");

		const [expected, actual] = upstream.calls;
		expect(upstream.calls).toHaveLength(2);
		expect(callToken(actual)).toBe("sk-ant-key");
		expect(actual.body).toBe(expected.body);
		const volatile = new Set(["x-client-request-id", "x-stainless-timeout", "content-length"]);
		const stable = (headers: Headers) => [...headers].filter(([name]) => !volatile.has(name));
		expect(stable(actual.headers)).toEqual(stable(expected.headers));
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
}, 20000);

test("Claude pools favor subscriptions, fail over on limits and return to them after a reset", async () => {
	const model = "claude-test";
	const limited = new Set<string>();
	const upstream = fakeUpstream((call) =>
		limited.has(callToken(call)) ? refusal(429, "Rate limited", { "retry-after": "60" }) : anthropicReply(),
	);
	const h = await harness(upstream.origin);
	setUnpausedProviders(["anthropic"]);
	const apiKeys = ["key-one", "key-two"];
	const subscriptions = ["sk-ant-oat01-one", "sk-ant-oat01-two"];
	let turn = 0;
	// Each request names its session; a repeated name is the same conversation.
	const send = async (target: string, session = `anonymous-${turn++}`, id = model) => {
		const before = upstream.calls.length;
		const response = await h.send(target, piBody(`anthropic/${id}`, session));
		expect(response.status).toBe(200);
		expect(piText(await piEvents(response))).toBe("Done.");
		const tokens = upstream.calls.slice(before).map(callToken);
		expect(response.headers.get("x-credne-account")).toBe(accountKey(tokens.at(-1)!));
		return tokens;
	};
	try {
		for (const key of apiKeys) await h.add(key, "claude-api", apiKey(key), [model, "claude-key-only"]);
		for (const access of subscriptions) await h.add(access, "claude", subscription(access), [model]);
		for (const pool of ["p.claude", "p.all"]) {
			h.accounts.routing.strategy = "fill-first";
			const [affine] = await send(pool, "thread");
			expect(affine).toBe(subscriptions[0]);
			expect(await send(pool, undefined, "claude-key-only")).toEqual([apiKeys[0]]);
			expect(await send(`a.${accountKey(apiKeys[0])}`, "thread")).toEqual([apiKeys[0]]);
			h.accounts.routing.strategy = "round-robin";
			const rotated = [...(await send(pool)), ...(await send(pool))];
			expect(rotated.sort()).toEqual([...subscriptions].sort());
			expect(await send(pool, "thread")).toEqual([affine]);
			// A limit cuts the attempt at the provider's first answer; the pool moves on with the same request.
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
			await h.accounts.mutate(h.accounts.accounts.get(affine)!, "reset");
			expect(await send(pool, "thread")).toEqual([affine]);
			limited.clear();
			await h.accounts.mutate(h.accounts.accounts.get(subscriptions[1])!, "reset");
		}
	} finally {
		await h.close();
		await upstream.server.stop(true);
		setUnpausedProviders([]);
	}
}, 30000);

test("a pinned account is never abandoned: OMP retries, and only the final answer is recorded", async () => {
	let refusals = 1;
	let stop = false;
	const upstream = fakeUpstream(() => {
		if (stop) return refusal(429, "Rate limited", { "retry-after": "60", "x-should-retry": "false" });
		return refusals-- > 0 ? refusal(429, "Rate limited", { "retry-after": "1" }) : anthropicReply();
	});
	const h = await harness(upstream.origin);
	const target = `a.${accountKey("limited")}`;
	try {
		await h.add("limited", "claude-api", apiKey("key-limited"), ["claude-test"]);
		await h.add("spare", "claude-api", apiKey("key-spare"), ["claude-test"]);
		const state = () => h.accounts.accounts.get("limited")!;
		// A 429 that OMP's own retry gets past is not a limit: no failover, and the account is not benched.
		const recovered = await h.send(target, piBody("anthropic/claude-test", "pinned"));
		expect(piText(await piEvents(recovered))).toBe("Done.");
		expect(upstream.calls.map(callToken)).toEqual(["key-limited", "key-limited"]);
		expect(state().cooldown).toBe(0);
		// A 429 OMP gives up on benches the account, still without a failover.
		stop = true;
		const refused = await h.send(target, piBody("anthropic/claude-test", "pinned"));
		expect((await piEvents(refused)).at(-1)).toMatchObject({ type: "error" });
		expect(upstream.calls.map(callToken)).toEqual(["key-limited", "key-limited", "key-limited"]);
		expect(state().cooldown).toBeGreaterThan(Date.now() + 50000);
		const cooling = await h.send(target, piBody("anthropic/claude-test", "pinned"));
		expect(cooling.status).toBe(429);
		expect(cooling.headers.get("retry-after")).not.toBeNull();
		expect(upstream.calls).toHaveLength(3);
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
}, 30000);

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("a 400 is never a failover: OMP's thinking-signature recovery runs on the same account", async () => {
	const model = "claude-sonnet-5";
	const upstream = fakeUpstream((call) =>
		call.body.includes("stale-signature")
			? refusal(400, "messages.1.content.0: Invalid `signature` in `thinking` block")
			: anthropicReply("Recovered."),
	);
	const h = await harness(upstream.origin);
	try {
		h.accounts.routing.strategy = "fill-first";
		await h.add("first", "claude-api", apiKey("key-first"), [model]);
		await h.add("second", "claude-api", apiKey("key-second"), [model]);
		const history = [
			{ role: "user", content: "question", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "earlier reasoning", thinkingSignature: "stale-signature" },
					{ type: "text", text: "earlier answer" },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model,
				usage,
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: "follow up", timestamp: 3 },
		];
		const response = await h.send(
			"p.claude",
			piBody(`anthropic/${model}`, "recovery", { context: { messages: history }, options: { reasoning: "high" } }),
		);
		expect(piText(await piEvents(response))).toBe("Recovered.");
		// OMP retries the demoted body, then drops the replayed thinking; every try is on the first account.
		expect(new Set(upstream.calls.map(callToken))).toEqual(new Set(["key-first"]));
		expect(upstream.calls.length).toBeGreaterThan(1);
		expect(upstream.calls[0].body).toContain("stale-signature");
		expect(upstream.calls.at(-1)!.body).not.toContain("stale-signature");
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
}, 30000);

test("a 400 recovery cannot fix is the caller's answer, not a reason to try another account", async () => {
	const upstream = fakeUpstream(() => refusal(400, "max_tokens must be positive"));
	const h = await harness(upstream.origin);
	try {
		h.accounts.routing.strategy = "fill-first";
		await h.add("first", "claude-api", apiKey("key-first"), ["claude-test"]);
		await h.add("second", "claude-api", apiKey("key-second"), ["claude-test"]);
		const response = await h.send("p.claude", piBody("anthropic/claude-test", "malformed"));
		expect(response.status).toBe(200);
		expect(response.headers.get("x-credne-account")).toBe(accountKey("first"));
		const events = await piEvents(response);
		expect(events.at(-1)).toMatchObject({ type: "error" });
		expect(JSON.stringify(events.at(-1))).toContain("max_tokens must be positive");
		expect(upstream.calls.map(callToken)).toEqual(["key-first"]);
		expect(h.accounts.accounts.get("first")!.cooldown).toBe(0);
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
}, 30000);

test("an empty credit balance benches the account for an hour and the pool moves on", async () => {
	const upstream = fakeUpstream((call) =>
		callToken(call) === "key-poor"
			? refusal(400, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.")
			: anthropicReply(),
	);
	const h = await harness(upstream.origin);
	try {
		h.accounts.routing.strategy = "fill-first";
		await h.add("poor", "claude-api", apiKey("key-poor"), ["claude-test"]);
		await h.add("rich", "claude-api", apiKey("key-rich"), ["claude-test"]);
		const response = await h.send("p.claude", piBody("anthropic/claude-test", "billing"));
		expect(piText(await piEvents(response))).toBe("Done.");
		expect(response.headers.get("x-credne-account")).toBe(accountKey("rich"));
		expect(upstream.calls.map(callToken)).toEqual(["key-poor", "key-rich"]);
		const poor = h.accounts.accounts.get("poor")!;
		expect(poor.lastStatus).toBe(402);
		expect(poor.cooldown).toBeGreaterThan(Date.now() + 3500 * 1000);
		// Benched, it is skipped without a call.
		await piEvents(await h.send("p.claude", piBody("anthropic/claude-test", "billing")));
		expect(upstream.calls.map(callToken)).toEqual(["key-poor", "key-rich", "key-rich"]);
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
}, 30000);

test("a subscription request is sent exactly as OMP's own gateway server would send it", async () => {
	const upstream = fakeUpstream(() => anthropicReply("Hello."));
	const h = await harness(upstream.origin);
	setUnpausedProviders(["anthropic"]);
	try {
		const credential = subscription("sk-ant-oat01-exact");
		const account = await h.add("sub", "claude", credential, ["claude-test"]);
		const body = piBody("anthropic/claude-test", "oauth-session", {
			context: {
				tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
			},
		});
		const storage = await AuthStorage.create(":memory:");
		await storage.credentials.set("anthropic", credential);
		const reference = createAuthGatewayRouter({ storage, resolveModel: () => account.models[0] });
		const direct = await reference.route(
			new Request("http://gateway/v1/pi/stream", { method: "POST", headers: piHeaders("gateway-token"), body }),
			"loopback",
		);
		expect(piText(await piEvents(direct))).toBe("Hello.");
		reference.close();
		storage.close();

		const response = await h.send(`a.${accountKey("sub")}`, body);
		expect(piText(await piEvents(response))).toBe("Hello.");
		const [expected, actual] = upstream.calls;
		expect(callToken(actual)).toBe("sk-ant-oat01-exact");
		expect(actual.headers.get("x-api-key")).toBeNull();
		expect(actual.body).toBe(expected.body);
		expect(actual.body).toContain("cch=");
		const volatile = new Set(["x-client-request-id", "x-stainless-timeout", "content-length"]);
		const stable = (headers: Headers) => [...headers].filter(([name]) => !volatile.has(name));
		expect(stable(actual.headers)).toEqual(stable(expected.headers));
	} finally {
		await h.close();
		await upstream.server.stop(true);
		setUnpausedProviders([]);
	}
}, 20000);

test("a subscription that cannot serve never borrows a key from the broker's environment", async () => {
	const upstream = fakeUpstream(() => anthropicReply("Hello."));
	// OMP refreshes the expired token at the provider; a rejected refresh leaves the credential unusable.
	const h = await harness(upstream.origin, () => Response.json({ error: "invalid_grant" }, { status: 400 }));
	setUnpausedProviders(["anthropic"]);
	const previous = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "sk-ant-env-key";
	try {
		const expired = { ...subscription("sk-ant-oat01-expired"), expires: Date.now() - 60000 };
		const account = await h.add("sub", "claude", expired, ["claude-test"]);
		const body = piBody("anthropic/claude-test", "locked");

		// Without the broker's lock, OMP's own gateway server falls through to the environment key.
		const storage = await AuthStorage.create(":memory:");
		await storage.credentials.set("anthropic", expired);
		const reference = createAuthGatewayRouter({ storage, resolveModel: () => account.models[0] });
		await (
			await reference.route(
				new Request("http://gateway/v1/pi/stream", { method: "POST", headers: piHeaders("gateway-token"), body }),
				"loopback",
			)
		).text();
		reference.close();
		storage.close();
		expect(upstream.calls.map(callToken)).toEqual(["sk-ant-env-key"]);

		upstream.calls.length = 0;
		const response = await h.send(`a.${accountKey("sub")}`, body);
		const refused = response.ok ? (await piEvents(response)).at(-1) : await response.json();
		expect(JSON.stringify(refused)).toMatch(/error/);
		expect(upstream.calls).toHaveLength(0);
	} finally {
		if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = previous;
		await h.close();
		await upstream.server.stop(true);
		setUnpausedProviders([]);
	}
}, 20000);

test("the global GPT pool returns to ChatGPT before charging a previously used API key", async () => {
	const model = "gpt-5.4";
	const access = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;
	let subscriptionRateLimited = false;
	const upstream = fakeUpstream((call) =>
		subscriptionRateLimited && callToken(call) === access
			? refusal(429, "Usage limit", { "retry-after": "60" })
			: responsesReply(model),
	);
	const h = await harness(upstream.origin);
	const record = { baseUrl: upstream.origin };
	const send = async (target = "p.all", id = model) => {
		const response = await h.send(target, piBody(id, "same-chat"));
		const events = await piEvents(response);
		return { status: response.status, account: response.headers.get("x-credne-account"), events };
	};
	try {
		await h.add("paid", "openai-api", apiKey("test-key"), [model], record);
		expect((await send()).account).toBe(accountKey("paid"));
		// The listing names the OMP identity each account's router resolves the model to.
		expect(publicModels(h.accounts.accounts.get("paid")!)[0]).toMatchObject({
			id: model,
			provider: "openai",
			api: "openai-responses",
		});
		const subscriptionAccount = await h.add(
			"subscription",
			"codex",
			{ type: "oauth", access, refresh: "fixture", accountId: "test", expires: Date.now() + 3600000 },
			[model],
			record,
		);
		expect(publicModels(subscriptionAccount)[0]).toMatchObject({
			id: model,
			provider: "openai-codex",
			api: "openai-codex-responses",
		});
		const served = await send();
		expect(served.account).toBe(accountKey("subscription"));
		expect(piText(served.events)).toBe("Done");
		subscriptionRateLimited = true;
		expect((await send()).account).toBe(accountKey("paid"));
		subscriptionRateLimited = false;
		await h.accounts.mutate(subscriptionAccount, "reset");
		expect((await send()).account).toBe(accountKey("subscription"));
		expect((await send(`a.${accountKey("paid")}`)).account).toBe(accountKey("paid"));
		await h.add("unrelated", "claude-api", apiKey("other-fixture"), [model], record);
		expect((await send()).status).toBe(409);
		expect((await send("p.codex")).account).toBe(accountKey("subscription"));
		expect(upstream.calls.map(callToken)).toEqual([
			"test-key",
			access,
			access,
			"test-key",
			access,
			"test-key",
			access,
		]);
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
}, 30000);

test("the route refuses what it cannot place and keeps the broker's own credential from the provider", async () => {
	const upstream = fakeUpstream(() => anthropicReply());
	const h = await harness(upstream.origin);
	try {
		await h.add("key", "claude-api", apiKey("sk-ant-key"), ["claude-test"]);
		await h.add("off", "claude-api", apiKey("sk-ant-off"), ["claude-test"], { disabled: true });
		const pinned = `a.${accountKey("key")}`;
		const model = "anthropic/claude-test";
		await expect(h.send(pinned, "not json")).rejects.toMatchObject({ status: 400, message: "Invalid JSON body." });
		await expect(h.send(pinned, JSON.stringify({ context: {} }))).rejects.toMatchObject({
			status: 400,
			message: "modelId is required",
		});
		// The session id keys the credential lock and the pool's affinity; OMP would derive one the broker cannot know.
		for (const sessionId of [undefined, "", "  "])
			await expect(h.send(pinned, piBody(model, sessionId))).rejects.toMatchObject({
				status: 400,
				message: "options.sessionId is required",
			});
		await expect(h.send("x.claude", piBody(model, "s"))).rejects.toMatchObject({ status: 404 });
		await expect(h.send(`a.${accountKey("missing")}`, piBody(model, "s"))).rejects.toMatchObject({ status: 404 });
		const unlisted = await h.send(pinned, piBody("anthropic/claude-unlisted", "s"));
		expect(unlisted.status).toBe(404);
		expect(await unlisted.text()).toContain("No enabled account serves this model.");
		expect((await h.send(`a.${accountKey("off")}`, piBody(model, "s"))).status).toBe(403);
		expect((await h.send("p.codex", piBody(model, "s"))).status).toBe(404);
		expect(upstream.calls).toHaveLength(0);

		// A bare model ID and the provider-qualified one name the same model.
		for (const id of ["claude-test", model])
			expect(piText(await piEvents(await h.send(pinned, piBody(id, "s"))))).toBe("Done.");
		expect(upstream.calls).toHaveLength(2);
		for (const call of upstream.calls) {
			expect(callToken(call)).toBe("sk-ant-key");
			expect(JSON.stringify([...call.headers])).not.toMatch(/broker-token|x-omp-/);
		}
	} finally {
		await h.close();
		await upstream.server.stop(true);
	}
}, 20000);
