import { isAbsolute, join, relative } from "node:path";
import { type AutocompleteItem, visibleWidth } from "@earendil-works/pi-tui";
import { getAgentDir, getPackageDir, getRuntimePackageDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { isToolCallEventType } from "../../core/extensions/types.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { TYPESAFE_PROVIDER } from "./catalog.ts";
import { BrokerClient, type BrokerQuotaWindow, locateBrokerBinary } from "./client.ts";
import { ACCOUNT_SUBCOMMANDS, type AccountCommandDeps, runAccountCommand, showModels } from "./commands.ts";
import { ADD_ARGUMENTS } from "./enrollment.ts";
import { AccountRegistry } from "./registry.ts";

// Refresh on session activity, not a timer that would keep an otherwise idle broker alive.
const USAGE_REFRESH_MS = 60_000;
const USAGE_TIMEOUT_MS = 8_000;

const NO_JEV_ACCOUNT_WARNING =
	"No Jev account. Add one with /accounts add jev; decisions fall back to gpt-6-luna or the session model.";

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
	let sessionGeneration = 0;
	let servingAccountKey: string | undefined;
	let quotaKey: string | undefined;
	let quotaRequest: AbortController | undefined;
	let lastQuotaReadAt = 0;

	const showQuota = (ctx: ExtensionContext, key: string | undefined): void => {
		const setBadge = ctx.ui.setMainEditorBadge;
		if (!setBadge || process.env.PI_OFFLINE) return;
		if (key !== quotaKey) {
			quotaRequest?.abort();
			quotaRequest = undefined;
			quotaKey = key;
			lastQuotaReadAt = 0;
			setBadge(undefined);
		}
		if (!key || quotaRequest || Date.now() - lastQuotaReadAt < USAGE_REFRESH_MS) return;

		const request = new AbortController();
		quotaRequest = request;
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(USAGE_TIMEOUT_MS)]);
		void client
			.accountUsageIfRunning(key, signal)
			.then(
				(usage) => {
					if (request.signal.aborted) return;
					// If the daemon is stopped, try again as soon as the next inference starts it.
					if (usage) lastQuotaReadAt = Date.now();
					setBadge(usage?.status === "available" && usage.windows.length ? quotaBadge(usage.windows) : undefined);
				},
				() => {
					if (request.signal.aborted) return;
					lastQuotaReadAt = Date.now();
					setBadge(undefined);
				},
			)
			.finally(() => {
				if (quotaRequest === request) quotaRequest = undefined;
			});
	};

	const showCurrentAccount = (ctx: ExtensionContext): void => {
		const spec = registry.provider(ctx.model?.provider ?? "");
		statusContext = ctx;
		const key = spec?.target.type === "account" ? spec.target.key : spec && servingAccountKey;
		const served = spec?.target.type === "pool" && key ? registry.accountByKey(key) : undefined;
		ctx.ui.setStatus(
			"accounts",
			spec ? (served ? `account: ${spec.name} -> ${served.name}` : `account: ${spec.name}`) : undefined,
		);
		showQuota(ctx, key && registry.isSubscriptionAccount(key) ? key : undefined);
	};

	// Cached broker accounts register synchronously so a resumed session can restore its account.
	const registry = new AccountRegistry(
		pi,
		client,
		join(home, "catalog.json"),
		(providerId, key, modelId, sessionId) => {
			if (!statusContext) return;
			try {
				const { model, sessionManager } = statusContext;
				if (model?.provider !== providerId || model.id !== modelId || sessionId !== sessionManager.getSessionId())
					return;
				servingAccountKey = key;
				showCurrentAccount(statusContext);
			} catch {
				// The context went stale after a session switch; the next event refreshes the status.
			}
		},
	);
	const deps: AccountCommandDeps = { pi, client, registry };

	// Jev rates delegated tasks, but a harness without it still works, so this only warns, once per process.
	let hasWarnedAboutJev = false;
	const warnIfNoJevAccount = (ctx: ExtensionContext): void => {
		if (hasWarnedAboutJev || !ctx.hasUI || registry.hasEnabledAccount(TYPESAFE_PROVIDER)) return;
		hasWarnedAboutJev = true;
		ctx.ui.notify(NO_JEV_ACCOUNT_WARNING, "warning");
	};

	pi.on("session_start", (_event, ctx) => {
		const generation = ++sessionGeneration;
		servingAccountKey = undefined;
		showCurrentAccount(ctx);
		// Refresh only from an already running broker: opening a session must not start it.
		void (async () => {
			if (!(await client.connectExisting()) || generation !== sessionGeneration || !statusContext) return;
			await registry.sync(statusContext);
			// The user may have selected another model or left the session while the catalog was loading.
			if (generation !== sessionGeneration || !statusContext) return;
			showCurrentAccount(statusContext);
			warnIfNoJevAccount(statusContext);
		})().catch(() => {});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionGeneration++;
		statusContext = undefined;
		showQuota(ctx, undefined);
	});
	pi.on("model_select", ({ model, previousModel }, ctx) => {
		if (model.provider !== previousModel?.provider || model.id !== previousModel.id) servingAccountKey = undefined;
		showCurrentAccount(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => showCurrentAccount(ctx));

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
		handler: (args, ctx) =>
			withErrors(ctx, async () => {
				await runAccountCommand(deps, args, ctx);
				if (statusContext) showCurrentAccount(statusContext);
			}),
	});

	pi.registerCommand("models", {
		description: "List models of this session's account or pool (or another) and switch",
		handler: (args, ctx) => withErrors(ctx, () => showModels(deps, args.trim(), ctx)),
	});
}

function quotaBadge(windows: readonly BrokerQuotaWindow[]): (width: number) => string {
	const limits = windows.map(({ label, usedPercent }) => ({
		// Quota labels are broker wire data: keep control characters out of the terminal border.
		label: stripAnsi(label)
			.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
			.trim()
			.replace(/^(?:(?:Claude|Codex|ChatGPT) )?5(?:[ -]*hours?|h)\b/i, "5h")
			.replace(/^(?:(?:Claude|Codex|ChatGPT) )?(?:7(?:[ -]*days?|d)|weekly)\b/i, "weekly"),
		percent: Math.round(usedPercent),
	}));
	// Prefer more complete windows over a longer bar; never clip a label or a percentage.
	const variants: { text: string; width: number }[] = [];
	for (let count = limits.length; count > 0; count--) {
		for (const slots of [7, 5, 3]) {
			const labels = limits.slice(0, count).map(({ label, percent }) => {
				const filled = Math.round((percent * slots) / 100);
				const bar = `[${"#".repeat(filled)}${"-".repeat(slots - filled)}]`;
				return `${label ? `${label} : ` : ""}${bar} ${percent}%`;
			});
			const text = ` ${labels.join(" | ")} `;
			variants.push({ text, width: visibleWidth(text) });
		}
	}
	return (width) => variants.find((badge) => badge.width <= width)?.text ?? "";
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
