// Live subscription quota of an OAuth account, read through OMP's usage providers and mapped to the public shape.
import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai/usage";
import type { Account } from "./accounts.ts";

export type Usage = {
	status: "available" | "unavailable" | "unsupported";
	reason?: string;
	windows: { label: string; usedPercent: number; resetAt?: string }[];
	credits: { label: string; amount?: number; unit: string; unlimited?: boolean }[];
};

const REQUEST_FAILED = "Provider usage request failed or timed out.";
const NO_QUOTA = "Provider did not report supported quota windows or credits.";

/**
 * The account's quota windows and credits from OMP's usage report for its credential. OMP owns the endpoint, headers,
 * timeouts and the five-minute report cache; the broker only points it at the account's own base URL. API-key
 * accounts and providers without a usage endpoint are unsupported.
 */
export async function accountUsage(account: Account, signal: AbortSignal): Promise<Usage> {
	if (account.record.kind !== "oauth" || !account.storage.usage.providerFor(account.provider)) {
		return {
			status: "unsupported",
			reason: "Live subscription usage is not supported for this account kind.",
			windows: [],
			credits: [],
		};
	}
	try {
		const reports = await account.storage.usage.reports({
			provider: account.provider,
			baseUrlResolver: () => account.models[0]?.baseUrl,
			signal,
		});
		return usageFromReports(reports ?? []);
	} catch {
		return unavailable(REQUEST_FAILED);
	}
}

/** Percent limits become quota windows; every other unit becomes the credits it spent and may spend. */
export function usageFromReports(reports: readonly UsageReport[]): Usage {
	const usage: Usage = { status: "available", windows: [], credits: [] };
	for (const limit of reports.flatMap((report) => report.limits)) addLimit(usage, limit);
	return usage.windows.length || usage.credits.length ? usage : unavailable(NO_QUOTA);
}

function addLimit(usage: Usage, limit: UsageLimit): void {
	const { amount } = limit;
	if (amount.unit === "percent") {
		const used = resolveUsedFraction(limit);
		if (used === undefined) return;
		const window: Usage["windows"][number] = {
			label: limit.label,
			usedPercent: Math.min(100, Math.max(0, used * 100)),
		};
		const resetAt = limit.window?.resetsAt === undefined ? undefined : new Date(limit.window.resetsAt);
		if (resetAt && !Number.isNaN(resetAt.getTime())) window.resetAt = resetAt.toISOString();
		usage.windows.push(window);
		return;
	}
	for (const [kind, value] of [
		["used", amount.used],
		["limit", amount.limit],
	] as const) {
		if (value !== undefined && value >= 0)
			usage.credits.push({ label: `${limit.label} ${kind}`, amount: value, unit: amount.unit });
	}
}

function unavailable(reason: string): Usage {
	return { status: "unavailable", reason, windows: [], credits: [] };
}
