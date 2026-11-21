import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountKey } from "../src/accounts.ts";
import { startBroker } from "../src/service.ts";
import { array, object } from "../src/wire.ts";

const model = "gpt-6-luna";
const payload = ` { "model":"${model}","input":"{\\"task\\":\\"fix a typo\\"}","questions":[{"type":"score","name":"difficulty","levels":[{"label":"easy"}]}]}\n`;
const answer = '{ "model": "gpt-6-luna", "answers": [] }\n';
const failure = '{ "error": { "type": "rate_limit_error", "message": "try later" } }\n';

test("Decisions forwards exact bodies and statuses only through managed OpenAI API keys", async () => {
	const home = await mkdtemp(join(tmpdir(), "credne-decisions-"));
	const calls: { path: string; body: string; headers: Headers }[] = [];
	let status = 200;
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request): Promise<Response> {
			const path = new URL(request.url).pathname;
			if (path === "/v1/models") return Response.json({ data: [{ id: model }] });
			calls.push({ path, body: await request.text(), headers: request.headers });
			return new Response(status === 429 ? failure : answer, {
				status,
				headers: {
					"content-type": "application/json",
					"x-request-id": "req_fake",
					"x-credne-account": "not-the-account",
					"set-cookie": "hidden=secret",
					"x-private-upstream": "hidden",
					...(status === 429 ? { "retry-after": "7" } : {}),
					...(status === 302 ? { location: "/redirected" } : {}),
				},
			});
		},
	});
	await writeFile(
		join(home, "api-accounts.json"),
		JSON.stringify({
			accounts: [
				{ id: "claude", name: "claude", provider: "claude", kind: "oauth", models: [model] },
				{ id: "codex", name: "codex", provider: "codex", kind: "oauth", models: [model] },
				{
					id: "claude-api",
					name: "claude-api",
					provider: "claude-api",
					kind: "api-key",
					apiKey: "sk-anthropic",
					models: [model],
				},
			],
		}),
	);
	const broker = await startBroker({ home, idleTimeout: 0, openaiBaseUrl: `${upstream.url.origin}/v1` });
	if (!broker) throw new Error("No test broker");
	const request = (path: string, body?: string, headers?: HeadersInit) =>
		fetch(`${broker.state.url}/credne/v1${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${broker.state.token}`, ...headers },
			body,
			redirect: "manual",
		});
	const route = (target: string, body = payload, headers?: HeadersInit) =>
		request(`/route/${target}/decisions`, body, headers);
	const add = async (name: string) => {
		const response = await request(
			"/api-keys",
			JSON.stringify({ provider: "openai", name, key: `sk-openai-${name}` }),
		);
		expect(response.status).toBe(200);
		return String(object(object(await response.json()).account).key);
	};
	const refused = async (target: string, responseStatus: number, message: string, body = payload) => {
		const before = calls.length;
		const response = await route(target, body);
		expect(response.status).toBe(responseStatus);
		expect(object(object(await response.json()).error).message).toContain(message);
		expect(calls).toHaveLength(before);
	};
	try {
		const luna = await add("luna");
		const spare = await add("spare");
		const response = await route(`a.${luna}`, payload, {
			"x-api-key": "client-key",
			"x-credne-client": "private",
			"x-credne-account": "client-account",
			"proxy-authorization": "private",
			"chatgpt-account-id": "client-subscription",
			cookie: "client=private",
			"x-client-request-id": "caller-request",
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(answer);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(response.headers.get("x-credne-account")).toBe(luna);
		expect(response.headers.get("x-request-id")).toBe("req_fake");
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(response.headers.has("x-private-upstream")).toBe(false);
		expect(calls[0].path).toBe("/v1/decisions");
		expect(calls[0].body).toBe(payload);
		expect(calls[0].headers.get("authorization")).toBe("Bearer sk-openai-luna");
		expect(calls[0].headers.get("x-client-request-id")).toBe("caller-request");
		for (const name of [
			"x-api-key",
			"cookie",
			"proxy-authorization",
			"chatgpt-account-id",
			"x-credne-client",
			"x-credne-account",
		])
			expect(calls[0].headers.has(name)).toBe(false);

		status = 429;
		const limited = await route(`a.${luna}`);
		expect(limited.status).toBe(429);
		expect(await limited.text()).toBe(failure);
		expect(limited.headers.get("retry-after")).toBe("7");
		const account = array(object(await (await request("/accounts")).json()).accounts)
			.map(object)
			.find((entry) => entry.key === luna);
		expect(account?.quotaExceeded).toBe(false);
		expect(account?.retryAfter).toBeUndefined();

		status = 302;
		const redirect = await route(`a.${luna}`);
		expect(redirect.status).toBe(302);
		expect(redirect.headers.has("location")).toBe(false);
		expect(await redirect.text()).toBe(answer);
		expect(calls).toHaveLength(3);
		status = 200;

		const served = new Set<string>();
		for (let index = 0; index < 4; index++) {
			const pooled = await route("p.openai");
			expect(pooled.status).toBe(200);
			served.add(pooled.headers.get("x-credne-account")!);
			expect(await pooled.text()).toBe(answer);
		}
		expect(served).toEqual(new Set([luna, spare]));
		const disabled = await request(`/accounts/${spare}/disable`, "");
		expect(disabled.status).toBe(200);
		await disabled.body?.cancel();
		const pooled = await route("p.openai");
		expect(pooled.status).toBe(200);
		expect(pooled.headers.get("x-credne-account")).toBe(luna);
		await pooled.body?.cancel();
		await refused(`a.${spare}`, 403, "is disabled");

		status = 429;
		const chat = await request(`/route/a.${luna}/responses`, JSON.stringify({ model, input: "hello" }));
		expect(chat.status).toBe(429);
		await chat.body?.cancel();
		status = 200;
		await refused("p.openai", 429, "all matching accounts are cooling down");
		const pinned = await route(`a.${luna}`, payload.replace(model, "gpt-unlisted"));
		expect(pinned.status).toBe(200);
		expect(await pinned.text()).toBe(answer);

		await refused(
			"p.openai",
			503,
			"no enabled OpenAI API-key account serves gpt-unlisted",
			payload.replace(model, "gpt-unlisted"),
		);
		for (const other of ["claude", "codex", "claude-api"])
			await refused(`a.${accountKey(other)}`, 400, "is not an OpenAI API-key account");
		for (const other of ["claude", "codex", "all"])
			await refused(`p.${other}`, 400, "cannot serve the Decisions API");
		await refused(`a.${accountKey("missing")}`, 404, "not found");
		await refused("x.openai", 400, "invalid route target");
		await refused("a.!!!", 400, "invalid account key");
		await refused("p.openai", 400, "request body must be JSON with a model", '{"input":"no model"}');
		await refused(`a.${luna}`, 400, "request body must be JSON with a model", "not json");
	} finally {
		await broker.close();
		await upstream.stop(true);
		await rm(home, { recursive: true, force: true });
	}
}, 10000);
