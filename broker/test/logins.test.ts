import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { startBroker } from "../src/service.ts";
import { object } from "../src/wire.ts";

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
