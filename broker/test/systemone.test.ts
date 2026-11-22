import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountKey } from "../src/accounts.ts";
import { type BrokerHandle, startBroker } from "../src/service.ts";
import { array, object } from "../src/wire.ts";
import { piBody, piEvents, refusal } from "./fixtures.ts";

const model = "jev-latest";
const cards = [
	{ name: model, description: "TypeSafe jev", release_date: "2026-01-01" },
	{ name: "jev-1.14.0", description: "TypeSafe Jev 1.14", release_date: "2026-01-02" },
];
const request = {
	model,
	state: { task: "fix a typo" },
	questions: { easy: { type: "noul", instructions: "Trivial?" } },
};
const answer = {
	model,
	answers: { easy: { type: "noul", noul: 0.75 } },
	usage: { input_tokens: 12, output_tokens: 1 },
};
// A 300x300 PNG: OMP refuses System One images under 78400 pixels.
const png =
	"iVBORw0KGgoAAAANSUhEUgAAASwAAAEsCAAAAABcFtGpAAAAbUlEQVR4nO3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8G5gywABFNWNQAAAAABJRU5ErkJggg==";

interface UpstreamCall {
	path: string;
	body: string;
	headers: Headers;
}

/** A fake TypeSafe API: `ts-*` keys list models, `limited` keys answer 429, and `status` replaces every other answer. */
function fakeTypeSafe(extraCards: typeof cards = []) {
	const calls: UpstreamCall[] = [];
	const behavior = { status: 200, limited: new Set<string>() };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(incoming): Promise<Response> {
			const path = new URL(incoming.url).pathname;
			const key = /^Bearer (.+)$/.exec(incoming.headers.get("authorization") ?? "")?.[1] ?? "";
			if (path === "/v1/models") {
				if (key === "ts-forbidden") return Response.json({ detail: "private diagnostic" }, { status: 403 });
				if (key === "ts-empty") return Response.json({ models: [] });
				if (!key.startsWith("ts-good-")) return Response.json({ detail: "private diagnostic" }, { status: 401 });
				return Response.json({ models: [...cards, ...extraCards] });
			}
			calls.push({ path, body: await incoming.text(), headers: incoming.headers });
			if (behavior.limited.has(key)) return Response.json({ detail: "slow down" }, { status: 429 });
			if (behavior.status !== 200)
				return Response.json({ detail: "private upstream detail" }, { status: behavior.status });
			return Response.json(answer);
		},
	});
	return { calls, behavior, server };
}

async function fixture(extra: Record<string, unknown> = {}, extraCards: typeof cards = []) {
	const home = await mkdtemp(join(tmpdir(), "credne-systemone-"));
	const upstream = fakeTypeSafe(extraCards);
	let broker: BrokerHandle | undefined;
	const restart = async () => {
		await broker?.close();
		broker = await startBroker({ home, idleTimeout: 0, typesafeBaseUrl: upstream.server.url.origin, ...extra });
		if (!broker) throw new Error("No test broker");
	};
	const call = (path: string, body?: unknown, headers?: HeadersInit) => {
		if (!broker) throw new Error("No test broker");
		return fetch(`${broker.state.url}/credne/v1${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${broker.state.token}`, ...headers },
			body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body),
		});
	};
	const add = async (name: string, key: string) => {
		const response = await call("/api-keys", { provider: "typesafe", name, key });
		expect(response.status).toBe(200);
		return String(object(object(await response.json()).account).key);
	};
	const addOpenAI = async (name: string, key: string) => {
		const response = await call("/api-keys", { provider: "openai", name, key });
		expect(response.status).toBe(200);
		return String(object(object(await response.json()).account).key);
	};
	const close = async () => {
		await broker?.close();
		await upstream.server.stop(true);
		await rm(home, { recursive: true, force: true });
	};
	await restart();
	return {
		home,
		upstream,
		restart,
		call,
		add,
		addOpenAI,
		close,
		route: (target: string, body?: unknown, headers?: HeadersInit) =>
			call(`/route/${target}/systemone`, body, headers),
	};
}

test("TypeSafe enrollment lists models with the supplied key and keeps them as classifiers", async () => {
	const f = await fixture();
	try {
		for (const [key, status, message] of [
			["ts-bad", 400, "Key rejected (HTTP 401)"],
			["ts-forbidden", 400, "Key rejected (HTTP 403)"],
			["ts-empty", 400, "Key has no accessible models"],
		] as const) {
			const response = await f.call("/api-keys", { provider: "typesafe", name: "bad", key });
			expect(response.status).toBe(status);
			const text = await response.text();
			expect(text).toContain(message);
			expect(text).not.toMatch(/private diagnostic|ts-bad|ts-forbidden|ts-empty/);
		}
		expect(array(object(await (await f.call("/accounts")).json()).accounts)).toEqual([]);

		const response = await f.call("/api-keys", { provider: "typesafe", name: "Primary", key: "ts-good-one" });
		expect(response.status).toBe(200);
		const account = object(object(await response.json()).account);
		expect(account).toMatchObject({
			id: "typesafe-key-primary",
			provider: "typesafe",
			kind: "api-key",
			label: "primary",
			modelCount: 2,
		});
		const path = `/accounts/${account.key}/models`;
		const models = array(object(await (await f.call(path)).json()).models).map(object);
		expect(models.map(({ id, displayName, kind }) => ({ id, displayName, kind }))).toEqual([
			{ id: model, displayName: "TypeSafe jev", kind: "classifier" },
			{ id: "jev-1.14.0", displayName: "TypeSafe Jev 1.14", kind: "classifier" },
		]);
		const metadata = await readFile(join(f.home, "omp-accounts.json"), "utf8");
		expect(metadata).not.toContain("ts-good-one");
		expect(JSON.parse(metadata).accounts).toMatchObject([{ provider: "typesafe", models: [model, "jev-1.14.0"] }]);

		for (const [name, key] of [
			["primary", "ts-good-two"],
			["other", "ts-good-one"],
		]) {
			const duplicate = await f.call("/api-keys", { provider: "typesafe", name, key });
			expect(duplicate.status).toBe(409);
			await duplicate.body?.cancel();
		}
		await f.restart();
		expect(array(object(await (await f.call(path)).json()).models).map(object)).toEqual(models);
		expect(array(object(await (await f.call("/accounts")).json()).accounts)).toMatchObject([{ key: account.key }]);
	} finally {
		await f.close();
	}
}, 15000);

test("System One reaches TypeSafe through OMP with the account key and cools limited accounts", async () => {
	const f = await fixture();
	try {
		const alpha = await f.add("alpha", "ts-good-one");
		const beta = await f.add("beta", "ts-good-two");
		const { calls, behavior } = f.upstream;
		const served = async (target: string, status = 200) => {
			const response = await f.route(target, request);
			expect(response.status).toBe(status);
			expect(response.headers.get("cache-control")).toBe("no-store");
			return response;
		};
		const accountState = async (key: string) =>
			array(object(await (await f.call("/accounts")).json()).accounts)
				.map(object)
				.find((entry) => entry.key === key);

		const response = await f.route(`a.${alpha}`, request, {
			"x-api-key": "client-key",
			"x-credne-client": "private",
			"x-credne-account": "client-account",
			"proxy-authorization": "private",
			cookie: "client=private",
			"typesafe-danger-zone-images": "true",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(answer);
		expect(response.headers.get("x-credne-account")).toBe(alpha);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe("/v1/systemone");
		expect(JSON.parse(calls[0].body)).toEqual(request);
		expect(calls[0].headers.get("authorization")).toBe("Bearer ts-good-one");
		expect(calls[0].headers.get("content-type")).toBe("application/json");
		for (const name of ["x-api-key", "cookie", "proxy-authorization", "x-credne-client", "x-credne-account"])
			expect(calls[0].headers.has(name)).toBe(false);
		// OMP attaches the image opt-in itself, and only to requests that carry images.
		expect(calls[0].headers.has("typesafe-danger-zone-images")).toBe(false);

		const withImage = await f.route(`a.${beta}`, {
			...request,
			images: [{ type: "image", data: png, mimeType: "image/png" }],
		});
		expect(withImage.status).toBe(200);
		await withImage.body?.cancel();
		expect(calls[1].headers.get("authorization")).toBe("Bearer ts-good-two");
		expect(calls[1].headers.get("typesafe-danger-zone-images")).toBe("true");
		expect(Object.keys(object(JSON.parse(calls[1].body)).assets as object)).toHaveLength(1);

		const pooled = new Set<string>();
		for (let index = 0; index < 4; index++) {
			const result = await served("p.typesafe");
			pooled.add(result.headers.get("x-credne-account")!);
			await result.body?.cancel();
		}
		expect(pooled).toEqual(new Set([alpha, beta]));

		// A provider refusal is the caller's problem, not the account's: it passes through without a cooldown.
		behavior.status = 422;
		const refused = await served(`a.${alpha}`, 422);
		expect(await refused.text()).not.toContain("private upstream detail");
		behavior.status = 200;
		expect((await accountState(alpha))?.unavailable).toBe(false);

		// A limited account is benched and the pool moves on within the same request.
		behavior.limited.add("ts-good-one");
		const before = calls.length;
		for (let index = 0; index < 2; index++) {
			const result = await served("p.typesafe");
			expect(result.headers.get("x-credne-account")).toBe(beta);
			await result.body?.cancel();
		}
		expect(
			calls.slice(before).filter((entry) => entry.headers.get("authorization") === "Bearer ts-good-one"),
		).toHaveLength(1);
		expect(await accountState(alpha)).toMatchObject({ unavailable: true, quotaExceeded: true });
		const settled = calls.length;
		for (let index = 0; index < 3; index++) {
			const result = await served("p.typesafe");
			expect(result.headers.get("x-credne-account")).toBe(beta);
			await result.body?.cancel();
		}
		expect(calls.length).toBe(settled + 3);

		// With every account limited, the last one is OMP's to retry (it makes three tries) and its answer comes back.
		// Then the pool refuses without calling out.
		behavior.limited.add("ts-good-two");
		const exhausted = await served("p.typesafe", 429);
		expect(object(object(await exhausted.json()).error).message).toContain("provider returned HTTP 429");
		expect(calls.length).toBe(settled + 3 + 3);
		const cooling = await f.route("p.typesafe", request);
		expect(cooling.status).toBe(429);
		expect(Number(cooling.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(await cooling.text()).toContain("all matching accounts are cooling down");
		expect(calls.length).toBe(settled + 3 + 3);

		behavior.limited.clear();
		for (const key of [alpha, beta]) {
			const reset = await f.call(`/accounts/${key}/reset`, "");
			expect(reset.status).toBe(200);
			await reset.body?.cancel();
		}
		const recovered = await served("p.typesafe");
		expect(await recovered.json()).toEqual(answer);

		const disabled = await f.call(`/accounts/${beta}/disable`, "");
		expect(disabled.status).toBe(200);
		await disabled.body?.cancel();
		const survivor = await served("p.typesafe");
		expect(survivor.headers.get("x-credne-account")).toBe(alpha);
		await survivor.body?.cancel();
	} finally {
		await f.close();
	}
}, 20000);

test("System One accepts only enabled TypeSafe and OpenAI keys, and TypeSafe accounts never serve chat", async () => {
	const chat = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(incoming) {
			if (new URL(incoming.url).pathname === "/v1/models") return Response.json({ data: [{ id: "gpt-5.4" }] });
			await incoming.arrayBuffer();
			return refusal(429, "chat upstream", { "x-should-retry": "false" });
		},
	});
	// A TypeSafe card named like an OpenAI chat model makes `p.all` ambiguous if TypeSafe accounts count as chat candidates.
	const shared = { name: "gpt-5.4", description: "shared ID", release_date: "2026-01-03" };
	const f = await fixture({ openaiBaseUrl: chat.url.origin }, [shared]);
	try {
		const alpha = await f.add("alpha", "ts-good-one");
		const openai = await f.call("/api-keys", { provider: "openai", name: "chat", key: "sk-chat" });
		expect(openai.status).toBe(200);
		const chatKey = String(object(object(await openai.json()).account).key);
		const { calls } = f.upstream;
		const refused = async (target: string, status: number, message: string, body: unknown = request) => {
			const before = calls.length;
			const response = await f.route(target, body);
			expect(response.status).toBe(status);
			expect(object(object(await response.json()).error).message).toContain(message);
			expect(calls).toHaveLength(before);
		};

		for (const other of ["claude", "codex", "all"])
			await refused(`p.${other}`, 400, "cannot serve the System One API");
		await refused(`a.${accountKey("missing")}`, 404, "not found");
		await refused("x.typesafe", 400, "invalid route target");
		await refused("a.!!!", 400, "invalid account key");
		await refused("p.typesafe", 400, "request body must be JSON with a model", { state: "no model" });
		await refused(`a.${alpha}`, 400, "request body must be JSON with a model", "not json");
		await refused("p.typesafe", 503, "no enabled TypeSafe API-key account serves jev-unlisted", {
			...request,
			model: "jev-unlisted",
		});
		// No OpenAI key lists a Jev model, and no TypeSafe key a GPT one.
		await refused("p.openai", 503, `no enabled OpenAI API-key account serves ${model}`);
		await refused("p.typesafe", 503, "no enabled TypeSafe API-key account serves gpt-6-luna", {
			...request,
			model: "gpt-6-luna",
		});
		await refused(`a.${alpha}`, 404, "jev-unlisted", { ...request, model: "jev-unlisted" });
		await refused(`a.${alpha}`, 422, "systemone", { model, state: "x", questions: { easy: { type: "essay" } } });
		await refused(`a.${accountKey("missing")}`, 404, "not found");

		const disabled = await f.call(`/accounts/${alpha}/disable`, "");
		expect(disabled.status).toBe(200);
		await disabled.body?.cancel();
		await refused(`a.${alpha}`, 403, "is disabled");
		await refused("p.typesafe", 503, "no enabled TypeSafe API-key account");
		const enabled = await f.call(`/accounts/${alpha}/enable`, "");
		await enabled.body?.cancel();

		// The shared model ID reaches the OpenAI key alone: no 409 between families, and TypeSafe is never called.
		const piRequest = (target: string, modelId: string) =>
			f.call(`/route/${target}/pi/stream`, JSON.parse(piBody(modelId, "shared-id")));
		const sharedChat = await piRequest("p.all", "gpt-5.4");
		expect(sharedChat.status).toBe(200);
		expect(sharedChat.headers.get("x-credne-account")).toBe(chatKey);
		expect((await piEvents(sharedChat)).at(-1)).toMatchObject({ type: "error" });
		for (const [target, modelId] of [
			["p.typesafe", "gpt-5.4"],
			[`a.${alpha}`, model],
			["p.all", "jev-1.14.0"],
		] as const) {
			const response = await piRequest(target, modelId);
			expect(response.status).toBe(404);
			expect(await response.text()).toContain("No enabled account serves this model.");
		}
		expect(calls).toHaveLength(0);
	} finally {
		await f.close();
		await chat.stop(true);
	}
}, 20000);

const luna = "gpt-6-luna";
const lunaAnswer = {
	model: luna,
	answers: [{ type: "predicate", name: "easy", probability: 0.75 }],
	usage: { input_tokens: 12, output_tokens: 0 },
};

test("System One serves GPT-6 Luna through OMP's OpenAI Decisions judge on OpenAI keys", async () => {
	const decisions: UpstreamCall[] = [];
	let limited = false;
	const openai = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(incoming): Promise<Response> {
			const path = new URL(incoming.url).pathname;
			if (path === "/v1/models") {
				const keyed = incoming.headers.get("authorization") === "Bearer sk-without";
				return Response.json({ data: [{ id: keyed ? "gpt-5.4" : luna }] });
			}
			decisions.push({ path, headers: incoming.headers, body: await incoming.text() });
			if (limited) return refusal(429, "slow down", { "retry-after": "0" });
			return Response.json(lunaAnswer);
		},
	});
	const f = await fixture({ openaiBaseUrl: openai.url.origin });
	try {
		const first = await f.addOpenAI("first", "sk-first");
		const second = await f.addOpenAI("second", "sk-second");
		const without = await f.addOpenAI("without", "sk-without");
		const lunaRequest = { ...request, model: luna };
		const served = async (target: string) => {
			const response = await f.route(target, lunaRequest);
			expect(response.status).toBe(200);
			return response;
		};

		const pinned = await served(`a.${first}`);
		expect(await pinned.json()).toEqual({
			model: luna,
			answers: { easy: { type: "noul", noul: 0.75 } },
			usage: { input_tokens: 12, output_tokens: 0 },
		});
		expect(pinned.headers.get("x-credne-account")).toBe(first);
		// OMP's judge speaks OpenAI's wire: `/v1/decisions` with the account's key, questions as an ordered list.
		expect(decisions[0].path).toBe("/v1/decisions");
		expect(decisions[0].headers.get("authorization")).toBe("Bearer sk-first");
		expect(JSON.parse(decisions[0].body)).toEqual({
			model: luna,
			input: JSON.stringify(request.state),
			questions: [{ type: "predicate", name: "easy", instructions: "Trivial?" }],
		});

		const pooled = new Set<string>();
		for (let index = 0; index < 4; index++) {
			const response = await served("p.openai");
			pooled.add(response.headers.get("x-credne-account")!);
			await response.body?.cancel();
		}
		// The key that does not list GPT-6 Luna is not a candidate.
		expect(pooled).toEqual(new Set([first, second]));
		const refused = await f.route(`a.${without}`, lunaRequest);
		expect(refused.status).toBe(404);
		await refused.body?.cancel();

		// The key is shared with chat, so a failed classification neither benches the account nor moves the pool on.
		limited = true;
		const failed = await f.route("p.openai", lunaRequest);
		expect(failed.status).toBe(429);
		await failed.body?.cancel();
		for (const key of [first, second]) {
			const account = array(object(await (await f.call("/accounts")).json()).accounts)
				.map(object)
				.find((entry) => entry.key === key);
			expect(account).toMatchObject({ unavailable: false, quotaExceeded: false });
		}
		limited = false;
		await (await served("p.openai")).body?.cancel();
	} finally {
		await f.close();
		await openai.stop(true);
	}
}, 20000);
