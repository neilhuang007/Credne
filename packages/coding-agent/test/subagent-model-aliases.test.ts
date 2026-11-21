// Covers family aliases such as "sol" in subagent model resolution.
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createSubagentDispatch } from "../src/extensions/subagent/dispatch.ts";
import aliases from "../src/extensions/subagent/model-aliases.json" with { type: "json" };

const parentProvider = "test-provider";

function model(id: string, provider = parentProvider): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://provider.invalid/v1",
		input: ["text"],
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: null },
		cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.2 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function createContext(models: Model<Api>[]): ExtensionToolContext {
	const registry = {
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, id: string) =>
			models.find((candidate) => candidate.provider === provider && candidate.id === id),
	};
	return {
		cwd: process.cwd(),
		model: model("parent"),
		thinkingLevel: "medium",
		modelRegistry: registry,
		sessionManager: { getSessionId: () => "model-alias-test-session", getBranch: () => [] },
	} as unknown as ExtensionToolContext;
}

function resolveModel(query: string, models: Model<Api>[]): string {
	const pi = { on: vi.fn(), getThinkingLevel: () => "low" } as unknown as ExtensionAPI;
	return createSubagentDispatch(pi).resolve({ model: query }, createContext(models)).model;
}

describe("model aliases", () => {
	it("resolves a family alias to the newest model of that family", () => {
		const models = [model("gpt-5.6-sol"), model("gpt-6.1-sol"), model("gpt-6.2-sol")];

		expect(resolveModel("sol", models)).toBe("test-provider/gpt-6.2-sol");
		expect(resolveModel("SOL", models)).toBe("test-provider/gpt-6.2-sol");
	});

	it("tries the next row of an alias when the pool does not serve an earlier target", () => {
		// "flash" names deepseek-flash first and gemini-3.8-flash second; a pool serves only one of them.
		expect(resolveModel("flash", [model("gemini-3.8-flash"), model("gemini-3.5-flash-lite")])).toBe(
			"test-provider/gemini-3.8-flash",
		);
		expect(resolveModel("flash", [model("deepseek-flash"), model("gemini-3.5-flash-lite")])).toBe(
			"test-provider/deepseek-flash",
		);
	});

	it("prefers an exact model ID over an alias", () => {
		const models = [
			model("flash"),
			model("gemini-3.8-flash"),
			model("flash", "other-provider"),
			model("gemini-3.8-flash", "other-provider"),
		];

		expect(resolveModel("flash", models)).toBe("test-provider/flash");
		expect(resolveModel("other-provider/flash", models)).toBe("other-provider/flash");
	});

	it("resolves on the provider named in the model instead of the parent's", () => {
		const models = [
			model("claude-fable-5-2"),
			model("claude-fable-5-0", "other-provider"),
			model("claude-fable-5-2", "other-provider"),
		];

		expect(resolveModel("other-provider/fable", models)).toBe("other-provider/claude-fable-5-2");
	});

	it("falls back to ordinary matching when the pool does not serve the alias target", () => {
		const models = [model("gpt-5.6-sol"), model("gpt-6.1-sol")];

		expect(() => resolveModel("sol", models)).toThrow(/Ambiguous subagent model "sol"/);
	});

	it("has one row per provider and alias", () => {
		const keys = aliases.map((row) => `${row.provider}/${row.alias}`);
		const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);

		expect(duplicates).toEqual([]);
	});
});
