import { isAbsolute, join, relative } from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getAgentDir, getBinDir, getPackageDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { isToolCallEventType } from "../../core/extensions/types.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { LocalClaude } from "./claude-local.ts";
import { poolMembers } from "./claude-pool.ts";
import { BrokerClient, locateBrokerBinary } from "./client.ts";
import {
	ACCOUNT_SUBCOMMANDS,
	type AccountCommandDeps,
	ADD_ARGUMENTS,
	runAccountCommand,
	showModels,
} from "./commands.ts";
import type { AccountProviderSpec } from "./provider.ts";
import { AccountRegistry } from "./registry.ts";
import { latestServingProvider } from "./served.ts";

export function createAccountBrokerClient(): BrokerClient {
	return new BrokerClient({
		home: join(getAgentDir(), "accounts"),
		locateBinary: () => locateBrokerBinary([join(getPackageDir(), "bin"), getBinDir()]),
	});
}

/**
 * Multiple provider accounts. Claude subscriptions are served by this process: each is a Pi provider
 * `claude-sub:<id>` whose tokens are stored and refreshed locally and whose requests go straight to
 * api.anthropic.com. Every other account goes through the shared oh-my-pi account daemon
 * as a Pi provider `acct:<id>`; each family there gets a balanced `pool:<family>`. The pools
 * `pool:claude` and `pool:all` are virtual models that use subscriptions first, then API accounts.
 * Sessions, prompts, tools and the agent loop stay in Pi.
 */
export default function accountsExtension(pi: ExtensionAPI): void {
	// Accounts home: broker credentials, broker config, discovery file, account catalog and local subscriptions.
	const client = createAccountBrokerClient();
	const home = client.home;
	const local = new LocalClaude({ home });

	// The footer names the account and, for pools, the account that served the last request. A broker pool
	// reports it in a response header; a virtual pool records the physical account on each answer.
	let statusContext: ExtensionContext | undefined;
	let latestServedProvider: string | undefined;
	const servedBy = new Map<string, string>();
	const servingAccount = (spec: AccountProviderSpec): AccountProviderSpec | undefined => {
		if (spec.target.type === "pool") return registry.accountByKey(servedBy.get(spec.id) ?? "");
		if (spec.target.type !== "virtual-pool") return undefined;
		return poolMembers(registry.providers(), spec.target.name).find((member) => member.id === latestServedProvider);
	};
	const showCurrentAccount = (ctx: ExtensionContext): void => {
		statusContext = ctx;
		const spec = registry.provider(ctx.model?.provider ?? "");
		if (!spec) {
			ctx.ui.setStatus("accounts", undefined);
			return;
		}
		const served = servingAccount(spec);
		ctx.ui.setStatus("accounts", served ? `account: ${spec.name} -> ${served.name}` : `account: ${spec.name}`);
	};
	const resetServedProvider = (ctx: ExtensionContext): void => {
		latestServedProvider = latestServingProvider(ctx.sessionManager.getBranch());
		showCurrentAccount(ctx);
	};

	// Registers local subscriptions and cached broker accounts synchronously so a resumed session can restore its account.
	const registry = new AccountRegistry(pi, client, local, join(home, "catalog.json"), (providerId, accountKey) => {
		servedBy.set(providerId, accountKey);
		if (!statusContext) return;
		try {
			showCurrentAccount(statusContext);
		} catch {
			// The context went stale after a session switch; the next event refreshes the status.
		}
	});
	const deps: AccountCommandDeps = { pi, client, registry, local };

	pi.on("session_start", (_event, ctx) => {
		resetServedProvider(ctx);
		// Best effort. Subscriptions the broker still holds move to the local store first; that needs no running
		// broker. Then the catalog refreshes from an already running broker, which is never started here.
		void (async () => {
			await registry.importBrokerSubscriptions(ctx);
			showCurrentAccount(ctx);
			if (!(await client.connectExisting())) return;
			await registry.sync(ctx);
			showCurrentAccount(ctx);
		})().catch(() => {});
	});

	pi.on("model_select", (_event, ctx) => resetServedProvider(ctx));

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return;
		latestServedProvider = message.provider;
		showCurrentAccount(ctx);
	});

	// The accounts home holds OAuth refresh tokens and API keys, including the Claude subscription credentials in
	// claude-subscriptions.json. Pi's file tools must not read them into model context. Shell tools run as the
	// same OS user and are not covered; see broker/README.md.
	pi.on("tool_call", (event, ctx) => {
		if (
			!isToolCallEventType("read", event) &&
			!isToolCallEventType("edit", event) &&
			!isToolCallEventType("write", event)
		) {
			return undefined;
		}
		if (!isInside(resolveToCwd(event.input.path, ctx.cwd), home)) return undefined;
		return {
			block: true,
			reason: "Account credentials are managed by the account broker and are not accessible to tools.",
		};
	});

	pi.registerCommand("accounts", {
		description: "Account for this session: status, list, switch, default, add, remove, enable, disable, reset",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const [subcommand, ...rest] = prefix.split(/\s+/);
			if (rest.length === 0) {
				const items = ACCOUNT_SUBCOMMANDS.filter((name) => name.startsWith(subcommand ?? "")).map((name) => ({
					value: name,
					label: name,
				}));
				return items.length > 0 ? items : null;
			}
			const query = rest.join(" ").toLowerCase();
			const items =
				subcommand === "add"
					? ADD_ARGUMENTS.filter((entry) => entry.id.startsWith(query)).map((entry) => ({
							value: `add ${entry.id}`,
							label: entry.id,
							description: entry.label,
						}))
					: registry
							.providers()
							.filter((spec) => spec.id.toLowerCase().includes(query) || spec.name.toLowerCase().includes(query))
							.map((spec) => ({ value: `${subcommand} ${spec.id}`, label: spec.id, description: spec.name }));
			return items.length > 0 ? items : null;
		},
		handler: (args, ctx) => withErrors(ctx, () => runAccountCommand(deps, args, ctx)),
	});

	pi.registerCommand("models", {
		description: "List models of this session's account or pool (or another) and switch",
		handler: (args, ctx) => withErrors(ctx, () => showModels(deps, args.trim(), ctx)),
	});
}

async function withErrors(ctx: ExtensionContext, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

function isInside(path: string, directory: string): boolean {
	const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
	const rel = relative(normalize(directory), normalize(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
