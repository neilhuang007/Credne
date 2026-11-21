import { existsSync } from "node:fs";
import { join } from "node:path";
import { getBuiltinClassifierModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { type AccountCatalog, buildCatalog, readCatalog, writeCatalog } from "./catalog.ts";
import type { BrokerAccount, BrokerClient } from "./client.ts";
import { type AccountProviderSpec, createAccountProvider, providerSpecs, type ServedByListener } from "./provider.ts";

const catalogSources = {
	anthropic: getBuiltinModels("anthropic"),
	"openai-codex": getBuiltinModels("openai-codex"),
	openai: getBuiltinModels("openai"),
};

/** Registers broker accounts and pools from the cached catalog before contacting the daemon. */
export class AccountRegistry {
	private readonly pi: ExtensionAPI;
	private readonly client: BrokerClient;
	private readonly catalogPath: string;
	private readonly onServedBy: ServedByListener;
	private catalog: AccountCatalog;
	private specs: AccountProviderSpec[] = [];

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

	/** The pinned-account provider whose broker key is `key`. */
	accountByKey(key: string): AccountProviderSpec | undefined {
		return this.specs.find((spec) => spec.target.type === "account" && spec.target.key === key);
	}

	/** Refresh the catalog and wait until Pi sees changes. Keep the cached providers if the broker fails. */
	async sync(ctx: ExtensionContext, signal?: AbortSignal): Promise<BrokerAccount[]> {
		try {
			if (!(await this.usesBroker(signal))) return [];
			const accounts = (await this.client.listAccounts(signal)).filter((account) => account.kind !== "api-credits");
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
				(provider, id) => catalogSources[provider].find((model) => model.id === id),
				() => getBuiltinClassifierModel("openai", "gpt-6-luna"),
			);
			writeCatalog(this.catalogPath, this.catalog);
			const previous = this.specs.map((spec) => spec.id);
			this.apply();
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
		for (const spec of specs) this.pi.registerProvider(createAccountProvider(spec, this.client, this.onServedBy));
		this.specs = specs;
	}
}
