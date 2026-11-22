import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { OAuthAccounts } from "@oh-my-pi/pi-ai/auth/oauth";
import { startBroker } from "../src/service.ts";
import { array, object } from "../src/wire.ts";
import { anthropicReply, fakeNetwork, fakeUpstream, piBody, piEvents, piText, refusal } from "./fixtures.ts";

test("manual OAuth callbacks bind to pending state and renew duplicate identities without adding siblings", async () => {
	const home = await mkdtemp(join(tmpdir(), "credne-login-"));
	const realFetch = globalThis.fetch;
	const network: { fetch: FetchImpl } = globalThis;
	let exchanges = 0;
	const token = `test.${Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "workspace" },
			"https://api.openai.com/profile": { email: "test@example.com" },
		}),
	).toString("base64url")}.test`;
	const transport = spyOn(network, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(request);
		if (url.href !== "https://auth.openai.com/oauth/token") throw new Error("Unexpected provider network request");
		expect(await request.text()).toContain("secret-code");
		exchanges++;
		return Response.json({ access_token: token, refresh_token: "private-refresh", expires_in: 3600 });
	});
	const broker = await startBroker({ home, idleTimeout: 0 });
	if (!broker) throw new Error("No test broker");
	const request = (path: string, body?: unknown) =>
		fetch(`${broker.state.url}/credne/v1${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${broker.state.token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	try {
		for (const duplicate of [false, true]) {
			const started = object(await (await request("/logins", { provider: "codex" })).json());
			const state = String(started.state);
			const authorize = new URL(String(started.url));
			const callback = new URL(authorize.searchParams.get("redirect_uri")!);
			callback.searchParams.set("state", authorize.searchParams.get("state")!);
			callback.searchParams.set("code", "secret-code");
			const wrongState = new URL(callback);
			wrongState.searchParams.set("state", "wrong");
			const wrongHost = new URL(callback);
			wrongHost.hostname = "evil.test";
			expect((await request(`/logins/${state}/callback`, { redirectUrl: wrongState.href })).status).toBe(400);
			expect((await request(`/logins/${state}/callback`, { redirectUrl: wrongHost.href })).status).toBe(400);
			expect((await request(`/logins/${state}/callback`, { redirectUrl: callback.href })).status).toBe(200);
			let result = object(await (await request(`/logins/${state}`)).json());
			const deadline = Date.now() + 5000;
			while (result.status === "wait" && Date.now() < deadline)
				result = object(await (await request(`/logins/${state}`)).json());
			expect(result.status).toBe(duplicate ? "error" : "ok");
			if (duplicate) expect(result.error).toContain("sign-in was renewed");
			expect(JSON.stringify(result)).not.toContain(token);
			expect(JSON.stringify(result)).not.toMatch(/private-refresh|secret-code/);
		}
		expect(object(await (await request("/accounts")).json()).accounts).toBeArrayOfSize(1);
		expect(exchanges).toBe(2);
	} finally {
		await broker.close();
		transport.mockRestore();
		await rm(home, { recursive: true, force: true });
	}
}, 20000);

test("Claude OAuth waits for explicit risk consent, and OMP refreshes the token it sends", async () => {
	const home = await mkdtemp(join(tmpdir(), "credne-claude-login-"));
	const actualLogin = OAuthAccounts.prototype.login;
	const warning = "Provider account restrictions apply. Proceed only if you accept the risk.";
	const login = spyOn(OAuthAccounts.prototype, "login").mockImplementation(async function (
		this: OAuthAccounts,
		provider,
		controller,
	) {
		expect(provider).toBe("anthropic");
		const answer = await controller.onPrompt({ message: warning, riskAcknowledgement: true });
		if (answer !== "yes") return undefined;
		return actualLogin.call(this, provider, controller);
	});
	const access = "sk-ant-oat01-fixture-subscription";
	const tokenUrl = "https://api.anthropic.com/v1/oauth/token";
	let exchanges = 0;
	const model = "claude-sonnet-5";
	// The first Messages request finds the token expired; OMP's own 401 recovery then refreshes it and retries.
	const upstream = fakeUpstream((call) =>
		call.headers.get("authorization") === `Bearer ${access}` ? refusal(401, "expired") : anthropicReply("Done."),
	);
	const network = fakeNetwork(async (request) => {
		if (request.url !== tokenUrl) return new Response(null, { status: 404 });
		const body = object(await request.json());
		exchanges++;
		expect(body.grant_type).toBe(exchanges === 1 ? "authorization_code" : "refresh_token");
		return Response.json({
			access_token: exchanges === 1 ? access : `${access}-renewed`,
			refresh_token: "private-refresh",
			expires_in: 3600,
			account: { uuid: "account-id", email_address: "claude@example.com" },
			organization: { uuid: "org-id", name: "Claude Max" },
		});
	});
	const broker = await startBroker({ home, idleTimeout: 0, anthropicBaseUrl: upstream.origin });
	if (!broker) throw new Error("No test broker");
	const request = (path: string, body?: unknown, method?: string) =>
		fetch(`${broker.state.url}/credne/v1${path}`, {
			method: method ?? (body === undefined ? "GET" : "POST"),
			headers: { authorization: `Bearer ${broker.state.token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	try {
		const declined = object(await (await request("/logins", { provider: "claude", acknowledgeRisk: true })).json());
		expect(declined).toMatchObject({ url: "", riskWarning: warning });
		const declinedPath = `/logins/${declined.state}`;
		expect(
			(await request(`${declinedPath}/callback`, { redirectUrl: "http://localhost:54545/callback?code=private" }))
				.status,
		).toBe(409);
		expect((await request(`${declinedPath}/acknowledge`, { answer: true })).status).toBe(400);
		expect((await request(declinedPath, undefined, "DELETE")).status).toBe(200);
		expect(exchanges).toBe(0);
		const started = object(await (await request("/logins", { provider: "claude" })).json());
		expect(started).toMatchObject({ url: "", riskWarning: warning });
		const path = `/logins/${started.state}`;
		const allowed = await request(`${path}/acknowledge`, { answer: "yes" });
		expect(allowed.status).toBe(200);
		const authorized = object(await allowed.json());
		const authorize = new URL(String(authorized.url));
		expect(authorize.origin).toBe("https://claude.ai");
		expect(authorized.riskWarning).toBeUndefined();
		expect((await request(`${path}/acknowledge`, { answer: "yes" })).status).toBe(409);
		const callback = new URL(authorize.searchParams.get("redirect_uri")!);
		callback.searchParams.set("state", authorize.searchParams.get("state")!);
		callback.searchParams.set("code", "private-code");
		expect((await request(`${path}/callback`, { redirectUrl: callback.href })).status).toBe(200);
		let result = object(await (await request(path)).json());
		const deadline = Date.now() + 5000;
		while (result.status === "wait" && Date.now() < deadline) result = object(await (await request(path)).json());
		expect(result.status).toBe("ok");
		const account = object(result.account);
		expect(account).toMatchObject({ email: "claude@example.com", kind: "oauth", provider: "claude" });
		expect(JSON.stringify(result)).not.toContain(access);

		for (const [target, session] of [
			[`a.${account.key}`, "login-pinned"],
			["p.claude", "login-pooled"],
		] as const) {
			const reply = await request(`/route/${target}/pi/stream`, JSON.parse(piBody(`anthropic/${model}`, session)));
			expect(reply.status).toBe(200);
			expect(reply.headers.get("x-credne-account")).toBe(String(account.key));
			expect(piText(await piEvents(reply))).toBe("Done.");
		}
		expect(exchanges).toBe(2);
		const received = upstream.calls;
		expect(received).toHaveLength(3);
		for (const [index, wire] of received.entries()) {
			expect(wire.headers.get("authorization")).toBe(`Bearer ${access}${index === 0 ? "" : "-renewed"}`);
			expect(wire.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
			expect(wire.headers.has("x-api-key")).toBe(false);
			expect(wire.headers.has("chatgpt-account-id")).toBe(false);
		}
	} finally {
		await broker.close();
		login.mockRestore();
		network.restore();
		await upstream.server.stop(true);
		await rm(home, { recursive: true, force: true });
	}
}, 20000);

test("retired Console accounts are ignored without removing saved metadata or credentials", async () => {
	const home = await mkdtemp(join(tmpdir(), "credne-retired-credits-"));
	const retired = { id: "claude-api-credits-work", kind: "api-credits", profile: "credne-work", organization: "Work" };
	const saved = join(home, "api-accounts.json");
	const legacy = join(home, "auths", "claude-legacy.json");
	const profile = join(home, "ant", "credentials.json");
	await mkdir(join(home, "ant"));
	await mkdir(join(home, "auths"));
	await writeFile(profile, "private-profile");
	await writeFile(saved, JSON.stringify({ accounts: [retired] }));
	const legacyJson = JSON.stringify({
		type: "claude",
		email: "legacy@example.com",
		access_token: "sk-ant-oat01-legacy",
		refresh_token: "legacy-refresh",
		expired: new Date(Date.now() + 3600000).toISOString(),
	});
	await writeFile(legacy, legacyJson);
	const broker = await startBroker({ home, idleTimeout: 0 });
	if (!broker) throw new Error("No test broker");
	try {
		const headers = { authorization: `Bearer ${broker.state.token}` };
		const accounts = object(await (await fetch(`${broker.state.url}/credne/v1/accounts`, { headers })).json());
		expect(accounts.accounts).toMatchObject([{ provider: "claude", kind: "oauth", email: "legacy@example.com" }]);
		const start = await fetch(`${broker.state.url}/credne/v1/logins`, {
			method: "POST",
			headers,
			body: JSON.stringify({ provider: "claude-api-credits" }),
		});
		expect(start.status).toBe(400);
		expect(await start.text()).toContain("Add a Claude API key instead");
		// Importing legacy Claude writes account metadata; the retired record and both source files survive it.
		expect(array(object(JSON.parse(await readFile(saved, "utf8"))).accounts)).toContainEqual(retired);
		expect(await readFile(profile, "utf8")).toBe("private-profile");
		expect(await readFile(legacy, "utf8")).toBe(legacyJson);
	} finally {
		await broker.close();
		await rm(home, { recursive: true, force: true });
	}
});
