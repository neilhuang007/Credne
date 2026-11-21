// The provider of the last successful response, for callers selecting a session's account.
import type { SessionEntry } from "../../core/session-manager.ts";
import { ACCOUNT_PROVIDER_PREFIX } from "./catalog.ts";

/** Provider of the latest successful answer on the branch. */
export function latestServingProvider(branch: readonly SessionEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const { stopReason, provider } = entry.message;
		if (stopReason !== "error" && stopReason !== "aborted") return provider;
	}
	return undefined;
}

/** Whether `providerId` pins one broker account. */
export function isAccountProvider(providerId: string): boolean {
	return providerId.startsWith(ACCOUNT_PROVIDER_PREFIX);
}
