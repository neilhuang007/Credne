import { type Api, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	getKeybindings,
	getSelectPageIndex,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { USES_BROKER_AUTH } from "../../../config.ts";
import { getExactModelSelectionMatches } from "../../../core/model-resolver.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { getModelSelectionChoices } from "../../../core/model-selection.ts";
import { ACCOUNT_PROVIDER_PREFIX } from "../../../extensions/accounts/catalog.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { filterModelSelection, getDistinctModelName, getModelSelectorSearchText } from "../model-search.ts";
import { buildModelSections, type ModelSection } from "../model-sections.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText, keyHint } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

/** A selectable model. Grouped rows sit under a section header and show their alias, when they have one. */
interface ModelEntry {
	type: "model";
	item: ModelItem;
	isGrouped: boolean;
	alias?: string;
}

/** A collapsible section header of the grouped view. */
interface SectionEntry {
	type: "section";
	section: ModelSection;
	isExpanded: boolean;
}

type ListEntry = ModelEntry | SectionEntry;

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

interface DefaultModelReference {
	provider: string;
	id: string;
}

type ModelScope = "all" | "scoped";

export interface ModelPickerSelection {
	model: Model<Api>;
	scope: ModelScope;
	alias?: string;
	query: string;
}

const MAX_VISIBLE = 10;

function toModelItem(model: Model<any>): ModelItem {
	return { provider: model.provider, id: model.id, model };
}

function isSameEntry(entry: ListEntry, other: ListEntry): boolean {
	if (entry.type === "section") return other.type === "section" && other.section.key === entry.section.key;
	return other.type === "model" && modelsAreEqual(entry.item.model, other.item.model);
}

/**
 * Component that renders a model selector with search.
 *
 * In Credne, the unscoped list without a search query is grouped: one row per model alias under its vendor, and one
 * section per local provider. A search, the scoped list, and other builds show the flat list of every choice.
 */
export class ModelSelectorComponent extends Container implements Focusable {
	readonly capturesViewportInput: boolean = true;
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private sections: ModelSection[] = [];
	private aliasWidth = 0;
	// Kept across catalog refreshes and searches. Set on first use: the section of the current model, else the first.
	private expandedSections?: Set<string>;
	private entries: ListEntry[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private modelRuntime: ModelRuntime;
	private onSelectCallback: (selection: ModelPickerSelection) => void;
	private onSelectAsDefaultCallback?: (selection: ModelPickerSelection) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private defaultModel?: DefaultModelReference;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (selection: ModelPickerSelection) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (selection: ModelPickerSelection) => void,
		defaultModel?: DefaultModelReference,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.defaultModel = defaultModel;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			const hintText = USES_BROKER_AUTH
				? "Use /accounts to add provider accounts."
				: "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		// Enter on search input selects the highlighted row
		this.searchInput.onSubmit = () => this.confirmSelection();
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Hint
		if (this.onSelectAsDefaultCallback) {
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						`  ${keyDisplayText("tui.select.confirm")} to select · ${keyDisplayText("app.models.save")} to set as default · ${keyDisplayText("tui.select.cancel")} to cancel`,
					),
					0,
					0,
				),
			);
		}

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Render the current snapshot immediately, then refresh in the background.
		this.loadModelsFromSnapshot();
		this.filterModels(initialSearchInput ?? "");
		this.tui.requestRender();
		void this.refreshModels();
	}

	private loadModelsFromSnapshot(): void {
		const models = getModelSelectionChoices(
			this.modelRuntime.getAvailableSnapshot(),
			this.currentModel?.provider,
		).map(toModelItem);
		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => toModelItem(scoped.model));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.sections = USES_BROKER_AUTH
			? buildModelSections(
					this.allModels.map((item) => item.model),
					this.currentModel,
					(provider) => this.modelRuntime.getProvider(provider)?.name,
				)
			: [];
		this.aliasWidth = Math.max(
			0,
			...this.sections.flatMap((section) => section.rows.map((row) => row.alias?.length ?? 0)),
		);
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.activeModels.length - 1));
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			const selectedEntry = this.entries[this.selectedIndex];
			this.loadModelsFromSnapshot();
			// The user may have moved while the refresh was in flight, and the refresh can shift rows.
			this.filterModels(this.searchInput.getValue(), selectedEntry);
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.refreshStatusMessage = "";
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			this.updateList();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort: current model first, default model second, then by provider.
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const aIsDefault = this.isDefaultModel(a.model);
			const bIsDefault = this.isDefaultModel(b.model);
			if (aIsDefault && !bIsDefault) return -1;
			if (!aIsDefault && bIsDefault) return 1;
			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("tui.input.tab", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private isDefaultModel(model: Model<any>): boolean {
		return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
	}

	private isDefaultSearch(query: string): boolean {
		const normalized = query.trim().toLowerCase();
		return normalized.length > 0 && "default".startsWith(normalized);
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.filterModels(this.searchInput.getValue());
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	/** Only the unscoped list without a query is grouped; a query lists every matching choice, aliased or not. */
	private isGroupedView(query: string): boolean {
		return USES_BROKER_AUTH && this.scope === "all" && !query;
	}

	private filterModels(query: string, preferred?: ListEntry): void {
		this.entries = this.buildEntries(query);
		this.selectedIndex = this.getSelectedIndex(query, preferred);
		this.updateList();
	}

	private buildEntries(query: string): ListEntry[] {
		if (this.isGroupedView(query)) return this.buildSectionEntries();
		return this.searchModels(query).map((item): ModelEntry => ({ type: "model", item, isGrouped: false }));
	}

	private searchModels(query: string): ModelItem[] {
		if (!query) return this.activeModels;
		const filtered = filterModelSelection(
			this.activeModels,
			query,
			(item) => item.model,
			(item) => {
				const defaultText = this.isDefaultModel(item.model) ? " default" : "";
				return `${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${defaultText}`;
			},
		);
		if (!this.isDefaultSearch(query)) return filtered;
		const defaultItems = this.activeModels.filter((item) => this.isDefaultModel(item.model));
		const defaultKeys = new Set(defaultItems.map((item) => `${item.provider}\0${item.id}`));
		return [...defaultItems, ...filtered.filter((item) => !defaultKeys.has(`${item.provider}\0${item.id}`))];
	}

	private buildSectionEntries(): ListEntry[] {
		if (this.sections.length === 0) return [];
		const expandedSections = this.getExpandedSections();
		return this.sections.flatMap((section): ListEntry[] => {
			const isExpanded = expandedSections.has(section.key);
			const header: SectionEntry = { type: "section", section, isExpanded };
			if (!isExpanded) return [header];
			const rows = section.rows.map(
				(row): ModelEntry => ({ type: "model", item: toModelItem(row.model), isGrouped: true, alias: row.alias }),
			);
			return [header, ...rows];
		});
	}

	/** Callers only ask while sections are listed, so the first section exists when none holds the current model. */
	private getExpandedSections(): Set<string> {
		if (this.expandedSections) return this.expandedSections;
		const currentSection = this.sections.find((section) =>
			section.rows.some((row) => modelsAreEqual(this.currentModel, row.model)),
		);
		this.expandedSections = new Set([(currentSection ?? this.sections[0]).key]);
		return this.expandedSections;
	}

	private toggleSection(section: ModelSection): void {
		const expandedSections = this.getExpandedSections();
		if (!expandedSections.delete(section.key)) expandedSections.add(section.key);
		// The header keeps its index: only the rows below it change.
		this.entries = this.buildSectionEntries();
		this.updateList();
	}

	/**
	 * Keeps the preferred entry selected if it is still listed. Otherwise, when filtering by a query, moves to the
	 * top row so the best match is highlighted. Without a query, the grouped view returns to the current model, and
	 * a restored flat list keeps its position, clamped to its length.
	 */
	private getSelectedIndex(query: string, preferred?: ListEntry): number {
		const preferredIndex = preferred ? this.entries.findIndex((entry) => isSameEntry(entry, preferred)) : -1;
		if (preferredIndex >= 0) return preferredIndex;
		if (query) return 0;
		if (this.isGroupedView(query)) {
			const currentIndex = this.entries.findIndex(
				(entry) => entry.type === "model" && modelsAreEqual(this.currentModel, entry.item.model),
			);
			return Math.max(0, currentIndex);
		}
		return Math.min(this.selectedIndex, Math.max(0, this.entries.length - 1));
	}

	private updateList(): void {
		this.listContainer.clear();

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.entries.length - MAX_VISIBLE),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.entries.length);

		// Show visible slice of the entries
		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.entries[i];
			if (!entry) continue;

			const isSelected = i === this.selectedIndex;
			const line =
				entry.type === "section"
					? this.renderSectionRow(entry, isSelected)
					: this.renderModelRow(entry, isSelected);
			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.entries.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.entries.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		const selected = this.entries[this.selectedIndex];
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (!selected) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", this.getDetailText(selected)), 0, 0));
		}
		if (this.refreshStatusMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
	}

	private getDetailText(entry: ListEntry): string {
		if (entry.type === "model") return `  Model Name: ${entry.item.model.name}`;
		return `  ${keyDisplayText("tui.select.confirm")} to ${entry.isExpanded ? "collapse" : "expand"}`;
	}

	private renderSectionRow(entry: SectionEntry, isSelected: boolean): string {
		const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
		const foldMarker = theme.fg("accent", entry.isExpanded ? "⊟ " : "⊞ ");
		const title = theme.bold(entry.section.title);
		const count = theme.fg("muted", ` (${entry.section.rows.length})`);
		return `${cursor}${foldMarker}${isSelected ? theme.fg("accent", title) : title}${count}`;
	}

	private renderModelRow(entry: ModelEntry, isSelected: boolean): string {
		const { item } = entry;
		const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
		const currentMarker = modelsAreEqual(this.currentModel, item.model) ? theme.fg("accent", "✓ ") : "  ";
		const defaultBadge = this.isDefaultModel(item.model) ? theme.fg("muted", " · default") : "";
		const name = getDistinctModelName({ id: item.id, name: item.model.name });

		if (!entry.isGrouped) {
			const modelText = isSelected ? theme.fg("accent", item.id) : item.id;
			const nameText = name ? theme.fg("muted", ` (${name})`) : "";
			const providerBadge = theme.fg("muted", `[${item.provider}]`);
			return `${cursor}${currentMarker}${modelText}${nameText} ${providerBadge}${defaultBadge}`;
		}

		// The header names the vendor or provider, so a row repeats neither, except for a pinned account's row.
		const label = entry.alias?.padEnd(this.aliasWidth) ?? item.id;
		const labelText = isSelected ? theme.fg("accent", label) : label;
		const idText = entry.alias ? theme.fg("dim", ` ${item.id}`) : "";
		const nameText = name ? theme.fg("dim", ` (${name})`) : "";
		const accountBadge = item.provider.startsWith(ACCOUNT_PROVIDER_PREFIX)
			? theme.fg("dim", ` [${item.provider}]`)
			: "";
		return `${cursor}  ${currentMarker}${labelText}${idText}${nameText}${accountBadge}${defaultBadge}`;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const pageIndex = getSelectPageIndex(kb, keyData, this.selectedIndex, this.entries.length, MAX_VISIBLE);
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.entries.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.entries.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.entries.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.entries.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Page up/down
		else if (pageIndex !== undefined) {
			if (this.entries.length === 0) return;
			this.selectedIndex = pageIndex;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirmSelection();
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.dispose();
			this.onCancelCallback();
		}
		// Select and save as default
		else if (kb.matches(keyData, "app.models.save") && this.onSelectAsDefaultCallback) {
			const entry = this.entries[this.selectedIndex];
			if (entry?.type === "model") {
				this.handleSelect(entry, this.onSelectAsDefaultCallback);
			}
		}
		// Pass everything else to search input
		else {
			this.handleSearchInput(keyData);
		}
	}

	private handleSearchInput(keyData: string): void {
		const previousQuery = this.searchInput.getValue();
		this.searchInput.handleInput(keyData);
		const query = this.searchInput.getValue();
		// Moving the caret in the search text must not move the highlighted row.
		if (query === previousQuery) return;
		this.filterModels(query);
	}

	/** Enter selects the highlighted model, or folds and unfolds the highlighted section. */
	private confirmSelection(): void {
		const entry = this.entries[this.selectedIndex];
		if (!entry) return;
		if (entry.type === "section") {
			this.toggleSection(entry.section);
			return;
		}
		this.handleSelect(entry, this.onSelectCallback);
	}

	private handleSelect(entry: ModelEntry, callback: (selection: ModelPickerSelection) => void): void {
		const query = this.searchInput.getValue().trim();
		const { model } = entry.item;
		let alias = entry.alias;
		if (
			USES_BROKER_AUTH &&
			this.scope === "all" &&
			query &&
			!query.includes("/") &&
			query.toLowerCase() !== model.id.toLowerCase()
		) {
			// Only the exact alias match stands for a family; choosing another search result selects an exact ID.
			const matches = getExactModelSelectionMatches(
				query,
				this.activeModels.map((item) => item.model),
				"scoped",
			);
			if (matches.length === 1 && modelsAreEqual(matches[0], model)) alias = query;
		}
		this.dispose();
		callback({ model, scope: this.scope, alias, query });
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
