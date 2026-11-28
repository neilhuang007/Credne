import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinClassifierModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import {
	type AccountCatalog,
	ALL_POOL,
	buildCatalog,
	familyOf,
	readCatalog,
	sharedRouteFamily,
	upstreamIdentity,
	writeCatalog,
} from "./catalog.ts";
import type { BrokerAccount, BrokerClient } from "./client.ts";
import type { OmpIdentityLookup } from "./omp-native.ts";
import { type AccountProviderSpec, createAccountProvider, providerSpecs, type ServedByListener } from "./provider.ts";

const catalogSources = new Map<string, ReadonlyMap<string, Model<Api>>>(
	getBuiltinProviders().map((provider) => [
		provider,
		new Map(getBuiltinModels(provider).map((model) => [model.id, model])),
	]),
);

/** The built-in classifier entries that account classifiers copy: gpt-6-luna for OpenAI keys, Jev for TypeSafe keys. */
const catalogClassifiers = [
	getBuiltinClassifierModel("openai", "gpt-6-luna"),
	getBuiltinClassifierModel("typesafe", "jev-latest"),
];

/** How long a model refresh waits for the broker's account and model lists, which may include live discovery. */
const BROKER_REFRESH_TIMEOUT_MS = 15_000;

/** Registers broker accounts and pools from the cached catalog before contacting the daemon. */
export class AccountRegistry {
	private readonly pi: ExtensionAPI;
	private readonly client: BrokerClient;
	private readonly catalogPath: string;
	private readonly onServedBy: ServedByListener;
	private catalog: AccountCatalog;
	private specs: AccountProviderSpec[] = [];
	/** The broker read in progress, shared by syncs and model refreshes that overlap. */
	private reading: Promise<{ accounts: BrokerAccount[]; catalog: AccountCatalog }> | undefined;
	/** The model refresh in progress, shared by every account provider it refreshes. */
	private refreshing: Promise<void> | undefined;
	/** oh-my-pi's identity of a model of any registered account or pool, read when a request is encoded. */
	private readonly identify: OmpIdentityLookup = (providerId, modelId) =>
		upstreamIdentity(this.provider(providerId)?.upstream, modelId);

	constructor(pi: ExtensionAPI, client: BrokerClient, catalogPath: string, onServedBy: ServedByListener) {
		this.pi = pi;
		this.client = client;
		this.catalogPath = catalogPath;
		this.onServedBy = onServedBy;
		this.catalog = readCatalog(catalogPath);
		this.apply();
	}

	providers(): readonly AccountProviderSpec[] {
		return this.specs;
	}

	provider(id: string): AccountProviderSpec | undefined {
		return this.specs.find((spec) => spec.id === id);
	}

	/** The upstream model family of an advertised account or pool model, independent of its route scope. */
	modelRouteFamily(providerId: string, modelId: string): string | undefined {
		const spec = this.provider(providerId);
		if (!spec?.models.some((model) => model.id === modelId)) return undefined;
		const { target } = spec;
		const account = this.catalog.accounts.find((account) =>
			target.type === "account"
				? account.key === target.key
				: !account.disabled &&
					(target.name === ALL_POOL || familyOf(account.provider) === target.name) &&
					account.models.some((model) => model.id === modelId),
		);
		return account && sharedRouteFamily(familyOf(account.provider));
	}

	/** Whether the cached catalog has an enabled account of the broker provider `provider`. */
	hasEnabledAccount(provider: string): boolean {
		return this.catalog.accounts.some((account) => account.provider === provider && !account.disabled);
	}

	/** Whether the cached account is enabled and can have subscription quota. */
	isSubscriptionAccount(key: string): boolean {
		return this.catalog.accounts.some(
			(account) => account.key === key && account.kind === "oauth" && !account.disabled,
		);
	}

	/** The pinned-account provider whose broker key is `key`. */
	accountByKey(key: string): AccountProviderSpec | undefined {
		return this.specs.find((spec) => spec.target.type === "account" && spec.target.key === key);
	}

	/** Refresh the catalog and wait until Pi sees changes. Keep the cached providers if the broker fails. */
	async sync(ctx: ExtensionContext, signal?: AbortSignal): Promise<BrokerAccount[]> {
		try {
			if (!(await this.usesBroker(signal))) return [];
			const previous = this.specs.map((spec) => spec.id);
			const accounts = await this.reload(signal);
			const changed = [...new Set([...previous, ...this.specs.map((spec) => spec.id)])];
			// Registration recomputes availability asynchronously; wait so setModel() sees new accounts.
			await ctx.modelRegistry.refresh({ providers: changed, allowNetwork: false, signal });
			return accounts;
		} catch (error) {
			if (signal?.aborted) throw error;
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			return [];
		}
	}

	/**
	 * The network phase of a model catalog refresh, such as opening /model: re-read accounts and their models
	 * from a running broker, so subscription models the broker discovered since the last sync appear. Listing
	 * models never starts the broker, and a failed read keeps the cached providers.
	 */
	async refreshFromBroker(signal: AbortSignal): Promise<void> {
		this.refreshing ??= (async () => {
			try {
				const deadline = AbortSignal.timeout(BROKER_REFRESH_TIMEOUT_MS);
				if (await this.client.connectExisting(deadline)) await this.reload(deadline);
			} catch {
				// The model selector reports refresh failures per provider; a stale account list is not one.
			} finally {
				this.refreshing = undefined;
			}
		})();
		// Every account provider of one refresh waits for the same read; each may stop waiting on its own signal.
		await raceWithAbortSignal(this.refreshing, signal);
	}

	/** Reads accounts and models from the broker, then registers the new catalog when it differs from the cached one. */
	private async reload(signal?: AbortSignal): Promise<BrokerAccount[]> {
		this.reading ??= this.readBroker(signal).finally(() => {
			this.reading = undefined;
		});
		const { accounts, catalog } = await this.reading;
		if (JSON.stringify(catalog) !== JSON.stringify(this.catalog)) {
			this.catalog = catalog;
			writeCatalog(this.catalogPath, catalog);
			this.apply();
		}
		return accounts;
	}

	private async readBroker(signal?: AbortSignal): Promise<{ accounts: BrokerAccount[]; catalog: AccountCatalog }> {
		const accounts = (await this.client.listAccounts(signal)).filter((account) => account.kind !== "api-credits");
		const accountModels = new Map(
			await Promise.all(
				accounts.map(
					async (account) => [account.key, await this.client.accountModels(account.key, signal)] as const,
				),
			),
		);
		const catalog = buildCatalog(
			accounts,
			accountModels,
			(provider, id) => catalogSources.get(provider)?.get(id),
			(provider, id) => catalogClassifiers.find((model) => model.provider === provider && model.id === id),
		);
		return { accounts, catalog };
	}

	/** Explicit commands can start a configured broker even before it has written the first catalog. */
	private async usesBroker(signal?: AbortSignal): Promise<boolean> {
		return (
			this.catalog.accounts.length > 0 ||
			(await this.client.connectExisting(signal)) !== undefined ||
			["config.yaml", "omp-accounts.json", "api-accounts.json", "auths"].some((name) =>
				existsSync(join(this.client.home, name)),
			)
		);
	}

	private apply(): void {
		const specs = providerSpecs(this.catalog);
		const ids = new Set(specs.map((spec) => spec.id));
		for (const spec of this.specs) {
			if (!ids.has(spec.id)) this.pi.unregisterProvider(spec.id);
		}
		for (const spec of specs)
			this.pi.registerProvider(
				createAccountProvider(spec, this.client, this.onServedBy, this.identify, (signal) =>
					this.refreshFromBroker(signal),
				),
			);
		this.specs = specs;
	}
}
