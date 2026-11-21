import { isAbsolute, join, relative } from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getAgentDir, getPackageDir, getRuntimePackageDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { isToolCallEventType } from "../../core/extensions/types.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { BrokerClient, locateBrokerBinary } from "./client.ts";
import { ACCOUNT_SUBCOMMANDS, type AccountCommandDeps, runAccountCommand, showModels } from "./commands.ts";
import { ADD_ARGUMENTS } from "./enrollment.ts";
import { AccountRegistry } from "./registry.ts";

export function createAccountBrokerClient(agentDir = getAgentDir()): BrokerClient {
	return new BrokerClient({
		home: join(agentDir, "accounts"),
		locateBinary: () =>
			locateBrokerBinary([join(getRuntimePackageDir(), "bin"), join(getPackageDir(), "bin"), join(agentDir, "bin")]),
	});
}

/** Registers accounts and pools backed by the shared oh-my-pi daemon. */
export default function accountsExtension(pi: ExtensionAPI, agentDir = getAgentDir()): void {
	const client = createAccountBrokerClient(agentDir);
	const home = client.home;

	// The broker reports the account that served the last pool request in a response header.
	let statusContext: ExtensionContext | undefined;
	const servedBy = new Map<string, string>();
	const showCurrentAccount = (ctx: ExtensionContext): void => {
		statusContext = ctx;
		const spec = registry.provider(ctx.model?.provider ?? "");
		if (!spec) {
			ctx.ui.setStatus("accounts", undefined);
			return;
		}
		const served = spec.target.type === "pool" ? registry.accountByKey(servedBy.get(spec.id) ?? "") : undefined;
		ctx.ui.setStatus("accounts", served ? `account: ${spec.name} -> ${served.name}` : `account: ${spec.name}`);
	};

	// Cached broker accounts register synchronously so a resumed session can restore its account.
	const registry = new AccountRegistry(pi, client, join(home, "catalog.json"), (providerId, accountKey) => {
		servedBy.set(providerId, accountKey);
		if (!statusContext) return;
		try {
			showCurrentAccount(statusContext);
		} catch {
			// The context went stale after a session switch; the next event refreshes the status.
		}
	});
	const deps: AccountCommandDeps = { pi, client, registry };

	pi.on("session_start", (_event, ctx) => {
		servedBy.clear();
		showCurrentAccount(ctx);
		// Refresh only from an already running broker: opening a session must not start it.
		void (async () => {
			if (!(await client.connectExisting())) return;
			await registry.sync(ctx);
			showCurrentAccount(ctx);
		})().catch(() => {});
	});

	pi.on("model_select", (_event, ctx) => showCurrentAccount(ctx));

	// The accounts home holds credentials, including unused legacy files. Keep it out of model context.
	// Shell tools run as the same OS user and are not covered; see broker/README.md.
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
