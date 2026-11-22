import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { Account } from "../src/accounts.ts";
import {
	type Attempt,
	defaultTransport,
	isFailoverStatus,
	newAttempt,
	observingFetch,
	runAttempt,
} from "../src/transport.ts";

const network: { fetch: FetchImpl } = globalThis;
const claude = getBundledModels("anthropic").find((model) => model.api === "anthropic-messages")!;
const gpt = getBundledModels("openai").find((model) => model.api === "openai-responses")!;
// The transport only carries the account for its callers; none of these tests reads it.
const account = {} as Account;

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});
const spies: { mockRestore(): void }[] = [];

/** Sends one request per answer through the observing fetch as `seen`, with the network giving those answers in turn. */
async function observe(seen: Attempt, ...answers: (Response | Error)[]) {
	const queue = [...answers];
	spies.push(
		spyOn(network, "fetch").mockImplementation(async () => {
			const answer = queue.shift()!;
			if (answer instanceof Error) throw answer;
			return answer;
		}),
	);
	const fetch = observingFetch();
	const results: (Response | Error)[] = [];
	for (const _ of answers)
		results.push(
			await runAttempt(seen, () => fetch("http://provider.test/v1", { method: "POST" })).catch((error) => error),
		);
	return results;
}

const attempt = (model: Model<Api>, failover: boolean) =>
	newAttempt(account, model, failover, new AbortController().signal);

describe("default transport", () => {
	test("is OMP's own choice for the model: Claude Code's TLS profile for Anthropic Messages, plain fetch otherwise", () => {
		expect(defaultTransport(claude)).toBe(coworkFetch);
		expect(defaultTransport(gpt)).toBe(globalThis.fetch);
	});

	test("hands the request over exactly as OMP built it and returns the answer untouched", async () => {
		const answer = new Response("body", { status: 200 });
		const sent: [unknown, RequestInit | undefined][] = [];
		spies.push(
			spyOn(network, "fetch").mockImplementation(async (input, init) => {
				sent.push([input, init]);
				return answer;
			}),
		);
		const init: RequestInit = { method: "POST", headers: { "x-test": "1" }, body: "payload" };
		const url = new URL("http://provider.test/v1/messages");
		const seen = attempt(claude, false);
		const response = await runAttempt(seen, () => observingFetch()(url, init));
		expect(response).toBe(answer);
		// Anthropic Messages goes through coworkFetch, which hands a non-HTTPS request to fetch as it received it.
		expect(sent).toHaveLength(1);
		expect(sent[0][0]).toBe(url);
		expect(sent[0][1]).toBe(init);
		expect(init).toEqual({ method: "POST", headers: { "x-test": "1" }, body: "payload" });
		expect(seen.status).toBe(200);
	});
});

describe("observing", () => {
	test("records the status and retry hint of the last answer without cutting a pinned attempt", async () => {
		const seen = attempt(gpt, false);
		await observe(seen, new Response("limit", { status: 429, headers: { "retry-after": "7" } }));
		expect(seen).toMatchObject({ status: 429, retryAfter: "7", cut: false, isDecided: true });
		expect(seen.signal.aborted).toBe(false);
	});

	test("cuts a pool attempt at its first failover status", async () => {
		for (const status of [402, 429, 500, 503, 529]) {
			const seen = attempt(gpt, true);
			await observe(seen, new Response("limit", { status }));
			expect(seen).toMatchObject({ status, cut: true });
			expect(seen.signal.aborted).toBe(true);
			await seen.decided.promise;
		}
	});

	test("lets OMP refresh after a 401 or 403 and decides only on the answer that follows", async () => {
		const seen = attempt(gpt, true);
		await observe(seen, new Response("expired", { status: 401 }));
		expect(seen).toMatchObject({ status: 401, cut: false, isDecided: false });
		await observe(seen, new Response("forbidden", { status: 403 }));
		expect(seen).toMatchObject({ status: 403, cut: false, isDecided: false });
		await observe(seen, new Response("ok", { status: 200 }));
		expect(seen).toMatchObject({ status: 200, cut: false, isDecided: true });
	});

	test("never cuts on a 400, and a decided attempt is not cut by what OMP's recovery meets later", async () => {
		const seen = attempt(gpt, true);
		await observe(seen, new Response("bad", { status: 400 }));
		expect(seen).toMatchObject({ status: 400, cut: false, isDecided: true });
		await observe(seen, new Response("limit", { status: 429, headers: { "retry-after": "5" } }));
		expect(seen).toMatchObject({ status: 429, retryAfter: "5", cut: false });
		expect(seen.signal.aborted).toBe(false);
	});

	test("reads an empty credit balance as a 402 with an hour's cooldown, and leaves the body readable", async () => {
		const message = "Your credit balance is too low to access the Anthropic API.";
		const seen = attempt(gpt, true);
		const results = await observe(seen, new Response(message, { status: 400 }));
		expect(seen).toMatchObject({ status: 402, retryAfter: "3600", cut: true });
		expect((results[0] as Response).status).toBe(400);
		expect(await (results[0] as Response).text()).toBe(message);
	});

	test("a request that never got an answer reads as a 502 and its error is rethrown as it was", async () => {
		const seen = attempt(gpt, true);
		const failure = new TypeError("connection refused");
		const results = await observe(seen, failure);
		expect(results[0]).toBe(failure);
		expect(seen).toMatchObject({ status: 502, failure: "provider request failed", cut: true });
	});

	test("an abort is not a provider failure", async () => {
		const caller = new AbortController();
		const seen = newAttempt(account, gpt, true, caller.signal);
		caller.abort();
		await observe(seen, new DOMException("aborted", "AbortError"));
		expect(seen.status).toBeUndefined();
		expect(seen.cut).toBe(false);
		await seen.decided.promise;
	});
});

test("failover covers limits, billing, auth and server failures, and nothing a caller caused", () => {
	for (const status of [401, 402, 403, 429, 500, 502, 503, 504, 529]) expect(isFailoverStatus(status)).toBe(true);
	for (const status of [200, 400, 404, 413, 422]) expect(isFailoverStatus(status)).toBe(false);
});
