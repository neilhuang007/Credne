import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { startBroker } from "../src/service.ts";
import { accountUsage, usageFromReports } from "../src/usage.ts";
import { array, object } from "../src/wire.ts";
import { apiKey, fakeNetwork, fakeUpstream, harness, subscription } from "./fixtures.ts";

const secret = "private-token-account-and-provider-payload";
const claudeQuota = {
	five_hour: { utilization: 25, resets_at: "2026-11-22T03:00:00Z" },
	seven_day: { utilization: 0 },
	seven_day_sonnet: { utilization: 100 },
	extra_usage: { is_enabled: true, used_credits: 1250, monthly_limit: 2500, currency: "USD" },
	account_id: secret,
	email: secret,
};
const codexQuota = {
	plan_type: secret,
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
		secondary_window: { used_percent: 100, limit_window_seconds: 604800 },
	},
};

type Limit = UsageReport["limits"][number];
const limit = (overrides: Partial<Limit>): Limit => ({
	id: "test:limit",
	label: "Test limit",
	scope: { provider: "anthropic" },
	amount: { unit: "percent", used: 40, limit: 100, usedFraction: 0.4 },
	...overrides,
});
const report = (...limits: Limit[]): UsageReport => ({ provider: "anthropic", fetchedAt: 0, limits });
const notFound = () => new Response(null, { status: 404 });

describe("mapping OMP's usage reports to the public shape", () => {
	test("percent limits are quota windows with ISO resets; other units are the credits spent and allowed", () => {
		const reset = Date.parse("2026-11-22T03:00:00Z");
		expect(
			usageFromReports([
				report(
					limit({ label: "Claude 5 Hour", window: { id: "5h", label: "5 Hour", resetsAt: reset } }),
					limit({ label: "Claude 7 Day", amount: { unit: "percent", used: 0, limit: 100, usedFraction: 0 } }),
					limit({ label: "Spend", amount: { unit: "usd", used: 12.5, limit: 25, usedFraction: 0.5 } }),
					limit({ label: "Balance", amount: { unit: "credits", used: 3 } }),
				),
			]),
		).toEqual({
			status: "available",
			windows: [
				{ label: "Claude 5 Hour", usedPercent: 40, resetAt: "2026-11-22T03:00:00.000Z" },
				{ label: "Claude 7 Day", usedPercent: 0 },
			],
			credits: [
				{ label: "Spend used", amount: 12.5, unit: "usd" },
				{ label: "Spend limit", amount: 25, unit: "usd" },
				{ label: "Balance used", amount: 3, unit: "credits" },
			],
		});
	});

	test("overage is shown as a full window, and values that cannot be shown are left out", () => {
		const usage = usageFromReports([
			report(
				limit({ label: "Over", amount: { unit: "percent", usedFraction: 1.4 } }),
				limit({ label: "Unknown", amount: { unit: "percent" } }),
				limit({ label: "Bad reset", window: { id: "5h", label: "5 Hour", resetsAt: Number.POSITIVE_INFINITY } }),
				limit({ label: "Negative", amount: { unit: "usd", used: -1, limit: -2 } }),
			),
		]);
		expect(usage.windows).toEqual([
			{ label: "Over", usedPercent: 100 },
			{ label: "Bad reset", usedPercent: 40 },
		]);
		expect(usage.credits).toEqual([]);
	});

	test.each([[[]], [[report()]], [[report(limit({ amount: { unit: "percent" } }))]]])(
		"missing quota is unavailable: %j",
		(reports) => {
			expect(usageFromReports(reports)).toEqual({
				status: "unavailable",
				reason: "Provider did not report supported quota windows or credits.",
				windows: [],
				credits: [],
			});
		},
	);
});

describe("reading usage through OMP", () => {
	test("a Claude subscription reports its live windows from the account's own endpoint", async () => {
		const upstream = fakeUpstream((call) =>
			call.path === "/api/oauth/usage" ? Response.json(claudeQuota) : notFound(),
		);
		const h = await harness(upstream.origin);
		try {
			const account = await h.add("sub", "claude", subscription("sk-ant-oat01-usage"), ["claude-test"]);
			const usage = await accountUsage(account, new AbortController().signal);
			expect(usage.status).toBe("available");
			expect(usage.windows).toEqual([
				{ label: "Claude 5 Hour", usedPercent: 25, resetAt: "2026-11-22T03:00:00.000Z" },
				{ label: "Claude 7 Day", usedPercent: 0 },
				{ label: "Claude 7 Day (Sonnet)", usedPercent: 100 },
			]);
			expect(usage.credits).toEqual([
				{ label: "Claude Extra Usage used", amount: 12.5, unit: "usd" },
				{ label: "Claude Extra Usage limit", amount: 25, unit: "usd" },
			]);
			expect(JSON.stringify(usage)).not.toContain(secret);
			const request = upstream.calls.find((call) => call.path === "/api/oauth/usage")!;
			expect(request.headers.get("authorization")).toBe("Bearer sk-ant-oat01-usage");
			expect(request.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
			expect(h.external).toContain("https://api.anthropic.com/api/oauth/usage");
		} finally {
			await h.close();
			await upstream.server.stop(true);
		}
	}, 20000);

	test("a ChatGPT subscription reports through its fixed account endpoint", async () => {
		const upstream = fakeUpstream(notFound);
		const h = await harness(upstream.origin, (request) =>
			request.url === "https://chatgpt.com/backend-api/wham/usage" ? Response.json(codexQuota) : notFound(),
		);
		try {
			const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "test" } };
			const access = `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test`;
			const account = await h.add(
				"chatgpt",
				"codex",
				{ type: "oauth", access, refresh: "fixture", accountId: "test", expires: Date.now() + 3600000 },
				["gpt-5.4"],
			);
			const usage = await accountUsage(account, new AbortController().signal);
			expect(usage.status).toBe("available");
			expect(usage.windows.map(({ usedPercent, resetAt }) => [usedPercent, resetAt])).toEqual([
				[10, new Date(1_800_000_000_000).toISOString()],
				[100, undefined],
			]);
			expect(JSON.stringify(usage)).not.toContain(secret);
			expect(h.external).toContain("https://chatgpt.com/backend-api/wham/usage");
		} finally {
			await h.close();
			await upstream.server.stop(true);
		}
	}, 20000);

	test("API keys, and a request that cannot finish, are reported without provider text", async () => {
		const upstream = fakeUpstream(() => new Response(secret, { status: 500 }));
		const h = await harness(upstream.origin);
		try {
			const key = await h.add("key", "claude-api", apiKey("sk-ant-key"), ["claude-test"]);
			const unsupported = await accountUsage(key, new AbortController().signal);
			expect(unsupported).toMatchObject({ status: "unsupported", windows: [], credits: [] });
			const sub = await h.add("sub", "claude", subscription("sk-ant-oat01-down"), ["claude-test"]);
			const unavailable = await accountUsage(sub, AbortSignal.abort());
			expect(unavailable).toMatchObject({ status: "unavailable", windows: [], credits: [] });
			for (const usage of [unsupported, unavailable]) expect(JSON.stringify(usage)).not.toContain(secret);
		} finally {
			await h.close();
			await upstream.server.stop(true);
		}
	}, 20000);

	test("the broker serves the public shape for an imported subscription", async () => {
		const home = await mkdtemp(join(tmpdir(), "credne-usage-"));
		const upstream = fakeUpstream((call) =>
			call.path === "/api/oauth/usage" ? Response.json(claudeQuota) : notFound(),
		);
		await mkdir(join(home, "auths"));
		await writeFile(
			join(home, "auths", "claude-usage.json"),
			JSON.stringify({
				type: "claude",
				email: "usage@example.com",
				access_token: "sk-ant-oat01-imported",
				refresh_token: "imported-refresh",
				expired: new Date(Date.now() + 3600000).toISOString(),
			}),
		);
		const network = fakeNetwork(undefined, upstream.origin);
		const broker = await startBroker({ home, idleTimeout: 0, anthropicBaseUrl: upstream.origin });
		if (!broker) throw new Error("No test broker");
		try {
			const headers = { authorization: `Bearer ${broker.state.token}` };
			const accounts = object(await (await fetch(`${broker.state.url}/credne/v1/accounts`, { headers })).json());
			const key = String(object(array(accounts.accounts)[0]).key);
			const response = await fetch(`${broker.state.url}/credne/v1/accounts/${key}/usage`, { headers });
			expect(response.status).toBe(200);
			const usage = object(await response.json());
			expect(usage.status).toBe("available");
			expect(usage.windows).toHaveLength(3);
			expect(JSON.stringify(usage)).not.toMatch(/imported|usage@example\.com|private-token/);
		} finally {
			await broker.close();
			network.restore();
			await upstream.server.stop(true);
			await rm(home, { recursive: true, force: true });
		}
	}, 20000);
});
