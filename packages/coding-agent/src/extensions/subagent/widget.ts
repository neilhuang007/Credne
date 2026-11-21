import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	type Focusable,
	getKeybindings,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { ActivitySpinner, renderActivityRow } from "../../modes/interactive/components/activity-row.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { cacheHitRate } from "./runner.ts";
import type { WorkerTeam, WorkerView } from "./team.ts";
import { renderWorkerName } from "./worker-color.ts";

const MAX_COLLAPSED_ROWS = 3;

/** Most rows the widget below the input box may take, scaled to the terminal height. */
function maxWidgetRows(terminalRows: number): number {
	return Math.max(3, Math.min(10, Math.floor(terminalRows / 4)));
}

/** Whether the collapsed widget below the input box cannot show every worker and ends in a hidden count. */
export function hasHiddenWorkers(workerCount: number, terminalRows: number): boolean {
	return workerCount > Math.min(MAX_COLLAPSED_ROWS, maxWidgetRows(terminalRows) - 1);
}

export function formatWorkerStats(worker: WorkerView): string {
	const { usage } = worker;
	const parts = [worker.status === "completed" ? "idle" : worker.status];
	if (worker.model) parts.push(worker.model.slice(worker.model.lastIndexOf("/") + 1));
	parts.push(worker.agentType);
	if (usage.input + usage.cacheRead + usage.cacheWrite > 0) {
		parts.push(`cache ${(cacheHitRate(usage) * 100).toFixed(1)}%`);
	}
	if (worker.reasoningEffort) parts.push(worker.reasoningEffort);
	if (worker.elapsedMs > 0) {
		const seconds = Math.floor(worker.elapsedMs / 1000);
		parts.push(seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);
	}
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑ ${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓ ${formatTokens(usage.output)}`);
	if (usage.firstCacheHitRate !== undefined) parts.push(`first ${(usage.firstCacheHitRate * 100).toFixed(1)}%`);
	if (usage.cacheRead) parts.push(`R ${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W ${formatTokens(usage.cacheWrite)}`);
	if (usage.contextTokens) parts.push(`ctx ${formatTokens(usage.contextTokens)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (worker.inboxCount) parts.push(`${worker.inboxCount} message${worker.inboxCount === 1 ? "" : "s"}`);
	if (worker.assignmentCount) parts.push(`${worker.assignmentCount} queued`);
	return parts.join(" • ");
}

export function renderWorkerRow(
	worker: WorkerView,
	width: number,
	theme: Theme,
	spinner: string,
	iconOverride?: string,
): string {
	const color = worker.status === "failed" ? "error" : worker.status === "running" ? "accent" : "muted";
	const icon =
		iconOverride ?? (worker.status === "running" ? spinner : theme.fg(color, worker.status === "failed" ? "×" : "◯"));
	const left = `${icon} ${renderWorkerName(worker, theme)}  ${theme.fg("muted", worker.task.replace(/\s+/g, " ").trim())}`;
	return renderActivityRow(width, left, theme.fg(color, formatWorkerStats(worker)));
}

/** Renders a selected row as plain text on an inverted, full-width background. */
export function highlightRow(line: string, width: number): string {
	const plain = stripVTControlCharacters(line);
	return `\x1b[7m${plain}${" ".repeat(Math.max(0, width - visibleWidth(plain)))}\x1b[27m`;
}

/** A spinner that animates only while some worker is running. */
export class WorkerSpinner {
	private readonly spinner: ActivitySpinner;
	private isRunning = false;

	constructor(tui: TUI, theme: Theme) {
		this.spinner = new ActivitySpinner(
			tui,
			(text) => theme.fg("accent", text),
			(text) => text,
			"",
		);
		this.spinner.stop();
	}

	/** Starts or stops the animation to match whether any of the workers is running. */
	sync(workers: readonly WorkerView[]): void {
		const isRunning = workers.some((worker) => worker.status === "running");
		if (isRunning === this.isRunning) return;
		this.isRunning = isRunning;
		if (isRunning) this.spinner.start();
		else this.spinner.stop();
	}

	frame(): string {
		return this.spinner.render(1)[0];
	}

	invalidate(): void {
		this.spinner.invalidate();
	}

	dispose(): void {
		this.spinner.stop();
	}
}

/** Creates the spinner on first use, so the widget and the Agents section animate from one timer. */
export function sharedWorkerSpinner(): (tui: TUI, theme: Theme) => WorkerSpinner {
	let spinner: WorkerSpinner | undefined;
	return (tui, theme) => {
		spinner ??= new WorkerSpinner(tui, theme);
		return spinner;
	};
}

export class SubagentWidget implements Component, Focusable {
	private readonly team: Pick<WorkerTeam, "getViews" | "subscribe">;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly spinner: WorkerSpinner;
	private readonly unsubscribe: () => void;
	focused = false;
	private selectedId = "main";
	private rowWorkerIds: string[] = [];
	private hoveredId: string | undefined;
	private returnToEditor: ((data?: string) => void) | undefined;
	/** Shows a worker in the main view, or the main session for undefined. */
	private readonly openSession: (workerId: string | undefined) => void;

	/** The widget keeps the spinner in step with the team and stops it when disposed. */
	constructor(
		team: Pick<WorkerTeam, "getViews" | "subscribe">,
		tui: TUI,
		theme: Theme,
		openSession: (workerId: string | undefined) => void,
		spinner: WorkerSpinner,
	) {
		this.team = team;
		this.tui = tui;
		this.theme = theme;
		this.openSession = openSession;
		this.spinner = spinner;
		const update = () => {
			const workers = team.getViews();
			if (this.focused && !workers.length) this.leave();
			if (this.selectedId !== "main" && !workers.some((worker) => worker.id === this.selectedId)) {
				this.selectedId = "main";
			}
			this.spinner.sync(workers);
			tui.requestRender();
		};
		this.unsubscribe = team.subscribe(update);
		update();
	}

	render(width: number): string[] {
		const workers = this.team.getViews();
		this.rowWorkerIds = [];
		if (!workers.length) return [];
		const hint = this.focused
			? `${keyHint("tui.select.up", "")}/${keyHint("tui.select.down", "navigate")} • ${keyHint("tui.select.confirm", "open")} • ${keyHint("tui.select.cancel", "collapse")}`
			: keyHint("app.subagents.select", "agents");
		const selectionIcon = this.theme.fg("accent", "›");
		const mainIcon = this.focused && this.selectedId === "main" ? selectionIcon : "●";
		const mainRow = renderActivityRow(width, `${mainIcon} ${this.theme.bold("main")}`, hint);
		const lines = [
			(this.focused && this.selectedId === "main") || this.hoveredId === "main"
				? highlightRow(mainRow, width)
				: mainRow,
		];
		const spinner = this.spinner.frame();
		const maxRows = maxWidgetRows(this.tui.terminal.rows);
		if (this.focused) {
			const visibleRows = maxRows - 1 - Number(workers.length > maxRows - 1);
			const selectedIndex = workers.findIndex((worker) => worker.id === this.selectedId);
			const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleRows / 2), workers.length - visibleRows));
			const visible = workers.slice(start, start + visibleRows);
			this.rowWorkerIds = visible.map((worker) => worker.id);
			for (const worker of visible) {
				const selected = worker.id === this.selectedId;
				const row = renderWorkerRow(worker, width, this.theme, spinner, selected ? selectionIcon : undefined);
				lines.push(selected || worker.id === this.hoveredId ? highlightRow(row, width) : row);
			}
			if (visible.length < workers.length) {
				lines.push(
					truncateToWidth(
						this.theme.fg("muted", `◯ ${start + 1}–${start + visible.length} of ${workers.length} agents`),
						width,
					),
				);
			}
			return lines;
		}
		const idle = workers.filter((worker) => worker.status === "completed");
		const active = workers
			.filter((worker) => worker.status !== "completed")
			.sort((left, right) => Number(right.status === "running") - Number(left.status === "running"));
		const needsSummary = hasHiddenWorkers(workers.length, this.tui.terminal.rows);
		const visibleRows = Math.min(MAX_COLLAPSED_ROWS, maxRows - 1 - Number(needsSummary));
		const displayed = new Set([...active, ...idle].slice(0, visibleRows).map((worker) => worker.id));
		const shown = workers.filter((worker) => displayed.has(worker.id));
		this.rowWorkerIds = shown.map((worker) => worker.id);
		for (const worker of shown) {
			const row = renderWorkerRow(worker, width, this.theme, spinner);
			lines.push(worker.id === this.hoveredId ? highlightRow(row, width) : row);
		}
		const hidden = workers.length - displayed.size;
		if (hidden) {
			const activationKey = keyText("app.subagents.select");
			const action = activationKey ? `Press ${activationKey}` : "Run /subagents";
			const summary = truncateToWidth(this.theme.fg("muted", `${action} for more (${hidden} hidden)`), width);
			lines.push(" ".repeat(Math.max(0, Math.floor((width - visibleWidth(summary)) / 2))) + summary);
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const workerId = event.y === 0 && this.rowWorkerIds.length > 0 ? "main" : this.rowWorkerIds[event.y - 1];
		if (event.type === "leave" || event.type === "move") {
			const hoveredId = event.type === "move" ? workerId : undefined;
			const changed = hoveredId !== this.hoveredId;
			this.hoveredId = hoveredId;
			return hoveredId || changed ? { handled: true, render: changed } : undefined;
		}
		if (event.type === "press" && event.button === "left" && workerId) return { handled: true, render: false };
		if (event.type !== "click" || event.button !== "left" || !workerId) return undefined;
		if (this.focused) this.leave();
		this.openSession(workerId === "main" ? undefined : workerId);
		return { handled: true };
	}

	activate(returnToEditor: (data?: string) => void): void {
		if (!this.team.getViews().length) return;
		this.returnToEditor = returnToEditor;
		this.selectedId = "main";
		this.tui.setFocus(this);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (!this.focused) return;
		const keybindings = getKeybindings();
		const workers = this.team.getViews();
		const selectedIndex = workers.findIndex((worker) => worker.id === this.selectedId) + 1;
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.leave();
		} else if (keybindings.matches(data, "tui.select.up")) {
			if (selectedIndex === 0) this.leave();
			else this.selectedId = workers[selectedIndex - 2]?.id ?? "main";
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.selectedId = workers[Math.min(selectedIndex, workers.length - 1)]?.id ?? "main";
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			const workerId = this.selectedId;
			this.leave();
			this.openSession(workerId === "main" ? undefined : workerId);
		} else {
			this.leave(data);
		}
		this.tui.requestRender();
	}

	invalidate(): void {
		this.spinner.invalidate();
	}

	dispose(): void {
		if (this.focused) this.leave();
		this.returnToEditor = undefined;
		this.unsubscribe();
		this.spinner.dispose();
	}

	private leave(data?: string): void {
		const returnToEditor = this.returnToEditor;
		this.returnToEditor = undefined;
		this.selectedId = "main";
		returnToEditor?.(data);
	}
}

/**
 * Every worker in the sidebar's Agents viewport. The widget's subscription requests renders
 * and the widget's spinner supplies the frames.
 */
export class SubagentSection implements Component {
	readonly stickyHeader = true;
	private readonly team: Pick<WorkerTeam, "count" | "getViews">;
	private readonly theme: Theme;
	private readonly spinner: WorkerSpinner;
	private readonly openSession: ((workerId: string) => void) | undefined;
	private rowWorkerIds: string[] = [];
	private hoveredId: string | undefined;

	constructor(
		team: Pick<WorkerTeam, "count" | "getViews">,
		_tui: TUI,
		theme: Theme,
		spinner: WorkerSpinner,
		openSession?: (workerId: string) => void,
	) {
		this.team = team;
		this.theme = theme;
		this.spinner = spinner;
		this.openSession = openSession;
	}

	render(width: number): string[] {
		this.rowWorkerIds = [];
		if (!this.team.count()) return [];
		const workers = this.team.getViews();
		this.rowWorkerIds = workers.map((worker) => worker.id);
		const frame = this.spinner.frame();
		return [
			renderActivityRow(width, this.theme.bold("Agents"), this.theme.fg("muted", `${workers.length} total`)),
			...workers.map((worker) => {
				const row = renderWorkerRow(worker, width, this.theme, frame);
				return worker.id === this.hoveredId ? highlightRow(row, width) : row;
			}),
		];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const workerId = this.rowWorkerIds[event.y - 1];
		if (event.type === "leave" || event.type === "move") {
			const hoveredId = event.type === "move" ? workerId : undefined;
			const changed = hoveredId !== this.hoveredId;
			this.hoveredId = hoveredId;
			return hoveredId || changed ? { handled: true, render: changed } : undefined;
		}
		if (event.type === "press" && event.button === "left" && workerId) return { handled: true, render: false };
		if (event.type !== "click" || event.button !== "left" || !workerId) return undefined;
		this.openSession?.(workerId);
		return { handled: true };
	}

	invalidate(): void {}
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1000000) return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}
