// Covers capability tiers in subagent dispatch: model and effort resolution, precedence, and profile frontmatter.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type { ExtensionAPI, ExtensionToolContext } from "../src/core/extensions/types.ts";
import { discoverAgents, discoverBundledAgents } from "../src/extensions/subagent/agents.ts";
import {
	createSubagentDispatch,
	type DispatchSelection,
	type ProfileDefaults,
	reasoningEffortSchema,
} from "../src/extensions/subagent/dispatch.ts";
import aliases from "../src/extensions/subagent/model-aliases.json" with { type: "json" };
import tiers from "../src/extensions/subagent/model-tiers.json" with { type: "json" };
import { modelTierSchema } from "../src/extensions/subagent/model-tiers.ts";

const parentProvider = "test-provider";
const parentEffort = "low";

function model(id: string, supportsXhigh = true): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: parentProvider,
		baseUrl: "https://provider.invalid/v1",
		input: ["text"],
		reasoning: true,
		thinkingLevelMap: supportsXhigh ? { xhigh: "xhigh", max: null } : { max: null },
		cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.2 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

const claudePool = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"];
const gptPool = ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-sol", "gpt-6.2-astra"];

function resolve(
	ids: string[],
	selection: DispatchSelection,
	profile?: ProfileDefaults,
): { model: string; thinkingLevel: string } {
	const models = [model("parent"), ...ids.map((id) => model(id))];
	return resolveOn(models, selection, profile);
}

function resolveOn(models: Model<Api>[], selection: DispatchSelection, profile?: ProfileDefaults) {
	const registry = {
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, id: string) =>
			models.find((candidate) => candidate.provider === provider && candidate.id === id),
	};
	const ctx = {
		cwd: process.cwd(),
		model: model("parent"),
		thinkingLevel: parentEffort,
		modelRegistry: registry,
		sessionManager: { getSessionId: () => "model-tier-test-session", getBranch: () => [] },
	} as unknown as ExtensionToolContext;
	const pi = { on: vi.fn(), getThinkingLevel: () => "off" } as unknown as ExtensionAPI;
	return createSubagentDispatch(pi).resolve(selection, ctx, profile);
}

describe("tier resolution", () => {
	it("maps a profile tier to the model family the account serves, with the tier's effort", () => {
		expect(resolve(claudePool, {}, { tier: "light" })).toEqual({
			model: "test-provider/claude-haiku-5-5",
			thinkingLevel: "medium",
		});
		expect(resolve(gptPool, {}, { tier: "light" })).toEqual({
			model: "test-provider/gpt-6-luna",
			thinkingLevel: "medium",
		});
		expect(resolve(gptPool, {}, { tier: "heavy" })).toEqual({
			model: "test-provider/gpt-6.2-astra",
			thinkingLevel: "xhigh",
		});
	});

	it("prefers explicit model, then explicit tier, then profile model, then profile tier", () => {
		const profile: ProfileDefaults = { model: "sonnet", tier: "light" };

		expect(resolve(claudePool, {}, profile).model).toBe("test-provider/claude-sonnet-5-5");
		expect(resolve(claudePool, { tier: "heavy" }, profile).model).toBe("test-provider/claude-fable-5-2");
		expect(resolve(claudePool, { model: "haiku", tier: "heavy" }, profile).model).toBe(
			"test-provider/claude-haiku-5-5",
		);
		expect(resolve(claudePool, {}, { tier: "medium" }).model).toBe("test-provider/claude-opus-5-5");
	});

	it("keeps the inherited effort when an explicit model overrides the tier", () => {
		expect(resolve(claudePool, { model: "haiku", tier: "heavy" })).toEqual({
			model: "test-provider/claude-haiku-5-5",
			thinkingLevel: parentEffort,
		});
	});

	it("lets an explicit effort win and clamps a tier effort the model lacks", () => {
		expect(resolve(claudePool, { tier: "medium", reasoningEffort: "low" }).thinkingLevel).toBe("low");

		const withoutXhigh = [model("parent"), model("claude-opus-5-5", false)];
		expect(resolveOn(withoutXhigh, { tier: "medium" }).thinkingLevel).toBe("high");
		expect(() => resolveOn(withoutXhigh, { tier: "medium", reasoningEffort: "xhigh" })).toThrow(
			/does not support reasoning effort xhigh/,
		);
	});

	it("falls through to the next source when the account has no row for a tier", () => {
		// Only haiku is served: heavy has no row, so the profile tier applies.
		expect(resolve(["claude-haiku-5-5"], { tier: "heavy" }, { tier: "light" }).model).toBe(
			"test-provider/claude-haiku-5-5",
		);
		// A profile model is a more specific default than the profile tier.
		expect(resolve(["claude-haiku-5-5"], { tier: "heavy" }, { model: "haiku", tier: "medium" }).model).toBe(
			"test-provider/claude-haiku-5-5",
		);
	});

	it("inherits the parent model and effort when the account has no tier rows", () => {
		expect(resolve(["deepseek-v4-pro"], { tier: "heavy" }, { tier: "light" })).toEqual({
			model: "test-provider/parent",
			thinkingLevel: parentEffort,
		});
	});
});

describe("tier profiles and data", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	function projectWithAgents(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "pi-tier-agents-"));
		directories.push(root);
		const agentsDir = join(root, CONFIG_DIR_NAME, "agents");
		mkdirSync(agentsDir, { recursive: true });
		for (const [name, text] of Object.entries(files)) writeFileSync(join(agentsDir, `${name}.md`), text);
		return root;
	}

	const agentFile = (name: string, tierLine: string) =>
		`---\nname: ${name}\ndescription: Test agent ${name}\n${tierLine}\n---\nBody of ${name}\n`;

	it("reads a tier from agent frontmatter and ignores values that are not tiers", () => {
		const root = projectWithAgents({
			valid: agentFile("valid", "tier: heavy"),
			unknown: agentFile("unknown", "tier: huge"),
			numeric: agentFile("numeric", "tier: 3"),
			none: agentFile("none", ""),
		});

		const agents = discoverAgents(root, "project").agents;
		const tierOf = (name: string) => agents.find((agent) => agent.name === name);

		expect(tierOf("valid")?.tier).toBe("heavy");
		for (const name of ["unknown", "numeric", "none"]) {
			expect(tierOf(name)).toBeDefined();
			expect(tierOf(name)?.tier).toBeUndefined();
		}
	});

	it("gives each bundled profile its default tier", () => {
		const bundled = Object.fromEntries(discoverBundledAgents().map((agent) => [agent.name, agent.tier]));

		expect(bundled).toEqual({ explorer: "light", worker: "medium", critic: "heavy", crazy: "heavy" });
	});

	it("only lists tier rows that name a valid tier, effort and existing alias", () => {
		for (const row of tiers) {
			expect(Value.Check(modelTierSchema, row.tier)).toBe(true);
			expect(Value.Check(reasoningEffortSchema, row.effort)).toBe(true);
			expect(aliases.some((alias) => alias.provider === row.provider && alias.alias === row.alias)).toBe(true);
		}
	});
});
