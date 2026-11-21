import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import type {
	BrokerAccount,
	BrokerAuthMethod,
	BrokerClient,
	BrokerLogin,
	BrokerLoginAuthorization,
	BrokerProvider,
} from "./client.ts";

interface AddWay {
	id: string;
	label: string;
	method: BrokerAuthMethod;
	provider: string;
	title: string;
	placeholder?: string;
}

interface AddGroup {
	id: string;
	label: string;
	ways: readonly AddWay[];
}

const FAMILIAR_GROUPS: readonly AddGroup[] = [
	{
		id: "claude",
		label: "Claude account",
		ways: [
			{
				id: "claude-subscription",
				label: "Subscription (Pro, Max, Team sign-in)",
				method: "oauth",
				provider: "anthropic",
				title: "Claude",
			},
			{
				id: "claude-api-key",
				label: "API key (Anthropic Console key)",
				method: "api-key",
				provider: "anthropic",
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
				method: "api-key",
				provider: "openai",
				title: "OpenAI",
				placeholder: "sk-...",
			},
			{
				id: "codex",
				label: "Subscription (ChatGPT sign-in through Codex)",
				method: "oauth",
				provider: "openai-codex",
				title: "ChatGPT Codex",
			},
		],
	},
];
const OTHER = { id: "other", label: "Other providers" };
const FAMILIAR_WAYS = FAMILIAR_GROUPS.flatMap((group) => group.ways);

/** Static add shortcuts. Completion never starts a broker to discover providers. */
export const ADD_ARGUMENTS: readonly { id: string; label: string }[] = [
	...FAMILIAR_GROUPS.flatMap((group) => [group, ...group.ways]),
	OTHER,
];

/** Discover supported enrollment methods, then ask the broker to complete the chosen method. */
export async function enrollAccount(
	client: BrokerClient,
	ctx: ExtensionCommandContext,
	argument: string,
): Promise<BrokerAccount | undefined> {
	if (argument.toLowerCase() === "claude-api-credits") {
		ctx.ui.notify(
			"Claude Console credits sign-in is not supported by the account broker. Use /accounts add claude-api-key with an Anthropic Console API key, or /accounts add claude-subscription.",
			"warning",
		);
		return undefined;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Adding an account needs interactive mode.", "warning");
		return undefined;
	}
	const providers = await client.listProviders();
	const way = await chooseAddWay(ctx, argument, providers);
	if (!way) return undefined;
	return way.method === "api-key" ? addApiKeyAccount(client, ctx, way) : signInAccount(client, ctx, way);
}

async function chooseAddWay(
	ctx: ExtensionCommandContext,
	argument: string,
	providers: readonly BrokerProvider[],
): Promise<AddWay | undefined> {
	const [id, method, extra] = argument.split(/\s+/);
	const shortcut = id?.toLowerCase();
	const groups = FAMILIAR_GROUPS.map((group) => ({
		...group,
		ways: group.ways.filter((way) => providers.some((provider) => provides(provider, way))),
	}));
	if (!shortcut) return chooseFromMenus(ctx, groups, otherGroups(providers));
	if (!method && shortcut === OTHER.id) return chooseOther(ctx, otherGroups(providers));
	if (!method) {
		const group = groups.find((entry) => entry.id === shortcut);
		if (group) return chooseWay(ctx, group);
		const way = FAMILIAR_WAYS.find((entry) => entry.id === shortcut);
		if (way) {
			if (providers.some((provider) => provides(provider, way))) return way;
			ctx.ui.notify(`${way.title} does not offer ${way.label} through this broker.`, "warning");
			return undefined;
		}
	}
	const provider = providers.find((entry) => entry.id === id);
	if (provider && !extra && (!method || method === "api-key" || method === "oauth")) {
		const group = providerGroup(provider);
		return chooseWay(ctx, { ...group, ways: group.ways.filter((way) => !method || way.method === method) });
	}
	ctx.ui.notify(
		`Unknown account type "${argument}". Use /accounts add to browse providers, or /accounts add <provider-id> [api-key|oauth].`,
		"warning",
	);
	return undefined;
}

function provides(provider: BrokerProvider, way: AddWay): boolean {
	return provider.id === way.provider && provider.authMethods.includes(way.method);
}

function providerGroup(provider: BrokerProvider): AddGroup {
	return {
		id: provider.id,
		label: `${provider.name} (${provider.id})`,
		ways: provider.authMethods.map(
			(method) =>
				FAMILIAR_WAYS.find((way) => way.provider === provider.id && way.method === method) ?? {
					id: `${provider.id} ${method}`,
					label: method === "api-key" ? "API key" : "Sign in (OAuth)",
					method,
					provider: provider.id,
					title: provider.name,
				},
		),
	};
}

function otherGroups(providers: readonly BrokerProvider[]): AddGroup[] {
	return providers
		.map((provider) => {
			const group = providerGroup(provider);
			return { ...group, ways: group.ways.filter((way) => !FAMILIAR_WAYS.includes(way)) };
		})
		.filter((group) => group.ways.length > 0);
}

async function chooseFromMenus(
	ctx: ExtensionCommandContext,
	groups: readonly AddGroup[],
	others: readonly AddGroup[],
): Promise<AddWay | undefined> {
	const available = groups.filter((group) => group.ways.length > 0);
	const choices = others.length > 0 ? [...available, OTHER] : available;
	if (choices.length === 0) {
		ctx.ui.notify("The account broker does not offer any enrollment methods.", "warning");
		return undefined;
	}
	for (;;) {
		const label = await ctx.ui.select(
			"Add account",
			choices.map((choice) => choice.label),
		);
		if (!label) return undefined;
		if (label === OTHER.label) {
			const way = await chooseOther(ctx, others);
			if (way) return way;
		} else {
			const group = available.find((entry) => entry.label === label);
			if (!group) return undefined;
			const way = await chooseWay(ctx, group);
			if (way) return way;
		}
	}
}

async function chooseOther(ctx: ExtensionCommandContext, groups: readonly AddGroup[]): Promise<AddWay | undefined> {
	if (groups.length === 0) {
		ctx.ui.notify("The account broker does not offer any other providers.", "warning");
		return undefined;
	}
	for (;;) {
		const label = await ctx.ui.select(
			OTHER.label,
			groups.map((group) => group.label),
		);
		const group = groups.find((entry) => entry.label === label);
		if (!group) return undefined;
		const way = await chooseWay(ctx, group);
		if (way) return way;
	}
}

async function chooseWay(ctx: ExtensionCommandContext, group: AddGroup): Promise<AddWay | undefined> {
	if (group.ways.length === 0) {
		ctx.ui.notify(
			`The requested enrollment method for ${group.label} is not available through this broker.`,
			"warning",
		);
		return undefined;
	}
	if (group.ways.length === 1) return group.ways[0];
	const label = await ctx.ui.select(
		`Add ${group.label}`,
		group.ways.map((way) => way.label),
	);
	return group.ways.find((way) => way.label === label);
}

async function addApiKeyAccount(
	client: BrokerClient,
	ctx: ExtensionCommandContext,
	way: AddWay,
): Promise<BrokerAccount | undefined> {
	const name = (await ctx.ui.input("Name for this API key", "for example: work"))?.trim();
	if (!name) return undefined;
	// Extension dialogs have no masked input, so the key is visible while typed.
	const notice = FAMILIAR_WAYS.includes(way)
		? "visible while typing"
		: "visible while typing; validation may incur a charge";
	const key = (await ctx.ui.input(`${way.title} API key (${notice})`, way.placeholder))?.trim();
	if (!key) return undefined;
	const account = await client.addApiKey(name, key, way.provider);
	if (!account) ctx.ui.notify("The broker did not return the new account.", "warning");
	return account;
}

async function signInAccount(
	client: BrokerClient,
	ctx: ExtensionCommandContext,
	way: AddWay,
): Promise<BrokerAccount | undefined> {
	const started = await client.startLogin(way.provider);
	const login = started.type === "acknowledge-risk" ? await acknowledgeLoginRisk(client, ctx, started) : started;
	if (!login) return undefined;
	openBrowser(login.url);
	const details = [login.url, login.userCode ? `Code: ${login.userCode}` : undefined, login.instructions];
	ctx.ui.notify(
		`Sign in to ${way.title} in your browser. If it did not open, visit:\n${details.filter(Boolean).join("\n")}`,
		"info",
	);
	return waitForLogin(client, ctx, login, way.title);
}

async function acknowledgeLoginRisk(
	client: BrokerClient,
	ctx: ExtensionCommandContext,
	login: Extract<BrokerLogin, { type: "acknowledge-risk" }>,
): Promise<BrokerLoginAuthorization | undefined> {
	try {
		if (await ctx.ui.confirm("Acknowledge subscription sign-in risk?", login.warning)) {
			return await client.acknowledgeLoginRisk(login.state);
		}
	} catch (error) {
		await client.cancelLogin(login.state).catch(() => {});
		throw error;
	}
	await client.cancelLogin(login.state).catch(() => {});
	ctx.ui.notify("Sign-in cancelled.", "warning");
	return undefined;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_POLL_MS = 1_000;

async function waitForLogin(
	client: BrokerClient,
	ctx: ExtensionCommandContext,
	login: BrokerLoginAuthorization,
	title: string,
): Promise<BrokerAccount | undefined> {
	const dismiss = new AbortController();
	let cancelled = false;
	// A browser callback can fail to reach a remote broker; a device login never needs a redirect.
	const waiting = `Waiting for ${title} sign-in`;
	const dialog =
		login.type === "device"
			? ctx.ui.select(waiting, ["Cancel sign-in"], { signal: dismiss.signal })
			: ctx.ui.input(waiting, "Paste the redirect URL only if the browser shows an error", {
					signal: dismiss.signal,
				});
	void dialog
		.then(async (value) => {
			if (dismiss.signal.aborted) return;
			if (login.type === "browser" && value?.trim()) await client.submitLoginCallback(login.state, value.trim());
			else cancelled = true;
		})
		.catch((error: unknown) => {
			cancelled = true;
			ctx.ui.notify(`Sign-in input failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		});

	let account: BrokerAccount | undefined;
	try {
		const deadline = Date.now() + LOGIN_TIMEOUT_MS;
		while (!cancelled && Date.now() < deadline) {
			const status = await client.loginStatus(login.state);
			if (status.status === "error") throw new Error(status.error ?? "Sign-in failed");
			if (status.status === "ok") {
				account = status.account;
				break;
			}
			if (!cancelled) await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS));
		}
	} finally {
		dismiss.abort();
		if (!account) await client.cancelLogin(login.state).catch(() => {});
	}
	if (!account) ctx.ui.notify(cancelled ? "Sign-in cancelled." : "Sign-in timed out.", "warning");
	return account;
}
