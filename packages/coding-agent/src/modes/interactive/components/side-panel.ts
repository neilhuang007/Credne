// The side panel's content: extension sections, a file index, and a scrollable sequence of per-file diffs.
import {
	type Component,
	sliceByColumn,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.ts";
import type { ThemeBg } from "../theme/theme-tokens.ts";
import type { ChangedFile, ChangesSnapshot, ChangesTotals, DiffCodeRow, DiffRow, FileDiff } from "./git-changes.ts";
import type { BaselineScope } from "./session-baseline.ts";

export interface SidePanelSection {
	key: string;
	/** Sections render top to bottom by ascending order. */
	order: number;
	component: Component & {
		/** Keep the first rendered row fixed when the section has room for more than one row. */
		readonly stickyHeader?: boolean;
	};
}

interface SectionViewport extends SidePanelSection {
	offset: number;
	start: number;
	rows: number;
	maxOffset: number;
}

/** A file's diff, loading until the controller delivers it. */
export type PanelDiff = { status: "loading" } | FileDiff;

export interface SidePanelOptions {
	/** Rows the panel fills, so its left border runs the full height. */
	getHeight: () => number;
	/** What closes the panel, shown in the header: the toggle key, or "/diff". */
	getCloseHint: () => string;
	resize?: (screenX: number, phase: "drag" | "release") => void;
}

const maxFileRows = 8;
/** The header row, and the blank rows above and below the file list. */
const framingRows = 3;
/** The "more above" and "more below" rows of an overflowing file list. */
const overflowRows = 2;
/** The file list gives up rows before the diff drops below this many. */
const minDiffRows = 4;
/** Longer lines are shown without syntax highlighting. */
const maxHighlightLength = 400;
const noLines: string[] = [];

interface DiffBlock {
	file: ChangedFile;
	diff: PanelDiff;
	start: number;
	length: number;
	gutterWidth: number;
	lines: Map<number, string>;
}

/**
 * Renders sections and git changes into a column that the interactive mode shows as an overlay.
 *
 * The TUI renders on every frame, so each part keeps its last result: sections are compared line by line,
 * the changes part is keyed by a revision that every change to its data bumps, and each diff row is
 * rendered once per width. A frame that changes none of them returns the previous array.
 */
export class SidePanel implements Component {
	private readonly options: SidePanelOptions;
	private sections: SectionViewport[] = [];
	private changes: ChangesSnapshot | undefined;
	private selectedIndex = 0;
	private fileOffset = 0;
	private diffBlocks: DiffBlock[] = [];
	private diffOffset = 0;
	private diffViewRows = 1;
	private diffRowCount = 0;
	private fileViewRows = 1;
	private fileRegionStart = 0;
	private fileRegionEnd = 0;
	private fileRowIndices = new Map<number, number>();
	private followSelection = true;
	private sectionRows = 0;
	private hoveredSection?: SectionViewport;
	private isResizing = false;
	/** Keep the hovered screen row, so scrolling the index highlights the file now under the pointer. */
	private hoveredFileRow: number | undefined;
	private isSeparatorHovered = false;
	/** Bumped by every change to what the changes part shows. */
	private revision = 0;
	private sectionCache: { width: number; raw: string[]; lines: string[] } | undefined;
	private changesCache:
		| { revision: number; width: number; rows: number; start: number; hint: string; lines: string[] }
		| undefined;
	private outputCache:
		| { sectionLines: string[]; changesLines: string[]; height: number; separatorActive: boolean; lines: string[] }
		| undefined;
	private diffRowCacheWidth = 0;

	constructor(options: SidePanelOptions) {
		this.options = options;
	}

	/** Replace the extension sections. They render above the changes, by ascending order. */
	setSections(sections: readonly SidePanelSection[]): void {
		const offsets = new Map(this.sections.map((section) => [section.key, section.offset]));
		this.sections = sections
			.map((section) => ({ ...section, offset: offsets.get(section.key) ?? 0, start: 0, rows: 0, maxOffset: 0 }))
			.sort((a, b) => a.order - b.order);
	}

	/** Show a new snapshot, keeping the selection on the same file when it is still changed. */
	setChanges(changes: ChangesSnapshot): void {
		const previousPath = this.getSelectedFile()?.path;
		const previousBlock = this.diffBlocks.find((block) => this.diffOffset < block.start + block.length);
		const previousOffset = previousBlock ? this.diffOffset - previousBlock.start : 0;
		this.changes = changes;
		const files = this.files();
		const sameIndex = files.findIndex((file) => file.path === previousPath);
		this.selectedIndex = sameIndex !== -1 ? sameIndex : Math.max(0, Math.min(this.selectedIndex, files.length - 1));
		const previousBlocks = new Map(this.diffBlocks.map((block) => [block.file.path, block]));
		this.diffBlocks = files.map((file) => {
			const previous = previousBlocks.get(file.path);
			previous?.lines.delete(1);
			return previous
				? { ...previous, file }
				: {
						file,
						diff: { status: "loading" },
						start: 0,
						length: 5,
						gutterWidth: 1,
						lines: new Map<number, string>(),
					};
		});
		this.updateDiffPositions();
		const anchor = this.diffBlocks.find((block) => block.file.path === previousBlock?.file.path);
		if (anchor) this.diffOffset = anchor.start + Math.min(previousOffset, anchor.length - 1);
		else this.jumpToSelectedFile();
		this.followSelection = true;
		this.revision++;
	}

	/** Replace a file's diff without moving the visible file when earlier sections grow. */
	setDiff(path: string, diff: PanelDiff): void {
		const block = this.diffBlocks.find((candidate) => candidate.file.path === path);
		if (!block) return;
		const anchor = this.diffBlocks.find((candidate) => this.diffOffset < candidate.start + candidate.length);
		const anchorOffset = anchor ? this.diffOffset - anchor.start : 0;
		block.diff = diff;
		block.lines.clear();
		block.gutterWidth = diff.status === "ready" ? gutterWidthFor(diff.rows) : 1;
		block.length = 4 + (diff.status === "ready" ? Math.max(1, diff.rows.length) : 1);
		this.updateDiffPositions();
		if (anchor) this.diffOffset = anchor.start + Math.min(anchorOffset, anchor.length - 1);
		this.revision++;
	}

	getSelectedFile(): ChangedFile | undefined {
		return this.files()[this.selectedIndex];
	}

	/** Move the selection by `delta` files, without wrapping. Returns whether it moved. */
	selectFile(delta: number): boolean {
		const files = this.files();
		const next = Math.max(0, Math.min(this.selectedIndex + delta, files.length - 1));
		if (files.length === 0 || next === this.selectedIndex) return false;
		this.selectedIndex = next;
		this.jumpToSelectedFile();
		this.followSelection = true;
		this.revision++;
		return true;
	}

	/** Scroll the diff by `lines`; negative values scroll up. */
	scrollDiff(lines: number): void {
		const next = Math.max(0, Math.min(this.diffOffset + lines, this.maxDiffOffset()));
		if (next === this.diffOffset) return;
		this.diffOffset = next;
		const index = this.diffBlocks.findIndex((block) => next < block.start + block.length);
		if (index !== -1 && this.selectedIndex !== index) {
			this.selectedIndex = index;
			this.followSelection = true;
		}
		this.revision++;
	}

	/** Scroll the diff by a screenful: 1 down, -1 up. */
	scrollDiffPage(direction: 1 | -1): void {
		this.scrollDiff(direction * Math.max(1, this.diffViewRows - 1));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const section = this.sections.find(({ start, rows }) => event.y >= start && event.y < start + rows);
		const content = event.x >= 2 && event.x < event.width - 1 && event.type !== "leave" ? section : undefined;
		if (event.type === "move" || event.type === "leave") {
			let changed = this.updateHover(event);
			if (this.hoveredSection && this.hoveredSection.component !== content?.component) {
				const leave = this.sendSectionMouse(this.hoveredSection, { ...event, type: "leave" });
				changed ||= leave?.render === true;
			}
			const result = content && this.sendSectionMouse(content, event);
			this.hoveredSection = result?.handled ? content : undefined;
			changed ||= result?.render === true;
			return changed || result?.handled || this.hoveredFileRow !== undefined || this.isSeparatorHovered
				? { handled: true, render: changed }
				: undefined;
		}
		if (event.type === "press" && event.button === "left" && event.x === 0 && this.options.resize) {
			this.updateHover(event);
			this.isResizing = true;
			return { handled: true, capture: true, render: true };
		}
		if (this.isResizing && (event.type === "drag" || event.type === "release")) {
			this.options.resize?.(event.screenX, event.type);
			if (event.type === "release") {
				this.isResizing = false;
				this.updateHover(event);
			}
			return { handled: true, render: true };
		}
		if (content && event.type !== "wheel") {
			const result = this.sendSectionMouse(content, event);
			if (result) return result;
		}
		if (event.type === "press" && event.button === "left" && this.fileRowIndices.has(event.y)) {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left") {
			const index = this.fileRowIndices.get(event.y);
			if (index === undefined) return undefined;
			if (!this.selectFile(index - this.selectedIndex)) {
				this.jumpToSelectedFile();
				this.revision++;
			}
			return { handled: true };
		}
		if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
		if (event.y < this.sectionRows) {
			if (section) {
				section.offset = Math.max(0, Math.min(section.offset + event.wheelDelta, section.maxOffset));
				if (this.hoveredSection?.component === section.component && content) {
					this.sendSectionMouse(section, { ...event, type: "move" });
				}
			}
		} else if (event.y >= this.fileRegionStart && event.y < this.fileRegionEnd) {
			this.fileOffset = Math.max(
				0,
				Math.min(this.fileOffset + event.wheelDelta, this.files().length - this.fileViewRows),
			);
			this.followSelection = false;
			this.revision++;
		} else {
			this.scrollDiff(event.wheelDelta);
		}
		return { handled: true };
	}

	invalidate(): void {
		this.revision++;
		this.sectionCache = undefined;
		for (const block of this.diffBlocks) block.lines.clear();
		for (const section of this.sections) section.component.invalidate();
	}

	render(width: number): string[] {
		const height = Math.max(1, this.options.getHeight());
		const bodyWidth = Math.max(0, width - 1);
		const sectionLines = this.renderSections(bodyWidth, height);
		this.sectionRows = sectionLines.length;
		const changesLines = this.renderChanges(bodyWidth, height - this.sectionRows);
		const separatorActive = this.isSeparatorHovered || this.isResizing;
		const cached = this.outputCache;
		if (
			cached?.sectionLines === sectionLines &&
			cached.changesLines === changesLines &&
			cached.height === height &&
			cached.separatorActive === separatorActive
		) {
			return cached.lines;
		}
		const border = separatorActive ? theme.inverse(theme.fg("borderAccent", "┃")) : theme.fg("borderAccent", "│");
		const lines = [...sectionLines, ...changesLines].slice(0, height).map((line) => border + line);
		const blank = border + exactWidth("", bodyWidth);
		while (lines.length < height) lines.push(blank);
		this.outputCache = { sectionLines, changesLines, height, separatorActive, lines };
		return lines;
	}

	private sendSectionMouse(section: SectionViewport, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const row = event.y - section.start;
		const pinned = row === 0 && section.component.stickyHeader && section.rows > 1;
		return section.component.handleMouse?.({
			...event,
			x: event.x - 2,
			y: pinned ? 0 : row + section.offset,
			width: Math.max(1, event.width - 3),
			height: section.rows + section.maxOffset,
		});
	}

	private updateHover(event: TuiMouseEvent): boolean {
		const inside =
			event.type !== "leave" && event.x >= 0 && event.x < event.width && event.y >= 0 && event.y < event.height;
		const hoveredFileRow = inside && event.x > 0 && this.fileRowIndices.has(event.y) ? event.y : undefined;
		const separatorHovered = inside && event.x === 0 && this.options.resize !== undefined;
		const fileChanged = hoveredFileRow !== this.hoveredFileRow;
		const changed = fileChanged || separatorHovered !== this.isSeparatorHovered;
		this.hoveredFileRow = hoveredFileRow;
		this.isSeparatorHovered = separatorHovered;
		if (fileChanged) this.revision++;
		return changed;
	}

	private files(): readonly ChangedFile[] {
		return this.changes?.status === "ready" ? this.changes.files : [];
	}

	private updateDiffPositions(): void {
		let start = 0;
		for (const block of this.diffBlocks) {
			block.start = start;
			start += block.length;
		}
		this.diffRowCount = start;
	}

	private jumpToSelectedFile(): void {
		this.diffOffset = this.diffBlocks[this.selectedIndex]?.start ?? 0;
	}

	private maxDiffOffset(): number {
		const lastStart = this.diffBlocks.at(-1)?.start ?? 0;
		return Math.max(lastStart, this.diffRowCount - this.diffViewRows, 0);
	}

	/** Split the available rows among the nonempty sections without letting a long list hide the others. */
	private renderSections(bodyWidth: number, height: number): string[] {
		const blocks = this.sections.flatMap((section) => {
			section.rows = 0;
			const lines = section.component.render(Math.max(1, bodyWidth - 2));
			return lines.length > 0 ? [{ section, lines }] : [];
		});
		if (!blocks.length) return noLines;

		// Give sections roughly a third of the height, with two rows each on shorter screens if changes still fit.
		const sectionTarget = Math.max(Math.floor(height / 3), blocks.length * 2);
		const changesMin = Math.min(6, Math.max(height <= 3 ? 1 : 2, height - blocks.length * 2));
		let remaining = Math.min(sectionTarget, height - changesMin);
		for (let row = 0; remaining > 0; row++) {
			const before = remaining;
			for (const { section, lines } of blocks) {
				if (row >= lines.length) continue;
				section.rows++;
				if (--remaining === 0) break;
			}
			if (remaining === before) break;
		}

		const raw: string[] = [];
		for (const { section, lines } of blocks) {
			if (section.rows === 0) continue;
			section.start = raw.length;
			section.maxOffset = lines.length - section.rows;
			section.offset = Math.min(section.offset, section.maxOffset);
			// A one-row viewport still lets the user reach list items instead of pinning the header over them.
			const headerRows = section.component.stickyHeader && section.rows > 1 ? 1 : 0;
			if (headerRows) raw.push(lines[0]!);
			raw.push(...lines.slice(section.offset + headerRows, section.offset + section.rows));
			if (remaining > 0) {
				raw.push("");
				remaining--;
			}
		}
		if (raw.length === 0) return noLines;
		const cached = this.sectionCache;
		if (cached?.width === bodyWidth && sameLines(cached.raw, raw)) return cached.lines;
		const lines = raw.map((line) => padded(line, bodyWidth));
		this.sectionCache = { width: bodyWidth, raw, lines };
		return lines;
	}

	/** The changes part in `rows` rows, rebuilt only when its data, hover, width, height or hint changed. */
	private renderChanges(bodyWidth: number, rows: number): string[] {
		const hint = this.options.getCloseHint();
		const cached = this.changesCache;
		if (
			cached?.revision === this.revision &&
			cached.width === bodyWidth &&
			cached.rows === rows &&
			cached.start === this.sectionRows &&
			cached.hint === hint
		) {
			return cached.lines;
		}
		const lines = this.buildChanges(bodyWidth, rows, hint);
		this.changesCache = { revision: this.revision, width: bodyWidth, rows, start: this.sectionRows, hint, lines };
		return lines;
	}

	/** The header, independently scrolling file index, and the diff viewport, unframed. */
	private buildChanges(bodyWidth: number, available: number, hint: string): string[] {
		const changes = this.changes;
		this.fileRowIndices.clear();
		const compact = available < framingRows + overflowRows + minDiffRows + 1;
		this.fileRegionStart = this.sectionRows + (compact ? 1 : 2);
		this.fileRegionEnd = this.fileRegionStart;
		if (changes === undefined) return [headerRow([muted("Loading changes…")], hint, bodyWidth)];
		if (changes.status === "no-repo") return [headerRow([muted("Not a git repository")], hint, bodyWidth)];
		if (changes.status === "error") return [headerRow([muted(`git: ${changes.message}`)], hint, bodyWidth)];
		if (changes.totals.files === 0) {
			return [headerRow([muted(`No changes ${scopeLabel(changes.scope)}`), muted("No changes")], hint, bodyWidth)];
		}

		const listRows = compact
			? Math.min(changes.files.length, available >= 3 ? 1 : 0)
			: Math.min(maxFileRows, changes.files.length, available - framingRows - overflowRows - minDiffRows);
		const omitted = changes.totals.files - changes.files.length;
		const fileLines = listRows > 0 ? this.buildFileList(changes.files, listRows, omitted, bodyWidth, compact) : [];
		this.fileRegionEnd = this.fileRegionStart + fileLines.length;
		const lines = [headerRow(summaryTexts(changes.totals, changes.scope), hint, bodyWidth)];
		if (!compact) lines.push(exactWidth("", bodyWidth));
		lines.push(...fileLines);
		if (!compact) lines.push(exactWidth("", bodyWidth));
		lines.push(...this.buildDiff(available - lines.length, bodyWidth));
		return lines;
	}

	private buildFileList(
		files: readonly ChangedFile[],
		listRows: number,
		omitted: number,
		bodyWidth: number,
		compact: boolean,
	): string[] {
		this.fileViewRows = listRows;
		if (this.followSelection) {
			if (this.selectedIndex < this.fileOffset) this.fileOffset = this.selectedIndex;
			else if (this.selectedIndex >= this.fileOffset + listRows) this.fileOffset = this.selectedIndex - listRows + 1;
			this.followSelection = false;
		}
		this.fileOffset = Math.max(0, Math.min(this.fileOffset, files.length - listRows));
		const above = this.fileOffset;
		const below = files.length - this.fileOffset - listRows;
		const lines: string[] = [];
		const overflows = !compact && files.length > listRows;
		if (overflows) lines.push(padded(muted(above > 0 ? `↑ ${above} more above` : ""), bodyWidth));
		for (let index = this.fileOffset; index < this.fileOffset + listRows; index++) {
			const row = this.fileRegionStart + lines.length;
			this.fileRowIndices.set(row, index);
			const state = this.hoveredFileRow === row ? "hovered" : index === this.selectedIndex ? "selected" : "normal";
			lines.push(fileRow(files[index]!, state, bodyWidth));
		}
		if (!compact && (overflows || omitted > 0)) {
			const notes = [
				below > 0 ? `↓ ${below} more below` : "",
				omitted > 0 ? `+${omitted} more not listed` : "",
			].filter(Boolean);
			lines.push(padded(muted(notes.join(" · ")), bodyWidth));
		}
		return lines;
	}

	private buildDiff(rows: number, bodyWidth: number): string[] {
		this.diffViewRows = Math.max(1, rows);
		if (rows <= 0) return [];
		this.diffOffset = Math.min(this.diffOffset, this.maxDiffOffset());
		if (this.diffRowCacheWidth !== bodyWidth) {
			for (const block of this.diffBlocks) block.lines.clear();
			this.diffRowCacheWidth = bodyWidth;
		}
		const lines: string[] = [];
		const end = this.diffOffset + rows;
		for (const block of this.diffBlocks) {
			if (block.start >= end) break;
			if (block.start + block.length <= this.diffOffset) continue;
			const first = Math.max(0, this.diffOffset - block.start);
			const last = Math.min(block.length, end - block.start);
			for (let index = first; index < last; index++) lines.push(this.diffRow(block, index, bodyWidth));
		}
		return padRows(lines, rows, bodyWidth);
	}

	private diffRow(block: DiffBlock, index: number, bodyWidth: number): string {
		const cached = block.lines.get(index);
		if (cached !== undefined) return cached;
		let line: string;
		if (index === 0 || index === 2) {
			line = theme.fg("borderMuted", "─".repeat(bodyWidth));
		} else if (index === 1) {
			line = fileRow(block.file, "normal", bodyWidth);
		} else if (index === block.length - 1) {
			line = exactWidth("", bodyWidth);
		} else if (block.diff.status !== "ready") {
			line = padded(muted(block.diff.status === "loading" ? "Loading diff…" : block.diff.message), bodyWidth);
		} else {
			const row = block.diff.rows[index - 3];
			line = row
				? this.renderDiffRow(row, bodyWidth, getLanguageFromPath(block.file.path), block.gutterWidth)
				: padded(muted("No text changes"), bodyWidth);
		}
		block.lines.set(index, line);
		return line;
	}

	private renderDiffRow(row: DiffRow, bodyWidth: number, language: string | undefined, gutterWidth: number): string {
		if (row.kind === "hunk" || row.kind === "note") return padded(muted(row.text), bodyWidth);
		const number = row.kind === "removed" ? row.oldNumber : row.newNumber;
		const gutter = theme.fg("dim", String(number ?? "").padStart(gutterWidth));
		const marker =
			row.kind === "added"
				? theme.fg("toolDiffAdded", "+")
				: row.kind === "removed"
					? theme.fg("toolDiffRemoved", "-")
					: " ";
		const textWidth = Math.max(0, bodyWidth - gutterWidth - 4);
		const text = truncateToWidth(styledDiffText(row, language), textWidth, "…", true);
		const line = exactWidth(` ${gutter} ${marker} ${text}`, bodyWidth);
		if (row.kind === "added") return fillBackground(line, bodyWidth, "toolSuccessBg");
		if (row.kind === "removed") return fillBackground(line, bodyWidth, "toolErrorBg");
		return line;
	}
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((line, index) => line === b[index]);
}

function padRows(lines: string[], rows: number, bodyWidth: number): string[] {
	while (lines.length < rows) lines.push(exactWidth("", bodyWidth));
	return lines;
}

function muted(text: string): string {
	return theme.fg("muted", text);
}

function scopeLabel(scope: BaselineScope): string {
	return scope === "session" ? "since session start" : "since last commit";
}

/** The header's counts with the scope after them, and the counts alone for when there is no room for the scope. */
function summaryTexts(totals: ChangesTotals, scope: BaselineScope): string[] {
	const label = totals.files === 1 ? " file changed" : " files changed";
	const counts = [
		theme.bold(String(totals.files)) + muted(label),
		theme.fg("toolDiffAdded", `+${totals.added}`),
		theme.fg("toolDiffRemoved", `-${totals.removed}`),
	].join(" ");
	return [`${counts} ${muted(scopeLabel(scope))}`, counts];
}

/**
 * A row with the first of `lefts` that fits beside the close hint, right-aligned. When none fits, the hint is
 * dropped and the last left text is shown.
 */
function headerRow(lefts: readonly string[], closeHint: string, bodyWidth: number): string {
	const hint = muted(`${closeHint} to close`);
	const room = bodyWidth - 2;
	const left = lefts.find((candidate) => visibleWidth(candidate) + visibleWidth(hint) + 2 <= room);
	return padded(left === undefined ? lefts[lefts.length - 1]! : joinSides(left, hint, room), bodyWidth);
}

function fileRow(file: ChangedFile, state: "normal" | "selected" | "hovered", bodyWidth: number): string {
	const counts = fileCounts(file);
	const pathWidth = Math.max(1, bodyWidth - 2 - visibleWidth(counts) - 2);
	const path = truncatePathStart(file.label, pathWidth);
	const row = padded(
		joinSides(theme.fg(state === "normal" ? "muted" : "text", path), counts, bodyWidth - 2),
		bodyWidth,
	);
	if (state === "normal") return row;
	const highlighted = fillBackground(row, bodyWidth, "selectedBg");
	// Inversion distinguishes hover even on the selected file, including after a truncation reset.
	return state === "hovered" ? theme.inverse(highlighted.replaceAll("\x1b[0m", "\x1b[0m\x1b[7m")) : highlighted;
}

/** Syntax-highlighted text when the language is known, otherwise the kind's diff color. */
function styledDiffText(row: DiffCodeRow, language: string | undefined): string {
	const text = row.text;
	if (language === undefined || text.length === 0 || text.length > maxHighlightLength) {
		return theme.fg(
			row.kind === "added" ? "toolDiffAdded" : row.kind === "removed" ? "toolDiffRemoved" : "toolDiffContext",
			text,
		);
	}
	return highlightCode(text, language)[0] ?? text;
}

/** Pad or cut a line to exactly `width` columns. */
function exactWidth(line: string, width: number): string {
	return truncateToWidth(line, width, "", true);
}

/** A body line: one column of margin, then the text cut to fit. */
function padded(text: string, bodyWidth: number): string {
	return truncateToWidth(` ${text}`, bodyWidth, "…", true);
}

/** `left` and `right` on one line of `width` columns, or `left` alone when they do not fit with a gap. */
function joinSides(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 2 ? left + " ".repeat(gap) + right : left;
}

/** The right side of a file row: green and red line counts, or a label for files without counts. */
function fileCounts(file: ChangedFile): string {
	if (file.content === "binary") return theme.fg("muted", "binary");
	if (file.content === "large") return theme.fg("muted", "large");
	const parts: string[] = [];
	if (file.added > 0) parts.push(theme.fg("toolDiffAdded", `+${file.added}`));
	if (file.removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${file.removed}`));
	return parts.join(" ");
}

/** Cut the start of a path so its file name stays visible. */
function truncatePathStart(path: string, width: number): string {
	const pathWidth = visibleWidth(path);
	if (pathWidth <= width) return path;
	if (width <= 1) return "…".slice(0, width);
	return `…${sliceByColumn(path, pathWidth - (width - 1), width - 1, true)}`;
}

/** Widest line number in the diff, as a column width. */
function gutterWidthFor(rows: readonly DiffRow[]): number {
	let largest = 0;
	for (const row of rows) {
		if (row.kind === "hunk" || row.kind === "note") continue;
		largest = Math.max(largest, row.oldNumber ?? 0, row.newNumber ?? 0);
	}
	return String(largest).length;
}

/** Paint `bg` behind a line, padded to `width`. Truncation ends with a full reset, so the color is restored after each. */
function fillBackground(line: string, width: number, bg: ThemeBg): string {
	const open = theme.getBgAnsi(bg);
	const filled = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	return `${open}${filled.replaceAll("\x1b[0m", `\x1b[0m${open}`)}\x1b[49m`;
}
