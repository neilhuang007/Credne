// Covers family aliases such as "sol" in subagent model resolution and their latest-version rule.
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createSubagentDispatch } from "../src/extensions/subagent/dispatch.ts";
import aliases from "../src/extensions/subagent/model-aliases.json" with { type: "json" };
import {
	findAliasRowOfModel,
	resolveModelAlias,
	resolveProviderAlias,
} from "../src/extensions/subagent/model-aliases.ts";

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

	it("uses an older version of the family when the pool does not serve the listed one", () => {
		const models = [model("gpt-5.6-sol"), model("gpt-6.1-sol")];

		expect(resolveModel("sol", models)).toBe("test-provider/gpt-6.1-sol");
	});

	it("falls back to ordinary matching when the pool serves no model of the alias family", () => {
		const models = [model("gpt-sol-pro-1"), model("gpt-sol-max-1")];

		expect(() => resolveModel("sol", models)).toThrow(/Ambiguous subagent model "sol"/);
	});

	it("has one row per provider and alias", () => {
		const keys = aliases.map((row) => `${row.provider}/${row.alias}`);
		const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);

		expect(duplicates).toEqual([]);
	});
});

describe("latest version of an alias family", () => {
	function resolveId(alias: string, ids: string[]): string | undefined {
		return resolveModelAlias(
			alias,
			ids.map((id) => model(id)),
		)?.id;
	}

	it("picks a newer version that the table does not list", () => {
		expect(resolveId("astra", ["gpt-6.2-astra", "gpt-6.3-astra", "gpt-6.1-astra"])).toBe("gpt-6.3-astra");
		expect(resolveId("fable", ["claude-fable-5-2", "claude-fable-6"])).toBe("claude-fable-6");
	});

	it("compares version parts as numbers and a longer version above its prefix", () => {
		expect(resolveId("astra", ["gpt-6.9-astra", "gpt-6.10-astra"])).toBe("gpt-6.10-astra");
		expect(resolveId("astra", ["gpt-6.2-astra", "gpt-6.2.1-astra"])).toBe("gpt-6.2.1-astra");
		expect(resolveId("luna", ["gpt-6-luna", "gpt-6.1-luna"])).toBe("gpt-6.1-luna");
	});

	it("uses an older version when the listed one is not served", () => {
		expect(resolveId("astra", ["gpt-6.1-astra", "gpt-5.9-astra"])).toBe("gpt-6.1-astra");
		expect(resolveId("pro", ["deepseek-v3-pro"])).toBe("deepseek-v3-pro");
	});

	it("prefers the undated ID over a dated snapshot of the same version, whatever their order", () => {
		for (const ids of [
			["claude-haiku-5-5-20260101", "claude-haiku-5-5"],
			["claude-haiku-5-5", "claude-haiku-5-5-20260101"],
		]) {
			expect(resolveId("haiku", ids)).toBe("claude-haiku-5-5");
		}
		expect(resolveId("haiku", ["claude-haiku-5-5", "claude-haiku-5-6-20260301"])).toBe("claude-haiku-5-6-20260301");
	});

	it("does not match a different family that shares a word", () => {
		expect(resolveId("astra", ["gpt-6.2-astra-pro", "gpt-6.9-astra-mini"])).toBeUndefined();
		expect(resolveId("astra", ["gpt-6.9-astra-pro", "gpt-6.2-astra"])).toBe("gpt-6.2-astra");
		expect(resolveId("flash", ["gemini-3.5-flash-lite"])).toBeUndefined();
		expect(resolveId("flash-lite", ["gemini-3.5-flash-lite", "gemini-3.8-flash"])).toBe("gemini-3.5-flash-lite");
	});

	it("keeps the first of equal IDs and the model object of the item it picks", () => {
		const first = model("gpt-6.2-sol", "pool:all");
		const second = model("gpt-6.2-sol", "pool:codex");

		expect(resolveModelAlias("sol", [first, second])).toBe(first);
		expect(resolveModelAlias("sol", [second, first])).toBe(second);
	});

	it("resolves the rows of one provider", () => {
		const items = [{ id: "gemini-3.9-flash" }, { id: "deepseek-flash" }];

		expect(resolveProviderAlias("google", "flash", items)).toBe(items[0]);
		expect(resolveProviderAlias("deepseek", "flash", items)).toBe(items[1]);
		expect(resolveProviderAlias("anthropic", "flash", items)).toBeUndefined();
	});

	it("finds the alias row a model ID belongs to", () => {
		expect(findAliasRowOfModel("gpt-6.1-sol")).toMatchObject({ provider: "openai", alias: "sol" });
		expect(findAliasRowOfModel("claude-haiku-4-5-20251001")).toMatchObject({ provider: "anthropic", alias: "haiku" });
		expect(findAliasRowOfModel("gpt-sol-pro-1")).toBeUndefined();
	});
});
