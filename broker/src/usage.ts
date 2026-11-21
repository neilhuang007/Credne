export type Usage = {
	status: "available" | "unavailable" | "unsupported";
	reason?: string;
	windows: { label: string; usedPercent: number; resetAt?: string }[];
	credits: { label: string; amount?: number; unit: string; unlimited?: boolean }[];
};

const BODY_LIMIT = 256 * 1024;
const REQUEST_TIMEOUT = 10_000;
const REQUEST_FAILED = "Provider usage request failed or timed out.";
const INVALID_DATA = "Provider returned invalid usage data.";
const UNREADABLE_BODY = "Provider usage response could not be read or exceeded the size limit.";

/** Fetch only the subscription usage endpoint belonging to a supported OAuth account. */
export async function fetchAccountUsage(
	account: { kind: string; provider: string },
	credential: () => Promise<{ token: string; accountId?: string }>,
	signal?: AbortSignal,
): Promise<Usage> {
	if (account.kind !== "oauth" || (account.provider !== "claude" && account.provider !== "codex")) {
		return {
			status: "unsupported",
			reason: "Live subscription usage is not supported for this account kind.",
			windows: [],
			credits: [],
		};
	}
	if (signal?.aborted) return unavailable(REQUEST_FAILED);

	const provider = account.provider;
	const target =
		provider === "claude"
			? "https://api.anthropic.com/api/oauth/usage"
			: "https://chatgpt.com/backend-api/wham/usage";
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, REQUEST_TIMEOUT);
	const { promise: aborted, resolve: resolveAborted } = Promise.withResolvers<Usage>();
	controller.signal.addEventListener("abort", () => resolveAborted(unavailable(REQUEST_FAILED)), { once: true });

	const request = async (): Promise<Usage> => {
		let headers: Headers;
		try {
			const auth = await credential();
			if (controller.signal.aborted) return unavailable(REQUEST_FAILED);
			headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${auth.token}` });
			if (provider === "claude") headers.set("anthropic-beta", "oauth-2025-04-20");
			else if (auth.accountId) headers.set("Chatgpt-Account-Id", auth.accountId);
		} catch {
			return unavailable("Could not prepare provider usage request.");
		}

		let response: Response;
		try {
			response = await fetch(target, { method: "GET", headers, redirect: "error", signal: controller.signal });
		} catch {
			return unavailable(REQUEST_FAILED);
		}
		if (response.status !== 200) {
			void response.body?.cancel().catch(() => {});
			return unavailable("Provider usage returned an unsuccessful HTTP status.");
		}
		if (!response.body) return unavailable(INVALID_DATA);

		const reader = response.body.getReader();
		let text = "";
		let bytes = 0;
		try {
			const decoder = new TextDecoder("utf-8", { fatal: true });
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > BODY_LIMIT) {
					void reader.cancel().catch(() => {});
					return unavailable(UNREADABLE_BODY);
				}
				text += decoder.decode(chunk.value, { stream: true });
			}
			text += decoder.decode();
		} catch {
			return unavailable(UNREADABLE_BODY);
		} finally {
			reader.releaseLock();
		}
		try {
			const data: unknown = JSON.parse(text);
			return provider === "claude" ? normalizeClaudeUsage(data) : normalizeCodexUsage(data);
		} catch {
			return unavailable(INVALID_DATA);
		}
	};

	try {
		// Bound credential acquisition as well as fetch and streaming body reads.
		return await Promise.race([request(), aborted]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		controller.abort();
	}
}

function unavailable(reason: string): Usage {
	return { status: "unavailable", reason, windows: [], credits: [] };
}

/** Normalize the allowlisted Claude quota fields without retaining provider metadata. */
export function normalizeClaudeUsage(data: unknown): Usage {
	if (data === null || typeof data !== "object" || Array.isArray(data)) return unavailable(INVALID_DATA);
	const source = data as Record<string, unknown>;
	const usage: Usage = { status: "available", windows: [], credits: [] };
	for (const [key, label] of [
		["five_hour", "5-hour"],
		["seven_day", "7-day"],
		["seven_day_sonnet", "7-day Sonnet"],
		["seven_day_opus", "7-day Opus"],
		["seven_day_fable", "7-day Fable"],
	] as const) {
		const quota = source[key];
		if (quota === null || typeof quota !== "object" || !("utilization" in quota) || !validPercent(quota.utilization))
			continue;
		const window: Usage["windows"][number] = { label, usedPercent: quota.utilization };
		const resetAt = "resets_at" in quota ? claudeResetAt(quota.resets_at) : undefined;
		if (resetAt) window.resetAt = resetAt;
		usage.windows.push(window);
	}
	const rawExtra = source.extra_usage;
	if (rawExtra !== null && typeof rawExtra === "object" && "is_enabled" in rawExtra && rawExtra.is_enabled === true) {
		const extra = rawExtra as { used_credits?: unknown; monthly_limit?: unknown };
		for (const [key, label] of [
			["used_credits", "Extra usage spent"],
			["monthly_limit", "Extra usage monthly limit"],
		] as const) {
			const amount = extra[key];
			if (validAmount(amount)) usage.credits.push({ label, amount, unit: "provider credit units" });
		}
	}
	if (!usage.windows.length && !usage.credits.length) {
		return unavailable("Provider did not report supported quota windows or credits.");
	}
	return usage;
}

/** Normalize the allowlisted Codex quota fields without retaining provider metadata. */
export function normalizeCodexUsage(data: unknown): Usage {
	if (data === null || typeof data !== "object" || Array.isArray(data)) return unavailable(INVALID_DATA);
	const source = data as { rate_limit?: unknown; credits?: unknown };
	const usage: Usage = { status: "available", windows: [], credits: [] };
	if (source.rate_limit !== null && typeof source.rate_limit === "object" && !Array.isArray(source.rate_limit)) {
		const rate = source.rate_limit as { primary_window?: unknown; secondary_window?: unknown };
		for (const [key, label] of [
			["primary_window", "Primary"],
			["secondary_window", "Secondary"],
		] as const) {
			const rawQuota = rate[key];
			if (rawQuota === null || typeof rawQuota !== "object" || Array.isArray(rawQuota)) continue;
			const quota = rawQuota as { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown };
			if (!validPercent(quota.used_percent)) continue;
			const window: Usage["windows"][number] = { label, usedPercent: quota.used_percent };
			const seconds = quota.limit_window_seconds;
			if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0) {
				if (seconds % 86400 === 0) window.label = `${seconds / 86400}-day`;
				else if (seconds % 3600 === 0) window.label = `${seconds / 3600}-hour`;
				else {
					const hours = Math.floor(seconds / 3600);
					const minutes = Math.floor((seconds % 3600) / 60);
					window.label = `${label} (${hours ? `${hours}h` : ""}${hours || minutes ? `${minutes}m` : ""}${seconds % 60}s)`;
				}
			}
			const reset = quota.reset_at;
			if (typeof reset === "number" && Number.isSafeInteger(reset) && reset > 0 && reset * 1000 <= 8.64e15) {
				window.resetAt = new Date(reset * 1000).toISOString();
			}
			usage.windows.push(window);
		}
	}
	if (source.credits !== null && typeof source.credits === "object" && !Array.isArray(source.credits)) {
		const credits = source.credits as { balance?: unknown; unlimited?: unknown };
		const credit: Usage["credits"][number] = { label: "Credit balance", unit: "provider credits" };
		const balance = credits.balance;
		const amount =
			typeof balance === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(balance)
				? Number(balance)
				: balance;
		if (validAmount(amount)) credit.amount = amount;
		if (credits.unlimited === true) credit.unlimited = true;
		if (credit.unlimited || credit.amount !== undefined) usage.credits.push(credit);
	}
	if (!usage.windows.length && !usage.credits.length) {
		return unavailable("Provider did not report supported quota windows or credits.");
	}
	return usage;
}

function validAmount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validPercent(value: unknown): value is number {
	return validAmount(value) && value <= 100;
}

function claudeResetAt(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const parts =
		/^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
			value,
		);
	if (!parts) return undefined;
	const year = Number(parts[1]);
	const month = Number(parts[2]);
	const day = Number(parts[3]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
	if (days === undefined || day < 1 || day > days) return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
