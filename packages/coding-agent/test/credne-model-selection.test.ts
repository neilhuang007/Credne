import { type Api, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { type AutocompleteProvider, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as configSource from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	findInitialModel,
	getExactModelSelectionMatches,
	resolveCliModel,
	resolveModelScopeFromModels,
} from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createTestResourceLoader } from "./utilities.ts";

vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof configSource>()),
	USES_BROKER_AUTH: true,
}));

const sol = "gpt-6.2-sol";
const olderSol = "gpt-6.1-sol";
const globalPool = "pool:all";
const codexPool = "pool:codex";
const account = "acct:codex-work";
const local = "llama.cpp";
const shared = "shared-model";
const astra = "gpt-6.2-astra";

function model(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9421/v1",
		input: ["text"],
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

let runtime: ModelRuntime;

function registerRoute(provider: string, ids: readonly string[]) {
	runtime.registerNativeProvider(
		createProvider({
			id: provider,
			models: ids.map((id) => model(provider, id)),
			api: openAICompletionsApi(),
			auth: {
				apiKey: {
					name: "Faux",
					check: async () => ({ type: "api_key", source: "test" }),
					resolve: async () => ({ auth: {}, source: "test" }),
				},
			},
		}),
		provider === local ? "builtin:llama.cpp" : "builtin:accounts",
	);
}

beforeEach(async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	for (const [provider, ids] of [
		[account, [sol]],
		["acct:openai-metered", [sol]],
		[codexPool, [sol]],
		["pool:openai", [sol]],
		["pool:alpha", [shared]],
		["pool:beta", [shared]],
		[globalPool, [sol, olderSol, "vendor/qualified-id:tag"]],
		[local, ["local-model"]],
	] as const) {
		registerRoute(provider, ids);
	}
	await runtime.refresh({ allowNetwork: false });
});

async function newSession(options: { scoped?: boolean; sessionManager?: SessionManager; model?: Model<Api> } = {}) {
	return createAgentSession({
		modelRuntime: runtime,
		model: options.model,
		resourceLoader: createTestResourceLoader(),
		sessionManager: options.sessionManager ?? SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
		scopedModels: options.scoped ? [{ model: runtime.getModel(account, sol)! }] : undefined,
	});
}

function makePicker(session: AgentSession, search?: string) {
	const onSelect = vi.fn();
	const selector = new ModelSelectorComponent(
		{ requestRender: () => {} } as unknown as TUI,
		session.model,
		runtime,
		session.scopedModels,
		onSelect,
		() => {},
		search,
	);
	return { selector, onSelect, render: () => stripAnsi(selector.render(120).join("\n")) };
}

type ModelCommandContext = {
	session: AgentSession;
	footer: { invalidate: () => void };
	findExactModelMatch: (searchTerm: string) => Promise<Model<Api> | undefined>;
	showModelSelector: (searchTerm?: string) => void;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	updateEditorBorderColor: () => void;
	maybeWarnAboutAnthropicSubscriptionAuth: () => void;
};

type AutocompleteContext = {
	session: AgentSession;
	settingsManager: { getEnableSkillCommands: () => boolean };
	skillCommands: Map<string, string>;
	sessionManager: { getCwd: () => string };
	fdPath: null;
};

const interactive = InteractiveMode.prototype as unknown as {
	findExactModelMatch: ModelCommandContext["findExactModelMatch"];
	handleModelCommand(this: ModelCommandContext, searchTerm: string): Promise<void>;
	createBaseAutocompleteProvider(this: AutocompleteContext): AutocompleteProvider;
};

async function modelCompletions(session: AgentSession, prefix: string): Promise<string[]> {
	const context: AutocompleteContext = {
		session,
		settingsManager: { getEnableSkillCommands: () => false },
		skillCommands: new Map(),
		sessionManager: { getCwd: () => process.cwd() },
		fdPath: null,
	};
	const text = `/model ${prefix}`;
	const suggestions = await interactive.createBaseAutocompleteProvider
		.call(context)
		.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
	return suggestions?.items.map((item) => item.value) ?? [];
}

function modelCommand(session: AgentSession) {
	const context: ModelCommandContext = {
		session,
		footer: { invalidate: vi.fn() },
		findExactModelMatch: interactive.findExactModelMatch,
		showModelSelector: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
	};
	return { context, run: (query: string) => interactive.handleModelCommand.call(context, query) };
}

describe("Credne model picker", () => {
	it("shows one selectable global row per model, alongside local and conflicting family options", async () => {
		const { session } = await newSession();
		const { selector, render } = makePicker(session);
		try {
			const output = render();
			expect(output).not.toMatch(/\[acct:|\[pool:codex\]|\[pool:openai\]/);
			expect(output.match(/gpt-6\.2-sol \[/g)).toHaveLength(1);
			expect(output).toContain(`${sol} [${globalPool}]`);
			expect(output).toContain(`${shared} [pool:alpha]`);
			expect(output).toContain(`${shared} [pool:beta]`);
			expect(output).toContain("local-model [llama.cpp]");
		} finally {
			selector.dispose();
			session.dispose();
		}
	});

	it("shows the pinned account's rows in place of the pool rows it serves, and keeps the other choices", async () => {
		const { session } = await newSession({ model: runtime.getModel(account, sol) });
		const { selector, render, onSelect } = makePicker(session);
		const other = makePicker(session, olderSol);
		try {
			const output = render();
			expect(output).toContain(`✓ ${sol} [${account}]`);
			expect(output).not.toContain(`${sol} [${globalPool}]`);
			expect(output).not.toMatch(/\[acct:openai-metered\]|\[pool:codex\]|\[pool:openai\]/);
			expect(output).toContain(`${olderSol} [${globalPool}]`);
			expect(output).toContain(`${shared} [pool:alpha]`);
			expect(output).toContain("local-model [llama.cpp]");
			selector.handleInput("\r");
			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ provider: account, id: sol }));
			// A row the account does not serve is the way off the pin.
			other.selector.handleInput("\r");
			expect(other.onSelect).toHaveBeenCalledWith(expect.objectContaining({ provider: globalPool, id: olderSol }));
		} finally {
			selector.dispose();
			other.selector.dispose();
			session.dispose();
		}
	});

	it("ranks an exact ID or alias above older IDs in search results", async () => {
		const { session } = await newSession({ model: runtime.getModel(globalPool, olderSol) });
		try {
			for (const search of ["SOL", sol]) {
				const { selector, onSelect } = makePicker(session, search);
				selector.handleInput("\r");
				expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ provider: globalPool, id: sol }));
			}
		} finally {
			session.dispose();
		}
	});

	it("starts in the pinned scope instead of replacing it with the wider global route", async () => {
		const { session } = await newSession({ scoped: true });
		const { selector, render, onSelect } = makePicker(session, "sol");
		try {
			expect(render()).toContain(`${sol} [${account}]`);
			expect(render()).not.toContain(`[${globalPool}]`);
			selector.handleInput("\r");
			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ provider: account, id: sol }));
		} finally {
			selector.dispose();
			session.dispose();
		}
	});
});

describe("Credne model command", () => {
	it("persists an unqualified alias and exact ID as the canonical pool selection on a pool session", async () => {
		const { session } = await newSession({ model: runtime.getModel(globalPool, olderSol) });
		try {
			const { context, run } = modelCommand(session);
			for (const query of ["sOL", sol]) {
				await run(query);
				expect(context.showError).not.toHaveBeenCalled();
				expect(context.showModelSelector).not.toHaveBeenCalled();
				expect(session.model).toMatchObject({ provider: globalPool, id: sol });
				expect(session.settingsManager.getDefaultProvider()).toBe(globalPool);
				expect(session.settingsManager.getDefaultModel()).toBe(sol);
				expect(session.sessionManager.getEntries().findLast(({ type }) => type === "model_change")).toMatchObject({
					provider: globalPool,
					modelId: sol,
				});
			}
		} finally {
			session.dispose();
		}
	});

	it("keeps a pinned account for an unqualified alias and exact ID, and persists it", async () => {
		const { session } = await newSession({ model: runtime.getModel(account, sol) });
		try {
			const { context, run } = modelCommand(session);
			for (const query of ["sOL", sol]) {
				await run(query);
				expect(context.showError).not.toHaveBeenCalled();
				expect(context.showModelSelector).not.toHaveBeenCalled();
				expect(session.model).toMatchObject({ provider: account, id: sol });
				expect(session.settingsManager.getDefaultProvider()).toBe(account);
				expect(session.settingsManager.getDefaultModel()).toBe(sol);
				expect(session.sessionManager.getEntries().findLast(({ type }) => type === "model_change")).toMatchObject({
					provider: account,
					modelId: sol,
				});
			}
		} finally {
			session.dispose();
		}
	});

	it("leaves the pin for an ID or alias the account does not serve and for an explicit pool", async () => {
		registerRoute(globalPool, [sol, olderSol, astra]);
		await runtime.refresh({ allowNetwork: false });
		for (const [query, id] of [
			[olderSol, olderSol],
			["astra", astra],
			[`${globalPool}/${sol}`, sol],
		]) {
			const { session } = await newSession({ model: runtime.getModel(account, sol) });
			try {
				await modelCommand(session).run(query);
				expect(session.model).toMatchObject({ provider: globalPool, id });
				expect(session.settingsManager.getDefaultProvider()).toBe(globalPool);
			} finally {
				session.dispose();
			}
		}
	});

	it("completes only the pinned account's rows for the IDs it serves", async () => {
		const { session: pinned } = await newSession({ model: runtime.getModel(account, sol) });
		const { session: pooled } = await newSession();
		try {
			const pinnedValues = await modelCompletions(pinned, "sol");
			expect(pinnedValues[0]).toBe(`${account}/${sol}`);
			expect(pinnedValues).toContain(`${globalPool}/${olderSol}`);
			expect(pinnedValues).not.toContain(`${globalPool}/${sol}`);
			const pooledValues = await modelCompletions(pooled, "sol");
			expect(pooledValues[0]).toBe(`${globalPool}/${sol}`);
			expect(pooledValues.filter((value) => value.startsWith("acct:"))).toEqual([]);
		} finally {
			pinned.dispose();
			pooled.dispose();
		}
	});

	it("shows a choice for an ambiguous ID and accepts explicit account and family pins", async () => {
		const { session } = await newSession();
		try {
			const { context, run } = modelCommand(session);
			await run(shared);
			expect(context.showModelSelector).toHaveBeenCalledWith(shared);
			expect(session.settingsManager.getDefaultProvider()).toBeUndefined();
			await run(`POOL:BETA/${shared}`);
			expect(session.model).toMatchObject({ provider: "pool:beta", id: shared });
			await run(`${account}/sol`);
			expect(session.model).toMatchObject({ provider: account, id: sol });
		} finally {
			session.dispose();
		}
	});

	it("does not widen a scope on a bare alias or a qualified reference outside it", async () => {
		const { session } = await newSession({ scoped: true });
		try {
			const { context, run } = modelCommand(session);
			await run("sol");
			expect(session.model).toMatchObject({ provider: account, id: sol });
			await run(`${globalPool}/${sol}`);
			expect(context.showModelSelector).toHaveBeenCalledWith(`${globalPool}/${sol}`);
			expect(session.scopedModels).toEqual([{ model: session.model }]);
			expect(session.settingsManager.getDefaultProvider()).toBe(account);
		} finally {
			session.dispose();
		}
	});
});

describe("Credne CLI model selection", () => {
	it("resolves exact IDs, aliases, namespaced IDs, thinking suffixes, and local models", () => {
		for (const [cliModel, provider, id, thinkingLevel] of [
			[sol, globalPool, sol, undefined],
			["SOL:high", globalPool, sol, "high"],
			["vendor/qualified-id:tag", globalPool, "vendor/qualified-id:tag", undefined],
			["local-model", local, "local-model", undefined],
		] as const) {
			const result = resolveCliModel({ cliModel, modelRuntime: runtime });
			expect(result.error).toBeUndefined();
			expect(result.model).toMatchObject({ provider, id });
			expect(result.thinkingLevel).toBe(thinkingLevel);
		}
	});

	it("requires a family for conflicting IDs and preserves qualified pins", () => {
		const ambiguous = resolveCliModel({ cliModel: shared, modelRuntime: runtime });
		expect(ambiguous.model).toBeUndefined();
		expect(ambiguous.error).toContain(`pool:alpha/${shared}, pool:beta/${shared}`);
		expect(resolveCliModel({ cliModel: `pool:beta/${shared}`, modelRuntime: runtime }).model?.provider).toBe(
			"pool:beta",
		);
		expect(resolveCliModel({ cliModel: `${codexPool}/sol`, modelRuntime: runtime }).model?.provider).toBe(codexPool);
		expect(resolveCliModel({ cliModel: "sol", cliProvider: account, modelRuntime: runtime }).model?.provider).toBe(
			account,
		);
		expect(resolveCliModel({ cliModel: `${globalPool}/${shared}`, modelRuntime: runtime }).model).toBeUndefined();
	});

	it("uses canonical bare scope patterns without broadening explicit account and family scopes", () => {
		const models = runtime.getAvailableSnapshot();
		const bare = resolveModelScopeFromModels([sol, "vendor/qualified-id:tag"], models);
		expect(bare.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)).toEqual([
			`${globalPool}/${sol}`,
			`${globalPool}/vendor/qualified-id:tag`,
		]);
		expect(bare.diagnostics).toEqual([]);
		const ambiguous = resolveModelScopeFromModels([shared], models);
		expect(ambiguous.scopedModels).toEqual([]);
		expect(ambiguous.diagnostics[0]?.code).toBe("ambiguous");
		const { scopedModels } = resolveModelScopeFromModels(["acct:codex-*/*", `${codexPool}/*`], models);
		expect(scopedModels.map(({ model }) => model.provider)).toEqual([account, codexPool]);
		const scoped = resolveCliModel({
			cliModel: "sol",
			scopedModels: scopedModels.slice(0, 1),
			modelRuntime: runtime,
		});
		expect(scoped.model).toMatchObject({ provider: account, id: sol });
	});
});

describe("Credne startup selection on a pinned account", () => {
	it("resolves a bare ID or alias to the saved account for the IDs it serves", () => {
		for (const [cliModel, provider, id, thinkingLevel] of [
			[sol, account, sol, undefined],
			["SOL:high", account, sol, "high"],
			[olderSol, globalPool, olderSol, undefined],
			["vendor/qualified-id:tag", globalPool, "vendor/qualified-id:tag", undefined],
			["local-model", local, "local-model", undefined],
			[`${globalPool}/${sol}`, globalPool, sol, undefined],
		] as const) {
			const result = resolveCliModel({ cliModel, defaultProvider: account, modelRuntime: runtime });
			expect(result.error).toBeUndefined();
			expect(result.model).toMatchObject({ provider, id });
			expect(result.thinkingLevel).toBe(thinkingLevel);
		}
		expect(
			resolveCliModel({ cliModel: sol, defaultProvider: globalPool, modelRuntime: runtime }).model,
		).toMatchObject({
			provider: globalPool,
		});
		expect(resolveCliModel({ cliModel: shared, defaultProvider: account, modelRuntime: runtime }).error).toContain(
			"ambiguous",
		);
	});

	it("keeps bare scope patterns on the saved account for the IDs it serves", () => {
		const models = runtime.getAvailableSnapshot();
		const { scopedModels, diagnostics } = resolveModelScopeFromModels(
			[sol, "vendor/qualified-id:tag", "*sol*"],
			models,
			account,
		);
		expect(scopedModels.map(({ model }) => `${model.provider}/${model.id}`)).toEqual([
			`${account}/${sol}`,
			`${globalPool}/vendor/qualified-id:tag`,
			`${globalPool}/${olderSol}`,
		]);
		expect(diagnostics).toEqual([]);
	});

	it("falls back to the saved account's first model, not the global pool", async () => {
		const options = { scopedModels: [], isContinuing: false, defaultModelId: "missing-model", modelRuntime: runtime };
		expect((await findInitialModel({ ...options, defaultProvider: account })).model).toMatchObject({
			provider: account,
			id: sol,
		});
		expect((await findInitialModel({ ...options, defaultProvider: "acct:removed" })).model?.provider).toBe(
			globalPool,
		);
	});
});

describe("Credne pinned account resolution", () => {
	it("answers an alias from the pinned account before another family target only the pool serves", () => {
		const models = [
			model(account, "gemini-3.8-flash"),
			model(globalPool, "deepseek-flash"),
			model(globalPool, "gemini-3.8-flash"),
		];
		expect(getExactModelSelectionMatches("flash", models, "all", account)).toEqual([models[0]]);
		expect(getExactModelSelectionMatches("flash", models, "all")).toEqual([models[1]]);
		expect(getExactModelSelectionMatches("deepseek-flash", models, "all", account)).toEqual([models[1]]);
	});

	it("does not pin for a pool provider or a scoped list", () => {
		const models = runtime.getAvailableSnapshot();
		expect(getExactModelSelectionMatches("sol", models, "all", globalPool)).toMatchObject([{ provider: globalPool }]);
		const scoped = [runtime.getModel(globalPool, sol)!];
		expect(getExactModelSelectionMatches("sol", scoped, "scoped", account)).toEqual(scoped);
	});
});

describe("Credne session selection", () => {
	it("cycles from the pinned account's row, then through the other choices", async () => {
		const { session } = await newSession({ model: runtime.getModel(account, sol) });
		try {
			const forward = await session.cycleModel("forward", { persist: true });
			expect(forward?.model).toMatchObject({ provider: globalPool, id: olderSol });
			expect(session.settingsManager.getDefaultProvider()).toBe(globalPool);
			const back = await session.cycleModel("backward");
			expect(back?.model).toMatchObject({ provider: globalPool, id: sol });
		} finally {
			session.dispose();
		}
	});

	it("defaults and cycles through global models and local models, never physical accounts", async () => {
		const { session } = await newSession();
		try {
			expect(session.model).toMatchObject({ provider: globalPool, id: sol });
			const cycled = await session.cycleModel("forward", { persist: true });
			expect(cycled?.model).toMatchObject({ provider: globalPool, id: olderSol });
			expect(session.settingsManager.getDefaultProvider()).toBe(globalPool);
			expect(session.settingsManager.getDefaultModel()).toBe(olderSol);
			const next = await session.cycleModel();
			expect(next?.model.provider).toBe(globalPool);
			const afterGlobal = await session.cycleModel();
			expect(afterGlobal?.model.provider).toBe(local);
		} finally {
			session.dispose();
		}
	});

	it("records a global override on resume and continues to restore explicit pins", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sessionManager.appendModelChange(account, sol);
		const { session: pinned } = await newSession({ sessionManager });
		expect(pinned.model).toMatchObject({ provider: account, id: sol });
		pinned.dispose();
		const { session: global } = await newSession({ sessionManager, model: runtime.getModel(globalPool, sol) });
		expect(global.model).toMatchObject({ provider: globalPool, id: sol });
		global.dispose();
		const { session: resumed } = await newSession({ sessionManager });
		expect(resumed.model).toMatchObject({ provider: globalPool, id: sol });
		resumed.dispose();
	});

	it("restores within the existing account scope when a saved model is unavailable", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sessionManager.appendModelChange(account, "missing-model");
		const { session, modelFallbackMessage } = await newSession({ scoped: true, sessionManager });
		expect(session.model).toMatchObject({ provider: account, id: sol });
		expect(modelFallbackMessage).toContain(`${account}/${sol}`);
		session.dispose();
	});
});
