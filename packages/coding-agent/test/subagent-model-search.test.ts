import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { ACCOUNT_HEADER } from "../src/extensions/accounts/provider.ts";
import { createSubagentDispatch } from "../src/extensions/subagent/dispatch.ts";
import { registerModelSearch } from "../src/extensions/subagent/model-search.ts";

type Hook = (event: never, ctx: ExtensionContext) => unknown;

interface SearchModel {
	id: string;
	reasoningEfforts: string[];
	contextWindow: number;
	cost: Record<string, unknown>;
	modelId?: string;
	name?: string;
	input?: string[];
	maxTokens?: number;
}

interface SearchResult {
	provider: string;
	total: number;
	models: SearchModel[];
	nextOffset?: number;
	note: string;
}

interface FixtureOptions {
	name?: string;
	provider?: string;
	input?: Model<Api>["input"];
	cost?: Model<Api>["cost"];
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

let agentDir: string;

function cost(input: number, output: number, cacheRead = 0.01): Model<Api>["cost"] {
	return { input, output, cacheRead, cacheWrite: 0.2 };
}

function model(id: string, options: FixtureOptions = {}): Model<Api> {
	return {
		id,
		name: options.name ?? id,
		api: "openai-completions",
		provider: options.provider ?? "test-provider",
		baseUrl: "https://provider.invalid/v1",
		input: options.input ?? ["text"],
		reasoning: options.reasoning ?? true,
		thinkingLevelMap: { xhigh: "xhigh", max: null },
		cost: options.cost ?? cost(0.1, 0.2),
		contextWindow: options.contextWindow ?? 128_000,
		maxTokens: options.maxTokens ?? 4_096,
	};
}

function createContext(parent: Model<Api>, models: Model<Api>[]): ExtensionToolContext {
	const registry = {
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, id: string) =>
			models.find((candidate) => candidate.provider === provider && candidate.id === id),
	};
	return {
		cwd: process.cwd(),
		model: parent,
		thinkingLevel: "medium",
		modelRegistry: registry,
		sessionManager: { getSessionId: () => "model-search-test-session", getBranch: () => [] },
	} as unknown as ExtensionToolContext;
}

function registerSearch(parent: Model<Api>, models: Model<Api>[]) {
	const hooks = new Map<string, Hook>();
	let tool: ToolDefinition | undefined;
	const pi = {
		on(name: string, handler: Hook) {
			hooks.set(name, handler);
		},
		registerTool(definition: ToolDefinition) {
			tool = definition;
		},
	} as unknown as ExtensionAPI;
	const dispatch = createSubagentDispatch(pi);
	registerModelSearch(pi, dispatch);
	if (!tool) throw new Error("search_models was not registered");
	const ctx = createContext(parent, models);
	return { tool, ctx, hooks };
}

async function search(registered: ReturnType<typeof registerSearch>, params: Record<string, unknown> = {}) {
	return registered.tool.execute("search", params, undefined, undefined, registered.ctx);
}

function output(result: Awaited<ReturnType<typeof search>>): SearchResult {
	const text = result.content[0];
	if (text?.type !== "text") throw new Error("search_models returned no text result");
	return JSON.parse(text.text) as SearchResult;
}

async function establishPoolAccount(registered: ReturnType<typeof registerSearch>, accountKey: string): Promise<void> {
	const beforeRequest = registered.hooks.get("before_provider_request");
	const afterResponse = registered.hooks.get("after_provider_response");
	const streamEvent = registered.hooks.get("provider_stream_event");
	if (!beforeRequest || !afterResponse || !streamEvent) throw new Error("dispatch hooks were not registered");
	await beforeRequest({ payload: {} } as never, registered.ctx);
	await afterResponse({ status: 200, headers: { [ACCOUNT_HEADER]: accountKey } } as never, registered.ctx);
	await streamEvent(
		{
			provider: registered.ctx.model?.provider,
			model: registered.ctx.model?.id,
		} as never,
		registered.ctx,
	);
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-model-search-"));
	mkdirSync(join(agentDir, "accounts"), { recursive: true });
	writeFileSync(join(agentDir, "accounts", "catalog.json"), JSON.stringify({ version: 2, accounts: [], pools: [] }));
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("search_models", () => {
	it("defaults to five compact cost-ranked models while retaining full details", async () => {
		const models = [
			model("unknown-b", { name: "Unknown B", cost: cost(0, 0) }),
			model("tie-b", { name: "Same price", cost: cost(1, 1) }),
			model("partial-zero", { name: "Known low", cost: cost(0, 0.02) }),
			model("unknown-a", { name: "Unknown A", cost: cost(0, 0) }),
			model("tie-a", { name: "Same price", cost: cost(1, 1) }),
			model("cheap", { name: "Cheap", cost: cost(0.05, 0.05) }),
			model("middle", { name: "Middle", cost: cost(2, 2) }),
		];
		const registered = registerSearch(model("parent"), models);
		const result = await search(registered);
		const compact = output(result);

		expect(compact.models.map((entry) => entry.id)).toEqual([
			"test-provider/partial-zero",
			"test-provider/cheap",
			"test-provider/tie-a",
			"test-provider/tie-b",
			"test-provider/middle",
		]);
		expect(compact.total).toBe(7);
		expect(compact.nextOffset).toBe(5);
		expect(Object.keys(compact.models[0])).toEqual(["id", "reasoningEfforts", "contextWindow", "cost"]);
		expect(Object.keys(compact.models[0].cost)).toEqual(["input", "output", "cacheRead"]);
		expect(compact.models[0].reasoningEfforts).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
		expect(compact.note).toContain("USD rates per million tokens");
		expect(compact.note).toContain("unknown, not free");
		expect(output(await search(registered, { limit: 100 })).models.map((entry) => entry.id)).toEqual([
			"test-provider/partial-zero",
			"test-provider/cheap",
			"test-provider/tie-a",
			"test-provider/tie-b",
			"test-provider/middle",
			"test-provider/unknown-a",
			"test-provider/unknown-b",
		]);
		expect(result.content[0].type === "text" && result.content[0].text).not.toContain("\n");

		const details = result.details as { models: Array<Record<string, unknown>> };
		expect(details.models[0]).toMatchObject({
			modelId: "partial-zero",
			name: "Known low",
			input: ["text"],
			maxTokens: 4_096,
		});
		expect(details.models[0].cost).toEqual({ input: 0, output: 0.02, cacheRead: 0.01, cacheWrite: 0.2 });
	});

	it("uses deterministic name and id tie breaks for explicit sorting", async () => {
		const models = [
			model("tie-b", { name: "Beta", cost: cost(1, 1) }),
			model("tie-a", { name: "Beta", cost: cost(1, 1) }),
			model("same-name-b", { name: "Alpha", cost: cost(1, 1) }),
			model("same-name-a", { name: "Alpha", cost: cost(1, 1) }),
		];
		const registered = registerSearch(model("parent"), models);

		expect(output(await search(registered, { sort: "name", limit: 100 })).models.map((entry) => entry.id)).toEqual([
			"test-provider/same-name-a",
			"test-provider/same-name-b",
			"test-provider/tie-a",
			"test-provider/tie-b",
		]);
		expect(output(await search(registered, { sort: "cost", limit: 100 })).models.map((entry) => entry.id)).toEqual([
			"test-provider/same-name-a",
			"test-provider/same-name-b",
			"test-provider/tie-a",
			"test-provider/tie-b",
		]);
	});

	it("supports case-insensitive query, pagination, and the 100-model limit", async () => {
		const models = Array.from({ length: 20 }, (_, index) =>
			model(`model-${index}`, {
				name: index === 12 ? "Target Display Name" : `Fixture ${String(index).padStart(2, "0")}`,
				cost: cost(index + 1, index + 1),
			}),
		);
		const registered = registerSearch(model("parent"), models);

		const queried = output(await search(registered, { query: "TARGET DISPLAY", limit: 100 }));
		expect(queried.total).toBe(1);
		expect(queried.models.map((entry) => entry.id)).toEqual(["test-provider/model-12"]);

		const page = output(await search(registered, { sort: "name", limit: 3, offset: 4 }));
		expect(page.total).toBe(20);
		expect(page.models.map((entry) => entry.id)).toEqual([
			"test-provider/model-4",
			"test-provider/model-5",
			"test-provider/model-6",
		]);
		expect(page.nextOffset).toBe(7);
		expect(output(await search(registered, { limit: 100 })).models).toHaveLength(20);
	});

	it("returns full model metadata when detail is full", async () => {
		const modelWithTier = model("tiered", {
			name: "Tiered Model",
			cost: {
				...cost(1, 2),
				tiers: [{ inputTokensAbove: 10_000, input: 0.5, output: 1, cacheRead: 0.01, cacheWrite: 0.1 }],
			},
		});
		const registered = registerSearch(model("parent"), [modelWithTier]);
		const result = await search(registered, { detail: "full" });
		const full = output(result);

		expect(full.models[0]).toMatchObject({
			id: "test-provider/tiered",
			modelId: "tiered",
			name: "Tiered Model",
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 4_096,
			cost: { input: 1, output: 2, cacheRead: 0.01, cacheWrite: 0.2 },
		});
		expect(full.models[0].cost).toMatchObject({ tiers: [{ inputTokensAbove: 10_000 }] });
		expect(result.content[0].type === "text" && result.content[0].text).not.toContain("\n");
		expect((result.details as { models: unknown[] }).models).toEqual(full.models);
	});

	it("keeps default compact output much smaller than the former 20-entry full result", async () => {
		const models = Array.from({ length: 20 }, (_, index) =>
			model(`representative-model-${index}`, {
				name: `Representative configured chat model ${index}`,
				cost: cost(index + 1, (20 - index) * 0.5),
			}),
		);
		const registered = registerSearch(model("parent"), models);
		const compactResult = await search(registered);
		const compactContent = compactResult.content[0];
		if (compactContent?.type !== "text") throw new Error("search_models returned no text result");
		const compactBytes = Buffer.byteLength(compactContent.text);
		const oldFullResult = await search(registered, { detail: "full", limit: 20 });
		const full = output(oldFullResult);
		const previousTwentyFullEntries = JSON.stringify(full, null, 2);

		expect(Buffer.byteLength(previousTwentyFullEntries)).toBeGreaterThan(compactBytes * 3);
	});

	it("uses the parent's ordinary or pinned provider scope and permits an explicit route", async () => {
		const ordinary = model("ordinary-model", { provider: "ordinary-provider" });
		const pinned = model("pinned-model", { provider: "acct:pinned-account" });
		const explicit = model("explicit-model", { provider: "other-provider" });
		const models = [ordinary, pinned, explicit];

		const ordinaryResult = output(await search(registerSearch(ordinary, models)));
		expect(ordinaryResult.provider).toBe("ordinary-provider");
		expect(ordinaryResult.models.map((entry) => entry.id)).toEqual(["ordinary-provider/ordinary-model"]);

		const pinnedResult = output(await search(registerSearch(pinned, models)));
		expect(pinnedResult.provider).toBe("acct:pinned-account");
		expect(pinnedResult.models.map((entry) => entry.id)).toEqual(["acct:pinned-account/pinned-model"]);

		const explicitResult = output(await search(registerSearch(ordinary, models), { provider: "other-provider" }));
		expect(explicitResult.provider).toBe("other-provider");
		expect(explicitResult.models.map((entry) => entry.id)).toEqual(["other-provider/explicit-model"]);
	});

	it.each(["codex", "claude", "all"])("uses the account reported by the broker for pool:%s", async (pool) => {
		const serving = model("served-model", { provider: "acct:serving-account" });
		const poolModel = model("served-model", { provider: `pool:${pool}` });
		writeFileSync(
			join(agentDir, "accounts", "catalog.json"),
			JSON.stringify({
				version: 2,
				accounts: [{ id: "serving-account", key: "serving-key", provider: "codex", disabled: false, models: [] }],
				pools: [],
			}),
		);
		const registered = registerSearch(poolModel, [poolModel, serving]);
		await establishPoolAccount(registered, "serving-key");

		const current = output(await search(registered));
		expect(current.provider).toBe("acct:serving-account");
		expect(current.models.map((entry) => entry.id)).toEqual(["acct:serving-account/served-model"]);

		const unknown = registerSearch(poolModel, [poolModel, serving]);
		await expect(search(unknown)).rejects.toThrow(/serving account is unknown/i);
		const explicit = output(await search(unknown, { provider: "acct:serving-account" }));
		expect(explicit.provider).toBe("acct:serving-account");
	});
});
