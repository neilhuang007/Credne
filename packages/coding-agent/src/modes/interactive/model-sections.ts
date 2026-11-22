// Groups /model choices into sections: one row per model alias under its vendor, and one section per local provider.
import { type Api, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import { isBrokerProvider } from "../../extensions/accounts/catalog.ts";
import { findAliasRowOfModel, modelAliasRows, resolveAliasRow } from "../../extensions/subagent/model-aliases.ts";

export interface ModelSectionRow {
	model: Model<Api>;
	/** The alias the row stands for. Rows without one are shown by model ID. */
	alias?: string;
}

export interface ModelSection {
	/** Stable across catalog refreshes, so a section keeps its fold state. */
	key: string;
	title: string;
	rows: ModelSectionRow[];
}

const vendorTitles: Record<string, string> = {
	anthropic: "Claude",
	openai: "ChatGPT / OpenAI",
	xai: "xAI",
	meta: "Meta",
	deepseek: "DeepSeek",
	google: "Google",
};

/**
 * Sections in a stable order: vendors in alias file order, then providers in the order of `choices`. An alias row
 * resolves to its family's latest model among `choices`, so accounts and pools that serve it add no rows. Broker
 * models no alias covers stay out, except `currentModel`, which is listed by ID so the selection is visible.
 * `choices` is the order of preference when equal IDs are served by several providers.
 */
export function buildModelSections(
	choices: readonly Model<Api>[],
	currentModel: Model<Api> | undefined,
	getProviderName: (provider: string) => string | undefined,
): ModelSection[] {
	const sections = new Map<string, ModelSection>();
	const providerSection = (provider: string) =>
		getSection(sections, `provider:${provider}`, getProviderName(provider) ?? provider);
	const listed = new Set<Model<Api>>();
	for (const row of modelAliasRows) {
		const model = resolveAliasRow(row, choices);
		if (!model) continue;
		listed.add(model);
		getSection(sections, `vendor:${row.provider}`, vendorTitle(row.provider)).rows.push({ model, alias: row.alias });
	}

	const current = choices.find((model) => modelsAreEqual(currentModel, model));
	if (current && !listed.has(current)) {
		listed.add(current);
		const row = isBrokerProvider(current.provider) ? findAliasRowOfModel(current.id) : undefined;
		const section = row
			? getSection(sections, `vendor:${row.provider}`, vendorTitle(row.provider))
			: providerSection(current.provider);
		section.rows.unshift({ model: current });
	}

	for (const model of choices) {
		if (listed.has(model) || isBrokerProvider(model.provider)) continue;
		providerSection(model.provider).rows.push({ model });
	}
	return [...sections.values()];
}

function getSection(sections: Map<string, ModelSection>, key: string, title: string): ModelSection {
	const existing = sections.get(key);
	if (existing) return existing;
	const section: ModelSection = { key, title, rows: [] };
	sections.set(key, section);
	return section;
}

function vendorTitle(vendor: string): string {
	return vendorTitles[vendor] ?? vendor;
}
