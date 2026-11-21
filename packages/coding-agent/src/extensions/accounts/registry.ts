import type { ExtensionAPI, ExtensionContext, ExtensionVirtualModel } from "../../core/extensions/types.ts";
import { type AccountCatalog, buildCatalog, isBrokerClaudeSubscription, readCatalog, writeCatalog } from "./catalog.ts";
import { importBrokerClaudeAccounts } from "./claude-import.ts";
import type { LocalClaude } from "./claude-local.ts";
import { poolMembers, virtualModelDefinitions, virtualPoolSpecs } from "./claude-pool.ts";
import type { BrokerAccount, BrokerClient } from "./client.ts";
import { type AccountProviderSpec, createAccountProvider, providerSpecs, type ServedByListener } from "./provider.ts";

/**
 * Keeps the account list registered with Pi: one provider per local Claude subscription, broker pool and
 * broker account, and virtual models for the pools `pool:claude` and `pool:all`. Startup registers from the
 * local credential file and the cached catalog without contacting the broker; `sync()` refreshes both.
 */
export class AccountRegistry {
	private readonly pi: ExtensionAPI;
	private readonly client: BrokerClient;
	private readonly local: LocalClaude;
	private readonly catalogPath: string;
	private readonly onServedBy: ServedByListener;
	private catalog: AccountCatalog;
	private specs: AccountProviderSpec[] = [];
	private virtualModelKeys = new Set<string>();

	constructor(
		pi: ExtensionAPI,
		client: BrokerClient,
		local: LocalClaude,
		catalogPath: string,
		onServedBy: ServedByListener,
	) {
		this.pi = pi;
		this.client = client;
		this.local = local;
		this.catalogPath = catalogPath;
		this.onServedBy = onServedBy;
		this.catalog = readCatalog(catalogPath);
		this.apply();
	}

	/** Entries of the account list: virtual pools, broker pools, local subscriptions, broker accounts. */
	providers(): readonly AccountProviderSpec[] {
		return this.specs;
	}

	provider(id: string): AccountProviderSpec | undefined {
		return this.specs.find((spec) => spec.id === id);
	}

	/** The pinned-account provider whose broker key is `key`. */
	accountByKey(key: string): AccountProviderSpec | undefined {
		return this.specs.find((spec) => spec.target.type === "account" && spec.target.key === key);
	}

	/**
	 * Move Claude subscriptions out of the broker's credential files into the local store, then register them.
	 * Runs without a broker: the files are imported either way.
	 */
	async importBrokerSubscriptions(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
		if ((await importBrokerClaudeAccounts(this.local.store, this.client)) === 0) return;
		await this.refresh(ctx, signal);
	}

	/**
	 * Refresh local subscriptions, and broker accounts and models when a broker is in use, then re-register
	 * providers and wait until Pi sees them. Returns the broker's accounts that this list shows.
	 */
	async sync(ctx: ExtensionContext, signal?: AbortSignal): Promise<BrokerAccount[]> {
		if (!(await this.usesBroker(signal))) {
			await this.refresh(ctx, signal);
			return [];
		}
		const accounts = await this.fetchBrokerAccounts(ctx, signal);
		await this.refresh(ctx, signal);
		// A subscription the broker still holds is served locally once imported, so it is not listed.
		return accounts.filter((account) => !isBrokerClaudeSubscription(account));
	}

	/** Read the broker's accounts and models into the catalog. A broker that fails does not hide local subscriptions. */
	private async fetchBrokerAccounts(ctx: ExtensionContext, signal?: AbortSignal): Promise<BrokerAccount[]> {
		try {
			const accounts = await this.client.listAccounts(signal);
			const accountModels = new Map(
				await Promise.all(
					accounts.map(
						async (account) => [account.key, await this.client.accountModels(account.key, signal)] as const,
					),
				),
			);
			this.catalog = buildCatalog(
				accounts,
				accountModels,
				(provider, id) => ctx.modelRegistry.find(provider, id),
				(provider, id) => ctx.modelRegistry.findOfType("classifier", provider, id),
			);
			writeCatalog(this.catalogPath, this.catalog);
			return accounts;
		} catch (error) {
			if (signal?.aborted) throw error;
			ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}`, "warning");
			return [];
		}
	}

	/** Re-register providers from the local credential file and the current catalog. */
	async refresh(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
		const previous = this.specs.map((spec) => spec.id);
		this.apply();
		const changed = [...new Set([...previous, ...this.specs.map((spec) => spec.id)])];
		// Registration recomputes availability asynchronously; wait so setModel() sees new accounts.
		await ctx.modelRegistry.refresh({ providers: changed, allowNetwork: false, signal });
	}

	/** A broker is in use when it has cached accounts or is running; a user with only subscriptions never needs it. */
	private async usesBroker(signal?: AbortSignal): Promise<boolean> {
		return this.catalog.accounts.length > 0 || (await this.client.connectExisting(signal)) !== undefined;
	}

	private apply(): void {
		const locals = this.local.accounts().map((account) => this.local.spec(account));
		const brokered = providerSpecs(this.catalog);
		const pools = virtualPoolSpecs([...locals, ...brokered]);
		const specs: AccountProviderSpec[] = [
			...pools,
			...brokered.filter((spec) => spec.target.type === "pool"),
			...locals,
			...brokered.filter((spec) => spec.target.type === "account"),
		];
		const ids = new Set(specs.map((spec) => spec.id));
		for (const spec of this.specs) {
			if (!ids.has(spec.id) && spec.target.type !== "virtual-pool") this.pi.unregisterProvider(spec.id);
		}
		for (const spec of locals) this.pi.registerProvider(this.local.createProvider(spec));
		for (const spec of brokered) {
			this.pi.registerProvider(createAccountProvider(spec, this.client, this.onServedBy));
		}
		this.specs = specs;
		this.applyVirtualModels(
			virtualModelDefinitions(pools, (pool) => poolMembers(this.specs, pool), {
				limits: this.local.limits,
				refreshUsage: (providerId, signal) => this.local.refreshUsage(providerId, signal),
			}),
		);
	}

	private applyVirtualModels(definitions: readonly ExtensionVirtualModel[]): void {
		const next = new Set(definitions.map((definition) => `${definition.provider}\0${definition.id}`));
		for (const key of this.virtualModelKeys) {
			if (next.has(key)) continue;
			const [provider, id] = key.split("\0");
			this.pi.unregisterVirtualModel(provider, id);
		}
		for (const definition of definitions) this.pi.registerVirtualModel(definition);
		this.virtualModelKeys = next;
	}
}
