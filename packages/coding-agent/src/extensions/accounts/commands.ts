import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import {
	accountDisplayName,
	accountProviderId,
	familyOf,
	isBrokerProvider,
	isLocalClaudeProvider,
	sharedRouteFamily,
} from "./catalog.ts";
import type { BrokerAccount, BrokerClient, BrokerUsage } from "./client.ts";
import { sessionAccountCosts } from "./costs.ts";
import { enrollAccount } from "./enrollment.ts";
import { choosePoolModelAccount } from "./model-choice.ts";
import { type AccountPanelResult, AccountsPanel } from "./panel.ts";
import type { AccountProviderSpec } from "./provider.ts";
import type { AccountRegistry } from "./registry.ts";

export interface AccountCommandDeps {
	pi: ExtensionAPI;
	client: BrokerClient;
	registry: AccountRegistry;
}

/** `/accounts` subcommands, also used for argument completion. */
export const ACCOUNT_SUBCOMMANDS = [
	"status",
	"list",
	"switch",
	"default",
	"add",
	"remove",
	"enable",
	"disable",
	"reset",
] as const;

const LEGACY_CLAUDE_MESSAGE =
	"Local Claude subscriptions are no longer supported. Sign in again with /accounts add claude-subscription, then select the broker account with /accounts switch. Existing credentials were left untouched.";

/** `/accounts`: browse accounts, pools, quotas and session estimates in one panel. */
export async function showAccounts(deps: AccountCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	let selectedId: string | undefined;
	let markedIds: string[] = [];
	for (;;) {
		const accounts = managedAccounts(await deps.registry.sync(ctx));
		if (!ctx.hasUI) {
			ctx.ui.notify(formatAccountList(accounts, ctx), "info");
			return;
		}
		const entries = ctx.sessionManager.getEntries();
		const result = await ctx.ui.custom<AccountPanelResult>(
			(tui, theme, keybindings, done) =>
				new AccountsPanel(tui, theme, keybindings, done, {
					currentId: ctx.model?.provider,
					defaultId: deps.pi.getSettings().defaultProvider,
					selectedId,
					markedIds,
					entries: deps.registry.providers().map((spec) => {
						const account = accounts.find((entry) => entry.providerId === spec.id);
						return {
							id: spec.id,
							name: spec.name,
							state: account
								? `${account.state} · ${account.modelCount} models`
								: spec.target.type === "pool"
									? `${spec.models.length} models · balanced pool`
									: `${spec.models.length} models · cached account`,
							account: account !== undefined,
							pool: spec.target.type === "pool",
							readOnly: account?.readOnly,
							disabled: spec.disabled,
							costs: sessionAccountCosts(entries, spec.id),
						};
					}),
					usage: (providerId, signal) => accountUsage(deps, accounts, providerId, signal),
				}),
		);
		selectedId = result.selectedId;
		if (result.action === "cancel") return;
		if (result.action === "bulk") {
			const ids = new Set(result.selectedIds);
			const selected = accounts.filter((account) => ids.has(account.providerId) && !account.readOnly);
			markedIds = await applyAccountActions(deps, ctx, selected, result.operation);
			continue;
		}
		markedIds = [];
		if (result.action === "add") selectedId = (await addAccount(deps, ctx, "")) ?? selectedId;
		else if (result.action === "restart") {
			await deps.client.shutdown();
			ctx.ui.notify("Account broker stopped; it restarts on the next request.", "info");
			return;
		} else {
			const spec = deps.registry.provider(result.selectedId);
			if (!spec) continue;
			if (result.action === "use") {
				const models = providerModels(ctx, spec);
				const model = matchingCurrentModel(deps, ctx, spec, models) ?? models[0];
				if (model) await useModel(deps, ctx, spec, model);
				else ctx.ui.notify(`${spec.name} reports no models.`, "warning");
				return;
			}
			if (result.action === "model") {
				await chooseAccountModel(deps, ctx, spec);
			} else {
				const account = accounts.find((entry) => entry.providerId === spec.id);
				if (!account) continue;
				if (result.action === "remove") await applyAccountActions(deps, ctx, [account], "remove");
				else await manageAccount(deps, ctx, account);
			}
		}
	}
}

/** `/accounts <subcommand> [query]`; no arguments opens the panel. */
export async function runAccountCommand(
	deps: AccountCommandDeps,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!args.trim()) return showAccounts(deps, ctx);
	const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const query = rest.join(" ");
	if (isLocalClaudeProvider(query)) {
		ctx.ui.notify(LEGACY_CLAUDE_MESSAGE, "warning");
		return;
	}
	switch (subcommand) {
		case "status":
			showStatus(deps, ctx);
			return;
		case "list":
			await showAccounts(deps, ctx);
			return;
		case "switch":
			await switchAccount(deps, ctx, query, true);
			return;
		case "default":
			await switchAccount(deps, ctx, query, true);
			return;
		case "add":
			await addAccount(deps, ctx, query);
			return;
		case "remove":
		case "enable":
		case "disable":
		case "reset": {
			const accounts = managedAccounts(await deps.registry.sync(ctx));
			const account = await chooseAccount(ctx, accounts, `${subcommand} account`, query);
			if (account) {
				await applyAccountActions(deps, ctx, [account], subcommand);
				await deps.registry.sync(ctx);
			}
			return;
		}
	}
	ctx.ui.notify(`Usage: /accounts [${ACCOUNT_SUBCOMMANDS.join("|")}] [account]`, "warning");
}

/** `/models [account]`: list the models of the session's account, or of another one, and switch. */
export async function showModels(deps: AccountCommandDeps, query: string, ctx: ExtensionCommandContext): Promise<void> {
	if (isLocalClaudeProvider(query || ctx.model?.provider || "")) {
		ctx.ui.notify(LEGACY_CLAUDE_MESSAGE, "warning");
		return;
	}
	await deps.registry.sync(ctx);
	const providers = deps.registry.providers().filter((spec) => !spec.disabled);
	const candidates = query ? matchProviders(providers, query) : providers;
	const current = query ? undefined : deps.registry.provider(ctx.model?.provider ?? "");
	const spec =
		current ??
		(candidates.length === 1 ? candidates[0] : await chooseProvider(ctx, candidates, "Models of which account?"));
	if (!spec) return;
	const models = providerModels(ctx, spec);
	if (!ctx.hasUI) {
		ctx.ui.notify([`${spec.name}:`, ...models.map((model) => `  ${model.id}`)].join("\n"), "info");
		return;
	}
	await chooseAccountModel(deps, ctx, spec, models);
}

async function chooseAccountModel(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	spec: AccountProviderSpec,
	models = providerModels(ctx, spec),
): Promise<void> {
	const model = await chooseModel(ctx, spec, models);
	if (!model) return;
	const selected =
		spec.target.type === "pool"
			? await choosePoolModelAccount(model, ctx.modelRegistry.getProvider(spec.id), (title, options) =>
					ctx.ui.select(title, options),
				)
			: model;
	if (selected) await useModel(deps, ctx, deps.registry.provider(selected.provider) ?? spec, selected);
}

function showStatus(deps: AccountCommandDeps, ctx: ExtensionContext): void {
	const model = ctx.model;
	const spec = deps.registry.provider(model?.provider ?? "");
	if (!model || !spec) {
		if (model && isLocalClaudeProvider(model.provider)) {
			ctx.ui.notify(LEGACY_CLAUDE_MESSAGE, "warning");
			return;
		}
		const current = model ? `${model.provider}/${model.id}` : "no model";
		ctx.ui.notify(`This session uses ${current}, not one of the accounts. Use /accounts switch.`, "info");
		return;
	}
	const routing =
		spec.target.type === "account"
			? "pinned; failures are reported, never rerouted"
			: "pool; the broker balances and fails over";
	ctx.ui.notify(`This session uses ${model.id} on ${spec.name} (${routing}).`, "info");
}

async function manageAccount(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	account: ManagedAccount,
): Promise<void> {
	const actions = {
		use: "Use and make default",
		model: "Choose model",
		toggle: account.disabled ? "Enable" : "Disable",
		reset: "Clear cooldown",
		remove: "Remove",
	};
	const options = [
		...(!account.disabled ? [actions.use, actions.model] : []),
		...(!account.readOnly ? [actions.toggle, actions.remove] : []),
		actions.reset,
		"Back",
	];
	const choice = await ctx.ui.select(account.name, options);
	const spec = deps.registry.provider(account.providerId);
	if (choice === actions.use && spec) await switchTo(deps, ctx, spec, true);
	else if (choice === actions.model && spec) await chooseAccountModel(deps, ctx, spec);
	else if (choice === actions.toggle)
		await applyAccountActions(deps, ctx, [account], account.disabled ? "enable" : "disable");
	else if (choice === actions.reset) await applyAccountActions(deps, ctx, [account], "reset");
	else if (choice === actions.remove) await applyAccountActions(deps, ctx, [account], "remove");
}

type AccountAction = "remove" | "enable" | "disable" | "reset";

async function applyAccountActions(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	accounts: ManagedAccount[],
	action: AccountAction,
): Promise<string[]> {
	const targets = accounts.filter((account) => {
		if (account.readOnly && action !== "reset") {
			ctx.ui.notify(`${account.name} is managed in config.yaml. Edit the file and restart the broker.`, "warning");
			return false;
		}
		return !(action === "enable" && !account.disabled) && !(action === "disable" && account.disabled);
	});
	if (!targets.length) {
		if ((action === "enable" || action === "disable") && accounts.some((account) => !account.readOnly)) {
			ctx.ui.notify(`The selected accounts are already ${action === "enable" ? "enabled" : "disabled"}.`, "info");
		}
		return [];
	}
	if (action === "remove" && ctx.hasUI) {
		const title = targets.length === 1 ? "Delete account?" : `Delete ${targets.length} accounts?`;
		const names = targets.map((account) => `${account.name} [${account.providerId}]`).join("\n");
		if (!(await ctx.ui.confirm(title, `${names}\nStored credentials will be deleted. This cannot be undone.`))) {
			return targets.map((account) => account.providerId);
		}
	}
	const done = { remove: "Deleted", enable: "Enabled", disable: "Disabled", reset: "Cleared cooldown for" }[action];
	const completed: ManagedAccount[] = [];
	const failed: string[] = [];
	for (const account of targets) {
		try {
			if (action === "remove") await deps.client.removeAccount(account.key);
			else if (action === "reset") await deps.client.resetCooldown(account.key);
			else await deps.client.setDisabled(account.key, action === "disable");
			completed.push(account);
		} catch (error) {
			failed.push(account.providerId);
			ctx.ui.notify(`${account.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}
	if (completed.length) {
		const unavailable = action === "remove" || action === "disable";
		const defaultId = unavailable ? deps.pi.getSettings().defaultProvider : undefined;
		const changedRoute =
			unavailable &&
			completed.some((account) => account.providerId === ctx.model?.provider || account.providerId === defaultId);
		const message = `${done} ${completed.length === 1 ? completed[0].name : `${completed.length} accounts`}.`;
		ctx.ui.notify(
			changedRoute ? `${message} Select another account in /accounts to set a new default.` : message,
			"info",
		);
	}
	return failed;
}

/** Switch this session to an account or pool; with `persist` it also becomes the default for new sessions. */
async function switchAccount(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	query: string,
	persist: boolean,
): Promise<void> {
	await deps.registry.sync(ctx);
	const providers = deps.registry.providers().filter((spec) => !spec.disabled);
	if (providers.length === 0) {
		ctx.ui.notify("No accounts yet. Add one with /accounts add.", "warning");
		return;
	}
	const matches = query ? matchProviders(providers, query) : providers;
	const title = persist ? "Use for this and new sessions" : "Switch this session to";
	const spec = matches.length === 1 ? matches[0] : await chooseProvider(ctx, matches, title);
	if (spec) await switchTo(deps, ctx, spec, persist);
}

/** Switch to an account, keeping the current model when the new route has the same identity. */
async function switchTo(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	spec: AccountProviderSpec,
	persist: boolean,
): Promise<void> {
	const models = providerModels(ctx, spec);
	const sameModel = matchingCurrentModel(deps, ctx, spec, models);
	const model = sameModel ?? (models.length === 1 ? models[0] : await chooseModel(ctx, spec, models));
	if (model) await useModel(deps, ctx, spec, model, persist);
}

async function useModel(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	spec: AccountProviderSpec,
	model: Model<Api>,
	persist = true,
): Promise<void> {
	const previous = ctx.model;
	if (!(await deps.pi.setModel(model, { persist }))) {
		ctx.ui.notify(`${spec.name} is not available. Check /accounts.`, "error");
		return;
	}
	// Pi keys signatures and encrypted reasoning to provider + model, so a different account never
	// replays the previous account's continuation state; text and tool history are kept.
	const changedAccount = previous !== undefined && previous.provider !== model.provider;
	const scope = persist ? "This and new sessions use" : "This session now uses";
	const history = changedAccount ? " Conversation history is kept; earlier reasoning is replayed as a summary." : "";
	ctx.ui.notify(`${scope} ${model.id} on ${spec.name}.${history}`, "info");
}

async function addAccount(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	requested: string,
): Promise<string | undefined> {
	const hadChatAccount = deps.registry
		.providers()
		.some((spec) => !spec.disabled && spec.target.type === "account" && spec.models.length > 0);
	const added = await enrollAccount(deps.client, ctx, requested);
	if (!added) return;
	await deps.registry.sync(ctx);
	const id = accountProviderId(added.id);
	ctx.ui.notify(`Added ${accountDisplayName(added)}. Select it in /accounts to use it as your default.`, "info");
	const spec = deps.registry.provider(id);
	if (
		!hadChatAccount &&
		!ctx.model &&
		!deps.pi.getSettings().defaultProvider &&
		spec &&
		!spec.disabled &&
		spec.models.length
	) {
		await switchTo(deps, ctx, spec, true);
	}
	return id;
}

function providerModels(ctx: ExtensionContext, spec: AccountProviderSpec): Model<Api>[] {
	return ctx.modelRegistry.getAll().filter((model) => model.provider === spec.id);
}

function matchingCurrentModel(
	deps: AccountCommandDeps,
	ctx: ExtensionContext,
	spec: AccountProviderSpec,
	models: readonly Model<Api>[],
): Model<Api> | undefined {
	const current = ctx.model;
	if (!current) return undefined;
	const candidate = models.find((model) => model.id === current.id && model.api === current.api);
	if (!candidate) return undefined;
	const currentFamily = isBrokerProvider(current.provider)
		? deps.registry.modelRouteFamily(current.provider, current.id)
		: sharedRouteFamily(familyOf(current.provider));
	const targetFamily = deps.registry.modelRouteFamily(spec.id, candidate.id);
	return currentFamily && targetFamily === currentFamily ? candidate : undefined;
}

async function chooseModel(
	ctx: ExtensionCommandContext,
	spec: AccountProviderSpec,
	models: readonly Model<Api>[],
): Promise<Model<Api> | undefined> {
	if (models.length === 0) {
		ctx.ui.notify(`${spec.name} reports no models.`, "warning");
		return undefined;
	}
	const options = models.map((model) => (model.name === model.id ? model.id : `${model.id}  ${model.name}`));
	const choice = await ctx.ui.select(`Model on ${spec.name}`, options);
	return choice ? models[options.indexOf(choice)] : undefined;
}

async function chooseProvider(
	ctx: ExtensionCommandContext,
	providers: readonly AccountProviderSpec[],
	title: string,
): Promise<AccountProviderSpec | undefined> {
	if (providers.length === 0) {
		ctx.ui.notify("No matching accounts.", "warning");
		return undefined;
	}
	const options = providers.map((spec) => (spec.id === ctx.model?.provider ? `${spec.name} (current)` : spec.name));
	const choice = await ctx.ui.select(title, options);
	return choice ? providers[options.indexOf(choice)] : undefined;
}

async function chooseAccount(
	ctx: ExtensionCommandContext,
	accounts: readonly ManagedAccount[],
	title: string,
	query: string,
): Promise<ManagedAccount | undefined> {
	const matches = query ? accounts.filter((account) => accountMatches(account, query)) : accounts;
	if (matches.length === 1) return matches[0];
	if (matches.length === 0 || !ctx.hasUI) {
		ctx.ui.notify(
			matches.length === 0 ? "No matching accounts." : "Several accounts match; name one exactly.",
			"warning",
		);
		return undefined;
	}
	const options = matches.map((account) => account.name);
	const choice = await ctx.ui.select(title, options);
	return choice ? matches[options.indexOf(choice)] : undefined;
}

function accountMatches(account: ManagedAccount, query: string): boolean {
	const needle = query.toLowerCase();
	return account.aliases.some((value) => value?.toLowerCase().includes(needle));
}

function matchProviders(providers: readonly AccountProviderSpec[], query: string): AccountProviderSpec[] {
	const needle = query.toLowerCase();
	const exact = providers.filter((spec) => spec.id.toLowerCase() === needle);
	return exact.length > 0
		? exact
		: providers.filter((spec) => `${spec.id} ${spec.name}`.toLowerCase().includes(needle));
}

function accountLine(account: ManagedAccount, ctx: ExtensionContext): string {
	const current = ctx.model?.provider === account.providerId ? "* " : "  ";
	return `${current}${account.name} - ${account.state} - ${account.modelCount} models`;
}

function formatAccountList(accounts: readonly ManagedAccount[], ctx: ExtensionContext): string {
	if (accounts.length === 0) return "No accounts. Add one with /accounts add in interactive mode.";
	return accounts.map((account) => accountLine(account, ctx)).join("\n");
}

/** A broker account in the list and selectors. */
interface ManagedAccount {
	key: string;
	providerId: string;
	name: string;
	state: string;
	disabled: boolean;
	readOnly: boolean;
	modelCount: number;
	/** Texts a query may match: ids, email, label. */
	aliases: readonly (string | undefined)[];
}

function managedAccounts(accounts: readonly BrokerAccount[]): ManagedAccount[] {
	return accounts.map((account) => {
		const providerId = accountProviderId(account.id);
		return {
			key: account.key,
			providerId,
			name: accountDisplayName(account),
			state: accountState(account),
			disabled: account.disabled,
			readOnly: account.source === "config",
			modelCount: account.modelCount,
			aliases: [account.id, providerId, account.email, account.label],
		};
	});
}

function accountUsage(
	deps: AccountCommandDeps,
	accounts: readonly ManagedAccount[],
	providerId: string,
	signal: AbortSignal,
): Promise<BrokerUsage> {
	const account = accounts.find((entry) => entry.providerId === providerId);
	if (account) return deps.client.accountUsage(account.key, signal);
	return Promise.resolve({
		status: "unavailable",
		reason: "Select an account to see its usage.",
		windows: [],
		credits: [],
	});
}

/** Short availability summary from broker state. */
function accountState(account: BrokerAccount): string {
	if (account.disabled) return "disabled";
	if (account.retryAfter) return `cooling down until ${new Date(account.retryAfter).toLocaleTimeString()}`;
	if (account.quotaExceeded) return "quota exceeded";
	if (account.unavailable) return account.statusMessage ? `unavailable: ${account.statusMessage}` : "unavailable";
	if (account.status === "error" && account.lastError) return `error: ${account.lastError.message}`;
	return "ready";
}
