import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { fetchAccountUsage, normalizeClaudeUsage, normalizeCodexUsage } from "../src/usage.ts";

// Mock the HTTP callable without Bun's separate fetch.preconnect namespace.
const network: { fetch: FetchImpl } = globalThis;

const secret = "private-token-account-and-provider-payload";
const claudeQuota = { five_hour: { utilization: 25, resets_at: "2026-11-22T03:00:00Z" } };

afterEach(() => mock.restore());

describe("usage normalization", () => {
	test("Claude windows and extra credits use only normalized allowlisted fields", () => {
		const source = {
			...claudeQuota,
			seven_day: { utilization: 0 },
			seven_day_sonnet: { utilization: 100 },
			seven_day_opus: { utilization: 12.5 },
			seven_day_fable: { utilization: 1 },
			extra_usage: { is_enabled: true, used_credits: 0, monthly_limit: 25 },
			access_token: secret,
			email: secret,
		};
		const before = structuredClone(source);
		const usage = normalizeClaudeUsage(source);
		expect(usage).toEqual({
			status: "available",
			windows: [
				{ label: "5-hour", usedPercent: 25, resetAt: "2026-11-22T03:00:00.000Z" },
				{ label: "7-day", usedPercent: 0 },
				{ label: "7-day Sonnet", usedPercent: 100 },
				{ label: "7-day Opus", usedPercent: 12.5 },
				{ label: "7-day Fable", usedPercent: 1 },
			],
			credits: [
				{ label: "Extra usage spent", amount: 0, unit: "provider credit units" },
				{ label: "Extra usage monthly limit", amount: 25, unit: "provider credit units" },
			],
		});
		expect(source).toEqual(before);
		expect(JSON.stringify(usage)).not.toContain(secret);
	});

	test("Codex durations, timestamps and numeric-string credits are normalized", () => {
		const source = {
			rate_limit: {
				primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
				secondary_window: { used_percent: 100, limit_window_seconds: 604800 },
			},
			credits: { balance: "12.50", unlimited: false },
			account_id: secret,
			plan_type: secret,
		};
		const before = structuredClone(source);
		expect(normalizeCodexUsage(source)).toEqual({
			status: "available",
			windows: [
				{ label: "5-hour", usedPercent: 10, resetAt: new Date(1_800_000_000_000).toISOString() },
				{ label: "7-day", usedPercent: 100 },
			],
			credits: [{ label: "Credit balance", amount: 12.5, unit: "provider credits" }],
		});
		expect(source).toEqual(before);
		expect(JSON.stringify(normalizeCodexUsage(source))).not.toContain(secret);
	});

	test.each(
		[undefined, null, false, 42, "{}", [], {}, { five_hour: {} }, { rate_limit: {} }].map((data) => ({ data })),
	)("missing or unsupported quota is unavailable: %j", ({ data }) => {
		for (const normalize of [normalizeClaudeUsage, normalizeCodexUsage]) {
			expect(normalize(data)).toMatchObject({ status: "unavailable", windows: [], credits: [] });
		}
	});

	test.each([-1, 100.1, NaN, Infinity, "25", null, {}, true])("invalid percentages are not shown: %j", (value) => {
		expect(normalizeClaudeUsage({ five_hour: { utilization: value } }).status).toBe("unavailable");
		expect(normalizeCodexUsage({ rate_limit: { primary_window: { used_percent: value } } }).status).toBe(
			"unavailable",
		);
	});

	test("invalid resets are omitted without discarding valid percentages", () => {
		for (const resets_at of ["yesterday", "2026-02-30T00:00:00Z", "2026-11-22", null, 123]) {
			expect(normalizeClaudeUsage({ five_hour: { utilization: 0, resets_at } }).windows).toEqual([
				{ label: "5-hour", usedPercent: 0 },
			]);
		}
		for (const reset_at of [-1, 0, Infinity, 1.5, 9e15, "1800000000"]) {
			expect(normalizeCodexUsage({ rate_limit: { primary_window: { used_percent: 0, reset_at } } }).windows).toEqual(
				[{ label: "Primary", usedPercent: 0 }],
			);
		}
	});

	test("fractional and missing window lengths do not create invented labels", () => {
		expect(
			normalizeCodexUsage({
				rate_limit: {
					primary_window: { used_percent: 1, limit_window_seconds: 90 },
					secondary_window: { used_percent: 2, limit_window_seconds: 1.5 },
				},
			}).windows,
		).toEqual([
			{ label: "Primary (1m30s)", usedPercent: 1 },
			{ label: "Secondary", usedPercent: 2 },
		]);
	});

	test("credits require valid amounts or an explicit unlimited flag", () => {
		for (const balance of [-1, "-1", "", "NaN", "Infinity", "1x", "0x10", null, true, {}, Infinity]) {
			expect(normalizeCodexUsage({ credits: { balance } }).status).toBe("unavailable");
		}
		expect(normalizeCodexUsage({ credits: { balance: "0" } }).credits[0]?.amount).toBe(0);
		expect(normalizeCodexUsage({ credits: { unlimited: true, balance: secret } }).credits).toEqual([
			{ label: "Credit balance", unit: "provider credits", unlimited: true },
		]);
		expect(normalizeClaudeUsage({ extra_usage: { is_enabled: false, used_credits: 10 } }).status).toBe("unavailable");
		expect(
			normalizeClaudeUsage({ extra_usage: { is_enabled: true, used_credits: -1, monthly_limit: Infinity } }).status,
		).toBe("unavailable");
	});
});

describe("usage fetching", () => {
	test.each([
		{ kind: "api_key", provider: "claude" },
		{ kind: "oauth", provider: "anthropic" },
		{ kind: "oauth", provider: "openai" },
		{ kind: "oauth", provider: "https://attacker.invalid/" },
	])("unsupported accounts never resolve credentials or fetch: %j", async (account) => {
		const credential = mock(async () => ({ token: secret }));
		const fetcher = spyOn(network, "fetch");
		expect((await fetchAccountUsage(account, credential)).status).toBe("unsupported");
		expect(credential).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	});

	test.each(["claude", "codex"])("%s uses its fixed endpoint with redirects forbidden", async (provider) => {
		const data = provider === "claude" ? claudeQuota : { credits: { balance: 0 } };
		const fetcher = spyOn(network, "fetch").mockResolvedValue(Response.json(data));
		const timeout = spyOn(globalThis, "setTimeout");
		const usage = await fetchAccountUsage({ kind: "oauth", provider }, async () => ({
			token: secret,
			accountId: secret,
		}));
		expect(usage.status).toBe("available");
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0]!;
		expect(url).toBe(
			provider === "claude"
				? "https://api.anthropic.com/api/oauth/usage"
				: "https://chatgpt.com/backend-api/wham/usage",
		);
		expect(init?.method).toBe("GET");
		expect(init?.redirect).toBe("error");
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe(`Bearer ${secret}`);
		expect(headers.get("Accept")).toBe("application/json");
		expect(headers.get("anthropic-beta")).toBe(provider === "claude" ? "oauth-2025-04-20" : null);
		expect(headers.get("Chatgpt-Account-Id")).toBe(provider === "codex" ? secret : null);
		expect(timeout.mock.calls.some((call) => call[1] === 10_000)).toBe(true);
		expect(JSON.stringify(usage)).not.toContain(secret);
	});

	test("credential and transport errors never expose exception text", async () => {
		const fetcher = spyOn(network, "fetch").mockRejectedValue(new Error(secret));
		const account = { kind: "oauth", provider: "claude" };
		const preparation = await fetchAccountUsage(account, async () => {
			throw new Error(secret);
		});
		expect(fetcher).not.toHaveBeenCalled();
		const transport = await fetchAccountUsage(account, async () => ({ token: secret }));
		for (const usage of [preparation, transport]) {
			expect(usage.status).toBe("unavailable");
			expect(JSON.stringify(usage)).not.toContain(secret);
		}
	});

	test.each([302, 401, 403, 429, 500])(
		"HTTP %s bodies and redirect locations are never exposed or followed",
		async (status) => {
			const fetcher = spyOn(network, "fetch").mockResolvedValue(
				new Response(secret, { status, headers: { Location: `https://attacker.invalid/${secret}` } }),
			);
			const usage = await fetchAccountUsage({ kind: "oauth", provider: "codex" }, async () => ({ token: secret }));
			expect(usage.status).toBe("unavailable");
			expect(JSON.stringify(usage)).not.toContain(secret);
			expect(fetcher).toHaveBeenCalledTimes(1);
		},
	);

	test("malformed JSON returns a static error, not provider data", async () => {
		spyOn(network, "fetch").mockResolvedValue(new Response(`{"token":"${secret}"`));
		expect(await fetchAccountUsage({ kind: "oauth", provider: "claude" }, async () => ({ token: secret }))).toEqual({
			status: "unavailable",
			reason: "Provider returned invalid usage data.",
			windows: [],
			credits: [],
		});
	});

	test("the body limit counts bytes and accepts exactly 256 KiB", async () => {
		const json = JSON.stringify(claudeQuota);
		const fetcher = spyOn(network, "fetch").mockResolvedValue(new Response(json.padEnd(256 * 1024)));
		const account = { kind: "oauth", provider: "claude" };
		expect((await fetchAccountUsage(account, async () => ({ token: secret }))).status).toBe("available");
		fetcher.mockResolvedValue(new Response(`${json.padEnd(256 * 1024)} `));
		expect((await fetchAccountUsage(account, async () => ({ token: secret }))).reason).toContain("size limit");
		fetcher.mockResolvedValue(new Response(JSON.stringify({ ...claudeQuota, private: "界".repeat(90_000) })));
		expect((await fetchAccountUsage(account, async () => ({ token: secret }))).reason).toContain("size limit");
	});

	test("oversized streamed bodies are cancelled immediately", async () => {
		const cancel = mock(() => {});
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(256 * 1024 + 1));
			},
			cancel,
		});
		spyOn(network, "fetch").mockResolvedValue(new Response(stream));
		expect(
			(await fetchAccountUsage({ kind: "oauth", provider: "claude" }, async () => ({ token: secret }))).status,
		).toBe("unavailable");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	test("stream read errors remain static", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error(secret));
			},
		});
		spyOn(network, "fetch").mockResolvedValue(new Response(stream));
		const usage = await fetchAccountUsage({ kind: "oauth", provider: "claude" }, async () => ({ token: secret }));
		expect(usage.status).toBe("unavailable");
		expect(JSON.stringify(usage)).not.toContain(secret);
	});

	test("a pre-aborted request performs no credential or network work", async () => {
		const credential = mock(async () => ({ token: secret }));
		const fetcher = spyOn(network, "fetch");
		expect(
			(await fetchAccountUsage({ kind: "oauth", provider: "claude" }, credential, AbortSignal.abort(secret))).status,
		).toBe("unavailable");
		expect(credential).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	});

	test("abort bounds credential acquisition and late credentials cannot start fetch", async () => {
		const held = Promise.withResolvers<{ token: string }>();
		const fetcher = spyOn(network, "fetch");
		const controller = new AbortController();
		const result = fetchAccountUsage({ kind: "oauth", provider: "claude" }, () => held.promise, controller.signal);
		controller.abort(secret);
		expect((await result).status).toBe("unavailable");
		held.resolve({ token: secret });
		await held.promise;
		expect(fetcher).not.toHaveBeenCalled();
	});

	test("abort returns even when the transport ignores cancellation", async () => {
		const held = Promise.withResolvers<Response>();
		const started = Promise.withResolvers<void>();
		spyOn(network, "fetch").mockImplementation(() => {
			started.resolve();
			return held.promise;
		});
		const controller = new AbortController();
		const result = fetchAccountUsage(
			{ kind: "oauth", provider: "codex" },
			async () => ({ token: secret }),
			controller.signal,
		);
		await started.promise;
		controller.abort(secret);
		expect((await result).status).toBe("unavailable");
		held.resolve(new Response(null, { status: 401 }));
	});

	test("the ten-second deadline also expires a hung credential operation", async () => {
		const timeout = spyOn(globalThis, "setTimeout");
		const held = Promise.withResolvers<{ token: string }>();
		const fetcher = spyOn(network, "fetch");
		const result = fetchAccountUsage({ kind: "oauth", provider: "claude" }, () => held.promise);
		const expire = timeout.mock.calls.find((call) => call[1] === 10_000)?.[0];
		expect(typeof expire).toBe("function");
		if (typeof expire === "function") expire();
		expect((await result).reason).toBe("Provider usage request failed or timed out.");
		held.resolve({ token: secret });
		await held.promise;
		expect(fetcher).not.toHaveBeenCalled();
	});

	test("the deadline bounds a stalled streaming response", async () => {
		const timeout = spyOn(globalThis, "setTimeout");
		const reading = Promise.withResolvers<void>();
		let source: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				source = controller;
			},
			pull() {
				reading.resolve();
			},
		});
		spyOn(network, "fetch").mockResolvedValue(new Response(stream));
		const result = fetchAccountUsage({ kind: "oauth", provider: "claude" }, async () => ({ token: secret }));
		await reading.promise;
		const expire = timeout.mock.calls.find((call) => call[1] === 10_000)?.[0];
		expect(typeof expire).toBe("function");
		if (typeof expire === "function") expire();
		expect((await result).status).toBe("unavailable");
		source?.error(new Error(secret));
	});
});
