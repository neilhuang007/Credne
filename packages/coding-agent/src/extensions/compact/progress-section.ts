// Shows a running blocks compaction: a line in place of the working indicator with the segmented bar, the percentage of
// the whole compaction and the step, and a section in the side panel with a heading and the same three.
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderActivityRow } from "../../modes/interactive/components/activity-row.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ProgressSegment, ProgressView } from "./progress.ts";

// The fewest cells the bar keeps while the line has them; the hint, then the end of the label give way first.
const MIN_BAR_WIDTH = 20;

/**
 * The line in place of the working indicator, in `width` columns: `spinner`, the segmented bar, the percentage of the
 * whole compaction, the step with its count such as `[3/12]`, then the key that cancels the compaction. The bar takes up
 * to 50 cells; when it would get fewer than 20, the hint is left out, then the end of the label is cut, and the bar,
 * the percentage and the count stay.
 */
export function renderStatusLine(view: ProgressView, width: number, spinner: string, theme: Theme): string {
	const head = spinner ? `${spinner} ` : "";
	const percent = theme.fg("muted", ` ${progressPercent(view)}`);
	const label = theme.fg("muted", ` ${view.label}`);
	const count = view.count ? theme.fg("muted", ` ${countText(view.count)}`) : "";
	const hint = `  ${cancelHint()}`;
	const fixed = visibleWidth(head) + visibleWidth(percent) + visibleWidth(count);
	const room = width - fixed - visibleWidth(label);
	if (room - visibleWidth(hint) >= MIN_BAR_WIDTH) {
		return `${head}${renderSegmentedBar(view, room - visibleWidth(hint), theme)}${percent}${label}${count}${hint}`;
	}
	if (room >= MIN_BAR_WIDTH) return `${head}${renderSegmentedBar(view, room, theme)}${percent}${label}${count}`;
	const cells = Math.max(0, Math.min(MIN_BAR_WIDTH, width - fixed));
	const labelWidth = width - fixed - cells;
	// A space and a cut-off mark leave no room for a letter below three columns.
	const shortLabel = labelWidth >= 3 ? truncateToWidth(label, labelWidth, "…") : "";
	return `${head}${renderSegmentedBar(view, cells, theme)}${percent}${shortLabel}${count}`;
}

/**
 * One snapshot of the progress. It has no timer or subscription: the extension replaces the section on every change,
 * as the planning section is replaced with every plan.
 */
export class CompactionSection implements Component {
	readonly stickyHeader = true;
	private readonly view: ProgressView;
	private readonly theme: Theme;

	constructor(view: ProgressView, theme: Theme) {
		this.view = view;
		this.theme = theme;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const view = this.view;
		const percent = progressPercent(view);
		const step = view.count ? `${view.label} ${countText(view.count)}` : view.label;
		return [
			renderActivityRow(width, theme.bold("Compacting"), cancelHint()),
			truncateToWidth(`${renderSegmentedBar(view, width - percent.length - 1, theme)} ${percent}`, width),
			truncateToWidth(theme.fg("muted", step), width),
		];
	}

	invalidate(): void {}
}

/**
 * The share of the whole compaction done as a whole-number percentage, such as `43%`, from the same weights that draw
 * the bar, so the number and the bar's solid cells agree.
 */
function progressPercent(view: ProgressView): string {
	let total = 0;
	let done = 0;
	for (const segment of view.segments) {
		total += segment.weight;
		if (segment.state === "done") done += segment.weight;
		else if (segment.state === "current") done += segment.weight * stepShare(view.count);
	}
	return `${Math.floor((done / total) * 100)}%`;
}

/** The current step's share done: its finished requests of the total, or none for a step that does not count them. */
function stepShare(count: ProgressView["count"]): number {
	return count ? count.done / count.total : 0;
}

/** A step's count as finished of total requests, such as `[3/12]`. */
function countText(count: NonNullable<ProgressView["count"]>): string {
	return `[${count.done}/${count.total}]`;
}

/** The key that cancels the compaction, with what it does. */
function cancelHint(): string {
	// app.interrupt is the key the interactive mode binds to aborting a compaction.
	return keyHint("app.interrupt", "to cancel");
}

// As wide as the usage-limit bars of the accounts panel.
const BAR_WIDTH = 50;

/**
 * The bar for the whole compaction, 50 cells wide or `width` when that is less, in solid cells like the usage-limit
 * bars: one part per step in proportion to its weight, so its solid cells are the share of the whole compaction done.
 */
function renderSegmentedBar(view: ProgressView, width: number, theme: Theme): string {
	const cells = Math.max(0, Math.min(BAR_WIDTH, width));
	const totalWeight = view.segments.reduce((sum, segment) => sum + segment.weight, 0);
	let bar = "";
	let weightBefore = 0;
	let start = 0;
	// Each part ends where its share of the weight so far ends, so rounding never adds up past the bar's width.
	for (const segment of view.segments) {
		weightBefore += segment.weight;
		const end = Math.round((weightBefore / totalWeight) * cells);
		bar += renderSegment(segment, end - start, view.count, theme);
		start = end;
	}
	return bar;
}

/**
 * One step's part: accent when done, borderMuted when still to come, and yellow while running, solid for its finished
 * share and shaded for the rest, so the eye sees where the step begins and ends and how far it has come.
 */
function renderSegment(segment: ProgressSegment, cells: number, count: ProgressView["count"], theme: Theme): string {
	switch (segment.state) {
		case "done":
			return theme.fg("accent", "█".repeat(cells));
		case "pending":
			return theme.fg("borderMuted", "█".repeat(cells));
		case "current": {
			const filled = Math.round(stepShare(count) * cells);
			return theme.fg("warning", "█".repeat(filled) + "░".repeat(cells - filled));
		}
	}
}
