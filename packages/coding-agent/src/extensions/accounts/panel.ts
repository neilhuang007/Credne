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
	/** The broker currently reports this account, so it has usage and management actions. */
	account: boolean;
	pool: boolean;
	/** Configured outside Pi; not eligible for marking or toolbar changes. */
	readOnly?: boolean;
	disabled: boolean;
	costs: SessionAccountCosts;
}

export type AccountPanelResult =
	| { action: "use" | "manage" | "model" | "remove"; selectedId: string }
	| { action: "add" | "restart"; selectedId: string }
	| { action: "cancel"; selectedId: string }
	| { action: "bulk"; operation: BulkOperation; selectedIds: string[]; selectedId: string };

interface AccountPanelOptions {
	entries: readonly AccountPanelEntry[];
	currentId?: string;
	defaultId?: string;
	selectedId?: string;
	markedIds?: readonly string[];
	usage: (providerId: string, signal: AbortSignal) => Promise<BrokerUsage>;
}

type PanelRow = { id: string; label: string; entry?: AccountPanelEntry };
type BulkOperation = "enable" | "disable" | "remove";
type ToolbarAction = "add" | "selectAll" | "clear" | BulkOperation;
type PanelAction = Exclude<AccountPanelResult["action"], "bulk"> | "refresh" | "mark" | "toolbar";
type Control = { keys: readonly Keybinding[]; label: string; action?: PanelAction };
type HitLine<Action> = { text: string; hits: { x: number; end: number; action: Action }[] };

const TOOLBAR: readonly { label: string; action: ToolbarAction }[] = [
	{ label: "+ Add", action: "add" },
	{ label: "Select all", action: "selectAll" },
	{ label: "Clear", action: "clear" },
	{ label: "Enable", action: "enable" },
	{ label: "Disable", action: "disable" },
	{ label: "Delete", action: "remove" },
];

const SPLIT_MIN_WIDTH = 72;
const DIVIDER = " │ ";

/** Browse account usage without changing providers; Enter uses the selection and makes it the default. */
export class AccountsPanel implements Component, Focusable {
	focused = true;
	readonly capturesViewportInput = true;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: AccountPanelResult) => void;
	private readonly options: AccountPanelOptions;
	private readonly rows: PanelRow[];
	private selectedIndex: number;
	private readonly mutableEntries: ReadonlyMap<string, AccountPanelEntry>;
	private readonly markedIds: Set<string>;
	private toolbarFocused = false;
	private toolbarIndex = 0;
	private toolbarStart = 0;
	private renderedToolbar: HitLine<ToolbarAction | number>[] = [];
	private listStart = 0;
	private hoveredId: string | undefined;
	private readonly renderedRows = new Map<number, number>();
	private renderedSelection = 0;
	private listWidth = 0;
	private detailsX = 0;
	private detailsStart = 0;
	private controlsStart = 0;
	private renderedControls: HitLine<PanelAction>[] = [];
	private detailOffset = 0;
	private detailPageSize = 1;
	private detailMaxOffset = 0;
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
			...options.entries
				.map((entry) => ({ id: entry.id, label: entry.name, entry }))
				.sort((a, b) => Number(a.entry.pool) - Number(b.entry.pool)),
			{ id: "+add", label: "+ Add account" },
			{ id: "+restart", label: "Restart broker (reload config.yaml)" },
		];
		this.mutableEntries = new Map(
			options.entries
				.filter((entry) => entry.account && !entry.pool && !entry.readOnly)
				.map((entry) => [entry.id, entry]),
		);
		this.markedIds = new Set(options.markedIds?.filter((id) => this.mutableEntries.has(id)));
		const selectedIndex = this.rows.findIndex((row) => row.id === options.selectedId);
		const currentIndex = this.rows.findIndex((row) => row.id === options.currentId);
		this.selectedIndex = selectedIndex >= 0 ? selectedIndex : Math.max(0, currentIndex);
		this.loadUsage();
	}

	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows - 2);
		const split = width >= SPLIT_MIN_WIDTH;
		const minBodyRows = split ? 1 : 2;
		this.listWidth = split ? Math.min(48, Math.floor(width * 0.42)) : width;
		this.detailsX = split ? this.listWidth + DIVIDER.length : 0;
		const detailWidth = Math.max(1, width - this.detailsX);
		this.renderedSelection = this.selectedIndex;
		this.renderedControls = this.renderControls(width, Math.min(height - minBodyRows, Math.floor(height / 2)));
		this.controlsStart = height - this.renderedControls.length;
		const titleRows = this.controlsStart > minBodyRows + 1 ? 1 : 0;
		const bodyRows = this.controlsStart - titleRows;
		this.toolbarStart = titleRows;
		const toolbarRoom = bodyRows > minBodyRows ? Math.min(3, bodyRows - minBodyRows) : Number(this.toolbarFocused);
		this.renderedToolbar = this.renderToolbar(this.listWidth, toolbarRoom);
		const listStart = titleRows + this.renderedToolbar.length;
		const listRoom = this.controlsStart - listStart;
		const listSize = Math.min(
			this.rows.length,
			split || listRoom < 2 ? listRoom : Math.max(1, Math.floor(listRoom / 3)),
		);
		const list = this.renderList(listSize, listStart);
		const left = [...this.renderedToolbar.map((line) => line.text), ...list];
		this.detailsStart = split ? titleRows : listStart + listSize;
		const details = this.details(detailWidth).flatMap((line) => wrapTextWithAnsi(line, detailWidth));
		this.detailPageSize = this.controlsStart - this.detailsStart;
		this.detailMaxOffset = Math.max(0, details.length - Math.max(1, this.detailPageSize));
		this.scrollDetails(0);
		const page = details.slice(this.detailOffset, this.detailOffset + this.detailPageSize);
		const detailRange = this.detailMaxOffset
			? ` ${this.detailOffset + 1}–${this.detailOffset + page.length}/${details.length}`
			: "";
		const title = this.theme.bold("Accounts") + this.theme.fg("muted", ` · ${this.markedIds.size} marked`);
		const lines: string[] = [];
		if (split) {
			const divider = this.theme.fg("borderMuted", DIVIDER);
			if (titleRows) {
				const heading = truncateToWidth(title, this.listWidth, "…", true);
				lines.push(`${heading}${divider}${this.theme.bold(`Details${detailRange}`)}`);
			}
			const blank = " ".repeat(this.listWidth);
			for (let y = 0; y < bodyRows; y++) lines.push(`${left[y] ?? blank}${divider}${page[y] ?? ""}`);
		} else {
			if (titleRows) lines.push(title + (detailRange ? this.theme.fg("muted", ` · Details${detailRange}`) : ""));
			lines.push(...left, ...page);
			while (this.renderedControls.length && lines.length < this.controlsStart) lines.push("");
		}
		lines.push(...this.renderedControls.map((line) => this.theme.fg("muted", line.text)));
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const matches = (key: Keybinding) => this.keybindings.matches(data, key);
		if (matches("tui.select.cancel")) this.runAction("cancel");
		else if (matches("app.accounts.toolbar")) this.runAction("toolbar");
		else if (this.toolbarFocused && matches("tui.select.confirm"))
			this.runToolbarAction(TOOLBAR[this.toolbarIndex].action);
		else if (this.toolbarFocused && (matches("tui.select.up") || matches("tui.editor.cursorLeft"))) {
			this.toolbarIndex = (this.toolbarIndex + TOOLBAR.length - 1) % TOOLBAR.length;
		} else if (this.toolbarFocused && (matches("tui.select.down") || matches("tui.editor.cursorRight"))) {
			this.toolbarIndex = (this.toolbarIndex + 1) % TOOLBAR.length;
		} else if (matches("tui.select.up")) this.select(this.selectedIndex - 1);
		else if (matches("tui.select.down")) this.select(this.selectedIndex + 1);
		else if (matches("tui.select.pageUp")) this.scrollDetails(-Math.max(1, this.detailPageSize));
		else if (matches("tui.select.pageDown")) this.scrollDetails(Math.max(1, this.detailPageSize));
		else {
			const control = this.controls().find((control) => control.action && control.keys.some(matches));
			if (!control?.action) return;
			this.runAction(control.action);
		}
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		const index = event.x < this.listWidth ? this.renderedRows.get(event.y) : undefined;
		if (event.type === "leave" || event.type === "move") {
			const hoveredId = event.type === "move" && index !== undefined ? this.rows[index].id : undefined;
			const changed = hoveredId !== this.hoveredId;
			this.hoveredId = hoveredId;
			return hoveredId || changed ? { handled: true, render: changed } : undefined;
		}
		if (event.type === "wheel" && event.wheelDelta) {
			if (index !== undefined) this.select(this.selectedIndex + Math.sign(event.wheelDelta));
			else if (event.x >= this.detailsX && event.y >= this.detailsStart && event.y < this.controlsStart) {
				this.scrollDetails(event.wheelDelta);
			} else return undefined;
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (index !== undefined) {
			const row = this.rows[index];
			if (this.listWidth >= 5 && event.x >= 2 && event.x < 5 && this.mutableEntries.has(row.id)) {
				this.toggleMark(row.id);
			} else {
				this.toolbarFocused = false;
				this.select(index);
			}
			return { handled: true };
		}
		// A key or wheel event may have changed the selection before its actions were redrawn.
		if (this.selectedIndex !== this.renderedSelection) return undefined;
		const underPointer = (hit: { x: number; end: number }) => event.x >= hit.x && event.x < hit.end;
		const toolbarHit = this.renderedToolbar[event.y - this.toolbarStart]?.hits.find(underPointer);
		if (toolbarHit) {
			if (typeof toolbarHit.action === "number") this.toolbarIndex = toolbarHit.action;
			else this.runToolbarAction(toolbarHit.action);
			return { handled: true };
		}
		const hit = this.renderedControls[event.y - this.controlsStart]?.hits.find(underPointer);
		if (!hit) return undefined;
		this.runAction(hit.action);
		return { handled: true };
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		this.request?.abort();
	}

	private renderList(size: number, y: number): string[] {
		const start = Math.max(0, this.selectedIndex - size + 1, Math.min(this.listStart, this.selectedIndex));
		this.listStart = Math.min(start, this.rows.length - size);
		this.renderedRows.clear();
		return this.rows.slice(this.listStart, this.listStart + size).map((row, offset) => {
			const index = this.listStart + offset;
			this.renderedRows.set(y + offset, index);
			const selected = index === this.selectedIndex;
			const pool = row.entry?.pool;
			const box = this.mutableEntries.has(row.id) ? `[${this.markedIds.has(row.id) ? "x" : " "}] ` : "";
			const label = `${selected ? "›" : " "} ${box}${pool ? "Pool: " : ""}${stripVTControlCharacters(row.label)}`;
			const status = row.id === this.options.currentId ? " ●" : "";
			const mark = row.id === this.options.defaultId ? `${status} ◆` : status;
			const badge = this.listWidth > mark.length + 3 ? mark : "";
			const text = truncateToWidth(label, this.listWidth - badge.length, "…", true) + badge;
			if (selected) return `\x1b[7m${text}\x1b[27m`;
			if (row.id === this.hoveredId) return this.theme.fg("accent", text);
			return pool ? this.theme.fg("muted", text) : text;
		});
	}

	private renderToolbar(width: number, maxRows: number): HitLine<ToolbarAction | number>[] {
		if (maxRows < 1 || width < 1) return [];
		const inset = Number(width >= 8);
		const contentWidth = width - 2 * inset;
		const lines: (HitLine<ToolbarAction | number> & { first: number })[] = [];
		let focusLine = 0;
		for (const [index, { label, action }] of TOOLBAR.entries()) {
			const count = action === "clear" && this.markedIds.size ? ` (${this.markedIds.size})` : "";
			const tab = truncateToWidth(`[${label}${count}]`, contentWidth, "…");
			let line = lines.at(-1);
			if (!line || visibleWidth(line.text) + 1 + visibleWidth(tab) > contentWidth) {
				line = { text: "", hits: [], first: index };
				lines.push(line);
			}
			if (line.text) line.text += " ";
			const x = inset + visibleWidth(line.text);
			const enabled = this.toolbarEnabled(action);
			if (enabled) line.hits.push({ x, end: x + visibleWidth(tab), action });
			const focused = index === this.toolbarIndex;
			if (focused) focusLine = lines.length - 1;
			const text = this.theme.fg(enabled ? "accent" : "dim", tab);
			line.text += focused && this.toolbarFocused ? `\x1b[7m${text}\x1b[27m` : text;
		}

		// Keep the focused action visible even if the terminal only has room for one tab.
		const start = Math.min(Math.floor(focusLine / maxRows) * maxRows, Math.max(0, lines.length - maxRows));
		const previous = lines[start - 1];
		const next = lines[start + maxRows];
		return lines.slice(start, start + maxRows).map(({ text, hits }, row) => {
			const left = inset && row === 0 && previous;
			const right = inset && row === maxRows - 1 && next;
			if (left) hits.push({ x: 0, end: 1, action: left.first });
			if (right) hits.push({ x: width - 1, end: width, action: right.first });
			const before = inset ? (left ? "‹" : " ") : "";
			const after = inset ? (right ? "›" : " ") : "";
			return { text: before + truncateToWidth(text, contentWidth, "…", true) + after, hits };
		});
	}

	private toolbarEnabled(action: ToolbarAction): boolean {
		if (action === "add") return true;
		if (action === "selectAll") return this.markedIds.size < this.mutableEntries.size;
		if (action === "clear") return this.markedIds.size > 0;
		const selected = this.mutableEntries.get(this.rows[this.selectedIndex].id);
		if (action === "remove") return this.markedIds.size > 0 || selected !== undefined;
		const needsDisabled = action === "enable";
		if (!this.markedIds.size) return selected?.disabled === needsDisabled;
		for (const id of this.markedIds) {
			if (this.mutableEntries.get(id)?.disabled === needsDisabled) return true;
		}
		return false;
	}

	private runToolbarAction(action: ToolbarAction): void {
		if (!this.toolbarEnabled(action)) return;
		if (action === "add") this.runAction("add");
		else if (action === "selectAll") for (const id of this.mutableEntries.keys()) this.markedIds.add(id);
		else if (action === "clear") this.markedIds.clear();
		else {
			const selectedId = this.rows[this.selectedIndex].id;
			if (action === "remove" && !this.markedIds.size) this.finish({ action, selectedId });
			else {
				this.finish({
					action: "bulk",
					operation: action,
					selectedIds: this.markedIds.size ? [...this.markedIds] : [selectedId],
					selectedId,
				});
			}
		}
	}

	private toggleMark(id: string): void {
		if (!this.mutableEntries.has(id)) return;
		if (!this.markedIds.delete(id)) this.markedIds.add(id);
	}

	private renderControls(width: number, maxRows: number): HitLine<PanelAction>[] {
		if (maxRows < 1 || width < 1) return [];
		const lines: HitLine<PanelAction>[] = [];
		for (const { keys, label, action } of this.controls()) {
			const key = keys.flatMap((key) => this.keybindings.getKeys(key).slice(0, 1)).join("/");
			if (!key && !action) continue;
			const text = truncateToWidth(key ? `${key} ${label}` : label, width, "…");
			const separator = " · ";
			let line = lines.at(-1);
			if (!line || visibleWidth(line.text + separator + text) > width) {
				if (lines.length >= maxRows) break;
				line = { text: "", hits: [] };
				lines.push(line);
			}
			if (line.text) line.text += separator;
			if (action) line.hits.push({ x: visibleWidth(line.text), end: visibleWidth(line.text + text), action });
			line.text += text;
		}
		return lines;
	}

	private controls(): Control[] {
		const row = this.rows[this.selectedIndex];
		const controls: Control[] = [
			{
				keys: ["app.accounts.toolbar"],
				label: this.toolbarFocused ? "Back to list" : "Actions",
				action: "toolbar",
			},
		];
		if (this.toolbarFocused) {
			controls.push(
				{ keys: ["tui.editor.cursorLeft", "tui.editor.cursorRight"], label: "Choose action" },
				{ keys: ["tui.select.confirm"], label: "Run action" },
			);
		} else if (row.id === "+restart") {
			controls.push({ keys: ["tui.select.confirm"], label: "Restart broker", action: "restart" });
		} else if (row.entry && !row.entry.disabled) {
			controls.push({ keys: ["tui.select.confirm"], label: "Use + make default", action: "use" });
		}
		if (!this.toolbarFocused && this.mutableEntries.has(row.id)) {
			controls.push({
				keys: ["app.accounts.mark"],
				label: this.markedIds.has(row.id) ? "Unmark" : "Mark",
				action: "mark",
			});
		}
		controls.push({
			keys:
				row.id === "+add" && !this.toolbarFocused
					? ["tui.select.confirm", "app.accounts.add"]
					: ["app.accounts.add"],
			label: "Add account",
			action: "add",
		});
		if (this.toolbarEnabled("remove")) {
			controls.push({
				keys: ["app.accounts.remove"],
				label: this.markedIds.size ? `Delete marked (${this.markedIds.size})` : "Delete account",
				action: "remove",
			});
		}
		if (row.entry && !row.entry.disabled) {
			controls.push({ keys: ["app.accounts.model"], label: "Choose model + default", action: "model" });
		}
		if (row.entry?.account) {
			controls.push(
				{ keys: ["app.accounts.manage"], label: "Manage", action: "manage" },
				{ keys: ["app.accounts.refresh"], label: "Refresh usage", action: "refresh" },
			);
		}
		if (!this.toolbarFocused) controls.push({ keys: ["tui.select.up", "tui.select.down"], label: "Browse" });
		controls.push(
			{ keys: ["tui.select.pageUp", "tui.select.pageDown"], label: "Scroll details" },
			{ keys: ["tui.select.cancel"], label: "Close", action: "cancel" },
		);
		return controls;
	}

	private select(index: number): void {
		index = Math.max(0, Math.min(index, this.rows.length - 1));
		if (index === this.selectedIndex) return;
		this.selectedIndex = index;
		this.detailOffset = 0;
		this.loadUsage();
	}

	private scrollDetails(delta: number): void {
		this.detailOffset = Math.max(0, Math.min(this.detailMaxOffset, this.detailOffset + delta));
	}

	private runAction(action: PanelAction): void {
		const selectedId = this.rows[this.selectedIndex].id;
		if (action === "toolbar") this.toolbarFocused = !this.toolbarFocused;
		else if (action === "mark") this.toggleMark(selectedId);
		else if (action === "remove") this.runToolbarAction(action);
		else if (action === "refresh") {
			this.detailOffset = 0;
			this.loadUsage();
		} else this.finish({ action, selectedId });
	}

	private finish(result: AccountPanelResult): void {
		this.dispose();
		this.done(result);
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
		const lines = [theme.bold(entry.name), theme.fg("muted", `${entry.pool ? "Pool" : "Account"} · ${entry.state}`)];
		const status = [
			entry.id === this.options.currentId ? "● In use in this session" : "",
			entry.id === this.options.defaultId ? "◆ Default for new sessions" : "",
		].filter(Boolean);
		if (status.length) lines.push(theme.fg("accent", status.join(" · ")));
		lines.push(theme.fg("dim", `ID: ${entry.id}`));
		if (entry.readOnly) lines.push(theme.fg("muted", "Configured in config.yaml; edit that file to remove it."));
		if (entry.pool) {
			lines.push(
				"",
				theme.fg("muted", "Pools route across accounts. Select an individual account to see its usage."),
			);
		} else if (!entry.account) {
			lines.push("", theme.fg("muted", "Usage and management are unavailable for this cached account."));
		} else if (!this.usage) lines.push("", theme.fg("muted", "Loading provider subscription usage…"));
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
		if (!entry.pool) {
			lines.push(...this.costLines(entry.costs.account, entry.costs.accountResponses, "Selected pinned account"));
		}
		if (entry.pool || entry.costs.poolResponses) {
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
		const barWidth = Math.max(0, Math.min(QUOTA_BAR_WIDTH, width - label.length - 1));
		const filled = barWidth && percent > 0 ? Math.max(1, Math.round((percent / 100) * barWidth)) : 0;
		const bar =
			this.theme.fg("accent", "█".repeat(filled)) + this.theme.fg("borderMuted", "█".repeat(barWidth - filled));
		return [
			this.theme.bold(window.label),
			`${barWidth ? `${bar} ` : ""}${percent >= 100 ? this.theme.fg("error", label) : label}`,
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
