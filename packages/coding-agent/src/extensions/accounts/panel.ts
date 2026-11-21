import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Keybinding, KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { BrokerQuotaWindow, BrokerUsage } from "./client.ts";
import type { SessionAccountCosts } from "./costs.ts";

export interface AccountPanelEntry {
	id: string;
	name: string;
	state: string;
	/** An individual account, which has its own usage and can be managed; a pool is not. */
	account: boolean;
	disabled: boolean;
	costs: SessionAccountCosts;
}

export type AccountPanelResult =
	| { action: "use" | "manage" | "model"; selectedId: string }
	| { action: "add" | "restart"; selectedId: string }
	| { action: "cancel"; selectedId: string };

interface AccountPanelOptions {
	entries: readonly AccountPanelEntry[];
	currentId?: string;
	selectedId?: string;
	usage: (providerId: string, signal: AbortSignal) => Promise<BrokerUsage>;
}

type PanelRow = { id: string; label: string; entry?: AccountPanelEntry };

/** Browse accounts and live usage in one panel; Enter selects the provider directly. */
export class AccountsPanel implements Component, Focusable {
	focused = true;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: AccountPanelResult) => void;
	private readonly options: AccountPanelOptions;
	private readonly rows: PanelRow[];
	private selectedIndex: number;
	private hoveredId: string | undefined;
	private renderedRows = new Map<number, number>();
	private detailOffset = 0;
	private detailPageSize = 1;
	private usage: BrokerUsage | undefined;
	private request: AbortController | undefined;
	private closed = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: AccountPanelResult) => void,
		options: AccountPanelOptions,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.options = options;
		this.rows = [
			...options.entries.map((entry) => ({ id: entry.id, label: entry.name, entry })),
			{ id: "+add", label: "+ Add account" },
			{ id: "+restart", label: "Restart broker (reload config.yaml)" },
		];
		this.selectedIndex = Math.max(
			0,
			this.rows.findIndex((row) => row.id === (options.selectedId ?? options.currentId)),
		);
		this.loadUsage();
	}

	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows - 2);
		const lines = height >= 6 ? [this.theme.bold("Accounts")] : [];
		const listSize = Math.max(1, Math.min(this.rows.length, Math.floor((height - 3) / 3)));
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(listSize / 2), this.rows.length - listSize));
		this.renderedRows.clear();
		for (let index = start; index < start + listSize; index++) {
			const row = this.rows[index];
			this.renderedRows.set(lines.length, index);
			const active = row.id === this.options.currentId ? "● active · " : "";
			const line = truncateToWidth(`${index === this.selectedIndex ? "›" : " "} ${active}${row.label}`, width);
			const selected = index === this.selectedIndex || row.id === this.hoveredId;
			const plain = stripVTControlCharacters(line);
			lines.push(selected ? `\x1b[7m${plain}${" ".repeat(Math.max(0, width - visibleWidth(plain)))}\x1b[27m` : line);
		}
		const hint = (key: Keybinding, text: string) => `${this.keybindings.getKeys(key).join("/")} ${text}`;
		const controls = [
			hint("tui.select.up", "↑"),
			hint("tui.select.down", "↓"),
			hint("tui.select.confirm", "use"),
			hint("tui.select.cancel", "close"),
			hint("app.accounts.manage", "manage"),
			hint("app.accounts.model", "model"),
			hint("app.accounts.refresh", "refresh"),
		];
		if (height >= 6) lines.push(this.theme.fg("muted", controls.join(" · ")));
		const details = this.details(width).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
		this.detailPageSize = Math.max(1, height - lines.length - Number(height >= 6));
		this.detailOffset = Math.min(this.detailOffset, Math.max(0, details.length - this.detailPageSize));
		lines.push(...details.slice(this.detailOffset, this.detailOffset + this.detailPageSize));
		if (height >= 6 && details.length > this.detailPageSize) {
			lines.push(
				this.theme.fg(
					"muted",
					`${hint("tui.select.pageUp", "/")} ${hint("tui.select.pageDown", "details")} · ${this.detailOffset + 1}–${Math.min(details.length, this.detailOffset + this.detailPageSize)}/${details.length}`,
				),
			);
		}
		return lines.slice(0, height).map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const matches = (key: Keybinding) => this.keybindings.matches(data, key);
		if (matches("tui.select.cancel")) this.finish("cancel");
		else if (matches("tui.select.up")) this.select(Math.max(0, this.selectedIndex - 1));
		else if (matches("tui.select.down")) this.select(Math.min(this.rows.length - 1, this.selectedIndex + 1));
		else if (matches("tui.select.confirm")) this.activate();
		else if (matches("app.accounts.manage") && this.rows[this.selectedIndex].entry?.account) this.finish("manage");
		else if (matches("app.accounts.model") && this.rows[this.selectedIndex].entry) this.finish("model");
		else if (matches("app.accounts.refresh")) this.loadUsage();
		else if (matches("tui.select.pageUp")) this.detailOffset = Math.max(0, this.detailOffset - this.detailPageSize);
		else if (matches("tui.select.pageDown")) this.detailOffset += this.detailPageSize;
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		const index = this.renderedRows.get(event.y);
		if (event.type === "leave" || event.type === "move") {
			const hoveredId = event.type === "move" && index !== undefined ? this.rows[index].id : undefined;
			const changed = hoveredId !== this.hoveredId;
			this.hoveredId = hoveredId;
			return hoveredId || changed ? { handled: true, render: changed } : undefined;
		}
		if (event.type !== "click" || event.button !== "left" || index === undefined) return undefined;
		this.select(index);
		this.tui.requestRender();
		return { handled: true };
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		this.request?.abort();
	}

	private select(index: number): void {
		if (index === this.selectedIndex) return;
		this.selectedIndex = index;
		this.detailOffset = 0;
		this.loadUsage();
	}

	private activate(): void {
		const row = this.rows[this.selectedIndex];
		if (row.entry?.disabled) return;
		this.finish(row.id === "+add" ? "add" : row.id === "+restart" ? "restart" : "use");
	}

	private finish(action: AccountPanelResult["action"]): void {
		this.dispose();
		this.done({ action, selectedId: this.rows[this.selectedIndex].id });
	}

	private loadUsage(): void {
		this.request?.abort();
		this.usage = undefined;
		const entry = this.rows[this.selectedIndex].entry;
		if (!entry?.account) return;
		const request = new AbortController();
		this.request = request;
		void this.options.usage(entry.id, request.signal).then(
			(usage) => {
				if (request.signal.aborted || this.closed) return;
				this.usage = usage;
				this.tui.requestRender();
			},
			() => {
				if (request.signal.aborted || this.closed) return;
				this.usage = { status: "unavailable", reason: "Could not load provider usage.", windows: [], credits: [] };
				this.tui.requestRender();
			},
		);
	}

	private details(width: number): string[] {
		const row = this.rows[this.selectedIndex];
		const entry = row.entry;
		if (!entry)
			return [
				row.id === "+add"
					? "Add a subscription or API key."
					: "Stops the shared broker; the next request restarts it and reloads config.yaml.",
			];
		const theme = this.theme;
		const lines = ["", theme.bold(entry.name), theme.fg("muted", entry.state)];
		if (!entry.account)
			lines.push(
				"",
				theme.fg("muted", "Pool quotas belong to individual accounts; browse an account to see its limits."),
			);
		else if (!this.usage) lines.push("", theme.fg("muted", "Loading provider subscription usage…"));
		else if (this.usage.status !== "available")
			lines.push("", theme.fg("warning", `${this.usage.status}: ${this.usage.reason}`));
		else {
			if (!this.usage.windows.length) lines.push("", theme.fg("muted", "Subscription quota windows not reported."));
			for (const window of this.usage.windows) lines.push("", ...this.quotaLines(window, width));
			if (this.usage.credits.length) lines.push("", theme.bold("Credits"));
			for (const credit of this.usage.credits) {
				const amount = credit.unlimited
					? "unlimited"
					: `${credit.amount?.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${credit.unit}`;
				lines.push(`${theme.fg("muted", credit.label.padEnd(DETAIL_LABEL_WIDTH))}${amount}`);
			}
		}
		lines.push(
			"",
			theme.bold("This session"),
			theme.fg("dim", "Recorded API-rate cost estimates (USD); not billed subscription charges or quota."),
		);
		if (entry.account) {
			lines.push(...this.costLines(entry.costs.account, entry.costs.accountResponses, "Selected pinned account"));
		}
		if (!entry.account || entry.costs.poolResponses) {
			lines.push(
				...this.costLines(
					entry.costs.unattributedPools,
					entry.costs.poolResponses,
					"All pool responses · unattributed, excluded from account totals",
				),
			);
		}
		return lines;
	}

	/** One quota window: bold label, a solid bar filled to the used share with its percentage, then the reset time. */
	private quotaLines(window: BrokerQuotaWindow, width: number): string[] {
		const percent = Math.max(0, Math.min(100, window.usedPercent));
		const label = `${Math.floor(percent)}% used`;
		const barWidth = Math.max(10, Math.min(QUOTA_BAR_WIDTH, width - label.length - 1));
		const filled = percent > 0 ? Math.max(1, Math.round((percent / 100) * barWidth)) : 0;
		const bar =
			this.theme.fg("accent", "█".repeat(filled)) + this.theme.fg("borderMuted", "█".repeat(barWidth - filled));
		return [
			this.theme.bold(window.label),
			`${bar} ${percent >= 100 ? this.theme.fg("error", label) : label}`,
			this.theme.fg("muted", window.resetAt ? formatReset(new Date(window.resetAt)) : "Reset time not reported"),
		];
	}

	private costLines(cost: SessionAccountCosts["account"], responses: number, label: string): string[] {
		if (!responses) return ["", `${label}: ${this.theme.fg("muted", "no recorded responses")}`];
		const row = (name: string, value: number) =>
			`${this.theme.fg("muted", name.padEnd(DETAIL_LABEL_WIDTH))}$${value.toFixed(4)}`;
		return [
			"",
			`${label} ${this.theme.fg("muted", `(${responses} responses)`)}`,
			row("Input", cost.input),
			row("Output", cost.output),
			row("Cache read", cost.cacheRead),
			row("Cache write", cost.cacheWrite),
			this.theme.bold(`${"Total".padEnd(DETAIL_LABEL_WIDTH)}$${cost.total.toFixed(4)}`),
			this.theme.fg("dim", "Recorded rates; missing catalog prices are not billing data."),
		];
	}
}

const QUOTA_BAR_WIDTH = 50;
const DETAIL_LABEL_WIDTH = 20;

/** "Resets in 2h 14m · Nov 16, 1:49 PM" in local time. */
function formatReset(resetAt: Date): string {
	const minutes = Math.max(0, Math.round((resetAt.getTime() - Date.now()) / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const relative = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
	const absolute = resetAt.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
	return `Resets in ${relative} · ${absolute}`;
}
