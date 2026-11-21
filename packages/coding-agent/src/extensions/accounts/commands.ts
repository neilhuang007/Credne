import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import {
	ALL_POOL,
	accountDisplayName,
	accountProviderId,
	familyTitle,
	isLocalClaudeProvider,
	poolProviderId,
} from "./catalog.ts";
import type { BrokerAccount, BrokerClient, BrokerLogin, BrokerLoginProvider, BrokerUsage } from "./client.ts";
import { sessionAccountCosts } from "./costs.ts";
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

/** A subscription browser sign-in through the broker. */
interface LoginWay {
	id: string;
	label: string;
	kind: "login";
	/** Broker login provider. */
	provider: BrokerLoginProvider;
	/** What the user signs in to, for messages. */
	title: string;
}

/** A provider API key typed in; the broker validates it. */
interface ApiKeyWay {
	id: string;
	label: string;
	kind: "api-key";
	provider: "claude" | "openai";
	title: string;
	placeholder: string;
}

type AddWay = LoginWay | ApiKeyWay;

interface AddFamily {
	id: string;
	label: string;
	ways: readonly AddWay[];
}

/**
 * What `/accounts add` offers: the first menu lists the families, the second the ways of one family;
 * a family with a single way skips the second menu. The ids are the arguments of `/accounts add <id>`.
 */
const ADD_FAMILIES: readonly AddFamily[] = [
	{
		id: "claude",
		label: "Claude account",
		ways: [
			{
				id: "claude-subscription",
				label: "Subscription (Pro, Max, Team sign-in)",
				kind: "login",
				provider: "claude",
				title: "Claude",
			},
			{
				id: "claude-api-key",
				label: "API key (Anthropic Console key)",
				kind: "api-key",
				provider: "claude",
				title: "Anthropic",
				placeholder: "sk-ant-api03-...",
			},
		],
	},
	{
		id: "chatgpt",
		label: "ChatGPT account",
		ways: [
			{
				id: "openai-api-key",
				label: "API key (OpenAI API credits)",
				kind: "api-key",
				provider: "openai",
				title: "OpenAI",
				placeholder: "sk-...",
			},
			{
				id: "codex",
				label: "Subscription (ChatGPT sign-in through Codex)",
				kind: "login",
				provider: "codex",
				title: familyTitle("codex"),
			},
		],
	},
];

/** Arguments of `/accounts add`, in menu order, for argument completion and the usage warning. */
export const ADD_ARGUMENTS: readonly { id: string; label: string }[] = ADD_FAMILIES.flatMap((family) => [
	family,
	...family.ways,
]);

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_POLL_MS = 1_000;
const LEGACY_CLAUDE_MESSAGE =
	"Local Claude subscriptions are no longer supported. Sign in again with /accounts add claude-subscription, then select the broker account with /accounts switch. Existing credentials were left untouched.";

/** `/accounts`: browse accounts, pools, quotas and session estimates in one panel. */
export async function showAccounts(deps: AccountCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	let selectedId: string | undefined;
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
					selectedId,
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
							disabled: spec.disabled,
							costs: sessionAccountCosts(entries, spec.id),
						};
					}),
					usage: (providerId, signal) => accountUsage(deps, accounts, providerId, signal),
				}),
		);
		selectedId = result.selectedId;
		if (result.action === "cancel") return;
		if (result.action === "add") await addAccount(deps, ctx, "");
		else if (result.action === "restart") {
			await deps.client.shutdown();
			ctx.ui.notify("Account broker stopped; it restarts on the next request.", "info");
			return;
		} else {
			const spec = deps.registry.provider(result.selectedId);
			if (!spec) continue;
			if (result.action === "use") {
				const models = providerModels(ctx, spec);
				const model = models.find((entry) => entry.id === ctx.model?.id) ?? models[0];
				if (model) await useModel(deps, ctx, spec, model);
				else ctx.ui.notify(`${spec.name} reports no models.`, "warning");
				return;
			}
			if (result.action === "model") {
				const model = await chooseModel(ctx, spec, providerModels(ctx, spec));
				if (model) await useModel(deps, ctx, spec, model);
			} else {
				const account = accounts.find((entry) => entry.providerId === spec.id);
				if (account) await manageAccount(deps, ctx, account);
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
			if (account) await applyAccountAction(deps, ctx, account, subcommand);
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
	const model = await chooseModel(ctx, spec, models);
	if (model) await useModel(deps, ctx, spec, model);
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
		use: "Use in this session",
		model: "Choose model",
		toggle: account.disabled ? "Enable" : "Disable",
		reset: "Clear cooldown",
		remove: "Remove",
	};
	const choice = await ctx.ui.select(account.name, [...Object.values(actions), "Back"]);
	const spec = deps.registry.provider(account.providerId);
	if (choice === actions.use && spec) await switchTo(deps, ctx, spec, true);
	else if (choice === actions.model && spec) {
		const model = await chooseModel(ctx, spec, providerModels(ctx, spec));
		if (model) await useModel(deps, ctx, spec, model);
	} else if (choice === actions.toggle)
		await applyAccountAction(deps, ctx, account, account.disabled ? "enable" : "disable");
	else if (choice === actions.reset) await applyAccountAction(deps, ctx, account, "reset");
	else if (choice === actions.remove) await applyAccountAction(deps, ctx, account, "remove");
}

type AccountAction = "remove" | "enable" | "disable" | "reset";

async function applyAccountAction(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	account: ManagedAccount,
	action: AccountAction,
): Promise<void> {
	const name = account.name;
	if (action === "remove" && ctx.hasUI) {
		if (!(await ctx.ui.confirm("Remove account?", `${name}\nIts stored credential is deleted.`))) return;
	}
	if (action === "remove") await deps.client.removeAccount(account.key);
	else if (action === "reset") await deps.client.resetCooldown(account.key);
	else await deps.client.setDisabled(account.key, action === "disable");
	await deps.registry.sync(ctx);
	const done = { remove: "Removed", enable: "Enabled", disable: "Disabled", reset: "Cleared cooldown for" }[action];
	ctx.ui.notify(`${done} ${name}`, "info");
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

/** Switch to an account, keeping the current model id when the account offers it. */
async function switchTo(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	spec: AccountProviderSpec,
	persist: boolean,
): Promise<void> {
	const models = providerModels(ctx, spec);
	const sameModel = models.find((model) => model.id === ctx.model?.id);
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

/**
 * After the first account is added, make the combined pool the default when no default model is
 * configured, so new sessions draw on every account.
 */
async function adoptPoolAsDefault(deps: AccountCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	if (deps.pi.getSettings().defaultProvider) return;
	const pool = deps.registry.provider(poolProviderId(ALL_POOL));
	if (pool) await switchTo(deps, ctx, pool, true);
}

async function addAccount(deps: AccountCommandDeps, ctx: ExtensionCommandContext, requested: string): Promise<void> {
	const argument = requested.trim().toLowerCase();
	if (argument === "claude-api-credits") {
		ctx.ui.notify(
			"Claude Console credits sign-in is not supported by the account broker. Use /accounts add claude-api-key with an Anthropic Console API key, or /accounts add claude-subscription.",
			"warning",
		);
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Adding an account needs interactive mode.", "warning");
		return;
	}
	const way = await chooseAddWay(ctx, argument);
	if (!way) return;
	const hadAccounts = deps.registry.providers().length > 0;
	const added = await runAddWay(deps, ctx, way);
	if (added) await finishAdding(deps, ctx, added, hadAccounts);
}

/** Add an account the chosen way; the message to show once it is registered, or undefined when cancelled. */
async function runAddWay(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	way: AddWay,
): Promise<string | undefined> {
	const account =
		way.kind === "api-key" ? await addApiKeyAccount(deps, ctx, way) : await signInAccount(deps, ctx, way);
	return account && `Added ${accountDisplayName(account)}. It funds the matching pools; /accounts switch pins it.`;
}

/** The way to add an account, from the argument of `/accounts add` or from the menus; undefined when cancelled. */
async function chooseAddWay(ctx: ExtensionCommandContext, argument: string): Promise<AddWay | undefined> {
	if (!argument) return chooseFromMenus(ctx);
	const family = ADD_FAMILIES.find((entry) => entry.id === argument);
	if (family) return chooseWay(ctx, family);
	const way = ADD_FAMILIES.flatMap((entry) => entry.ways).find((entry) => entry.id === argument);
	if (!way) {
		const valid = ADD_ARGUMENTS.map((entry) => entry.id).join(", ");
		ctx.ui.notify(`Unknown account type "${argument}". Use one of: ${valid}.`, "warning");
	}
	return way;
}

/** First menu (families), then the family's ways; Escape at the second menu returns to the first. */
async function chooseFromMenus(ctx: ExtensionCommandContext): Promise<AddWay | undefined> {
	for (;;) {
		const family = await selectEntry(ctx, "Add account", ADD_FAMILIES);
		if (!family) return undefined;
		const way = await chooseWay(ctx, family);
		if (way) return way;
	}
}

async function chooseWay(ctx: ExtensionCommandContext, family: AddFamily): Promise<AddWay | undefined> {
	if (family.ways.length === 1) return family.ways[0];
	return selectEntry(ctx, `Add ${family.label}`, family.ways);
}

async function selectEntry<T extends { label: string }>(
	ctx: ExtensionCommandContext,
	title: string,
	entries: readonly T[],
): Promise<T | undefined> {
	const choice = await ctx.ui.select(
		title,
		entries.map((entry) => entry.label),
	);
	return entries.find((entry) => entry.label === choice);
}

/** Sign in through the broker's browser login; undefined when the user cancels or it times out. */
async function signInAccount(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	way: LoginWay,
): Promise<BrokerAccount | undefined> {
	const started = await deps.client.startLogin(way.provider);
	const login = started.type === "browser" ? started : await acknowledgeLoginRisk(deps, ctx, started);
	if (!login) return undefined;
	openBrowser(login.url);
	ctx.ui.notify(
		`Sign in to ${way.title} in your browser. If it did not open, visit:\n${login.url}${login.userCode ? `\nCode: ${login.userCode}` : ""}`,
		"info",
	);
	return waitForLogin(deps, ctx, login, way.title);
}

async function acknowledgeLoginRisk(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	login: Extract<BrokerLogin, { type: "acknowledge-risk" }>,
): Promise<Extract<BrokerLogin, { type: "browser" }> | undefined> {
	try {
		if (await ctx.ui.confirm("Acknowledge subscription sign-in risk?", login.warning)) {
			return await deps.client.acknowledgeLoginRisk(login.state);
		}
	} catch (error) {
		await deps.client.cancelLogin(login.state).catch(() => {});
		throw error;
	}
	await deps.client.cancelLogin(login.state).catch(() => {});
	ctx.ui.notify("Sign-in cancelled.", "warning");
	return undefined;
}

async function waitForLogin(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	login: Extract<BrokerLogin, { type: "browser" }>,
	title: string,
): Promise<BrokerAccount | undefined> {
	// The broker's callback listener normally completes the login. The input lets the user paste the
	// redirect URL when the browser cannot reach it (remote or headless sessions).
	const dismiss = new AbortController();
	let finished = false;
	let cancelled = false;
	void ctx.ui
		.input(`Waiting for ${title} sign-in`, "Paste the redirect URL only if the browser shows an error", {
			signal: dismiss.signal,
		})
		.then(async (value) => {
			if (finished) return;
			if (value?.trim()) await deps.client.submitLoginCallback(login.state, value.trim());
			else cancelled = true;
		})
		.catch((error: unknown) => {
			cancelled = true;
			ctx.ui.notify(`Callback rejected: ${error instanceof Error ? error.message : String(error)}`, "error");
		});

	let account: BrokerAccount | undefined;
	try {
		const deadline = Date.now() + LOGIN_TIMEOUT_MS;
		while (!cancelled && Date.now() < deadline) {
			const status = await deps.client.loginStatus(login.state);
			if (status.status === "error") throw new Error(status.error ?? "Sign-in failed");
			if (status.status === "ok") {
				account = status.account;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS));
		}
	} finally {
		finished = true;
		dismiss.abort();
		if (!account) await deps.client.cancelLogin(login.state).catch(() => {});
	}
	if (!account) ctx.ui.notify(cancelled ? "Sign-in cancelled." : "Sign-in timed out.", "warning");
	return account;
}

async function finishAdding(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	message: string,
	hadAccounts: boolean,
): Promise<void> {
	await deps.registry.sync(ctx);
	ctx.ui.notify(message, "info");
	if (!hadAccounts) await adoptPoolAsDefault(deps, ctx);
}

/** Ask for a provider API key and add it after the broker validates it. */
async function addApiKeyAccount(
	deps: AccountCommandDeps,
	ctx: ExtensionCommandContext,
	way: ApiKeyWay,
): Promise<BrokerAccount | undefined> {
	const name = (await ctx.ui.input("Name for this API key", "for example: work"))?.trim();
	if (!name) return undefined;
	// Extension dialogs have no masked input, so the key is visible while typed.
	const key = (await ctx.ui.input(`${way.title} API key (visible while typing)`, way.placeholder))?.trim();
	if (!key) return undefined;
	const account = await deps.client.addApiKey(name, key, way.provider);
	if (!account) ctx.ui.notify("The broker did not return the new account.", "warning");
	return account;
}

function providerModels(ctx: ExtensionContext, spec: AccountProviderSpec): Model<Api>[] {
	return ctx.modelRegistry.getAll().filter((model) => model.provider === spec.id);
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
