import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../../core/session-manager.ts";
import { POOL_PROVIDER_PREFIX } from "./catalog.ts";

export interface SessionAccountCosts {
	account: Usage["cost"];
	accountResponses: number;
	unattributedPools: Usage["cost"];
	poolResponses: number;
}

/**
 * Sum recorded assistant costs for a pinned provider. Broker pool responses record only the pool,
 * so their costs remain separate and unattributed.
 */
export function sessionAccountCosts(entries: readonly SessionEntry[], providerId: string): SessionAccountCosts {
	const result: SessionAccountCosts = {
		account: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		accountResponses: 0,
		unattributedPools: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		poolResponses: 0,
	};
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		const pool = message.provider.startsWith(POOL_PROVIDER_PREFIX);
		if (!pool && message.provider !== providerId) continue;
		const target = pool ? result.unattributedPools : result.account;
		if (pool) result.poolResponses++;
		else result.accountResponses++;
		target.input += message.usage.cost.input;
		target.output += message.usage.cost.output;
		target.cacheRead += message.usage.cost.cacheRead;
		target.cacheWrite += message.usage.cost.cacheWrite;
		target.total += message.usage.cost.total;
	}
	return result;
}
