import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	type Api,
	type AssistantMessage,
	type ClassifierContext,
	createModels,
	type Model,
	normalizeContext,
	type Provider,
} from "@earendil-works/pi-ai";
import { getBuiltinClassifierModel } from "@earendil-works/pi-ai/providers/all";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type AccountCatalog,
	accountDisplayName,
	BROKER_PLACEHOLDER_URL,
	buildCatalog,
	readCatalog,
	upstreamIdentity,
	writeCatalog,
} from "../src/extensions/accounts/catalog.ts";
import {
	type BrokerAccount,
	BrokerClient,
	type BrokerModel,
	type BrokerProvider,
} from "../src/extensions/accounts/client.ts";
import accountsExtension from "../src/extensions/accounts/index.ts";
import { OMP_NATIVE_API } from "../src/extensions/accounts/omp-native.ts";
import { type AccountProviderSpec, createAccountProvider, providerSpecs } from "../src/extensions/accounts/provider.ts";
import { AccountRegistry } from "../src/extensions/accounts/registry.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { openBrowser } from "../src/utils/open-browser.ts";
import { ompTurn } from "./omp-native-test-utils.ts";

// Sign-in opens the browser; the tests only record the URL.
vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

const TOKEN = "cbk_test_token";
const servers: Server[] = [];
const directories: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-accounts-"));
	directories.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function account(overrides: Partial<BrokerAccount> & Pick<BrokerAccount, "id" | "provider">): BrokerAccount {
	return {
		key: Buffer.from(overrides.id).toString("base64url"),
		kind: "oauth",
		source: "file",
		status: "active",
		disabled: false,
		unavailable: false,
		quotaExceeded: false,
		modelCount: 1,
		...overrides,
	};
}

const claudeA = account({ id: "claude-api-aaaa-a.json", provider: "claude-api", kind: "api-key", label: "a" });
const claudeB = account({ id: "claude-bbbb-b.json", provider: "claude", email: "b@example.com" });
const codexC = account({ id: "codex-cccc-c@example.com-plus.json", provider: "codex", email: "c@example.com" });
const claudeModel: BrokerModel = {
	id: "claude-test-1",
	contextLength: 200_000,
	maxCompletionTokens: 64_000,
	thinking: true,
};
const codexModel: BrokerModel = { id: "gpt-test", thinking: true, inputModalities: ["text", "image"] };
const openaiKey = account({ id: "openai-api-key-luna", provider: "openai-api", kind: "api-key", label: "luna" });
const lunaModel: BrokerModel = { id: "gpt-6-luna", thinking: false, inputModalities: ["text", "image"] };
const typesafeKey = account({ id: "typesafe-key-jev", provider: "typesafe", kind: "api-key", label: "jev" });
/** The broker lists a TypeSafe key's models as classifiers. */
const jevModel: BrokerModel = {
	id: "jev-latest",
	kind: "classifier",
	displayName: "Jev (latest)",
	thinking: false,
	inputModalities: ["text", "image"],
};
/** What the broker reports for each model: the provider and API oh-my-pi resolved on that account. */
const anthropicIdentity = { provider: "anthropic", api: "anthropic-messages" };
const codexIdentity = { provider: "openai-codex", api: "openai-codex-responses" };
const openaiIdentity = { provider: "openai", api: "openai-responses" };
const familiarProviders: BrokerProvider[] = [
	{ id: "anthropic", name: "Anthropic", authMethods: ["api-key", "oauth"] },
	{ id: "openai", name: "OpenAI", authMethods: ["api-key"] },
	{ id: "openai-codex", name: "ChatGPT Codex", authMethods: ["oauth"] },
];
const typesafeProvider: BrokerProvider = { id: "typesafe", name: "TypeSafe", authMethods: ["api-key"] };
/** Pi's built-in classifiers, which accounts take their cost and limits from: Decisions and Jev. */
const builtinLuna = getBuiltinClassifierModel("openai", "gpt-6-luna");
const builtinJev = getBuiltinClassifierModel("typesafe", "jev-latest");
const lookupClassifier = (provider: string, id: string) =>
	[builtinLuna, builtinJev].find((model) => model.provider === provider && model.id === id);

function spec(id: string): AccountProviderSpec {
	const found = providerSpecs(testCatalog()).find((entry) => entry.id === id);
	if (!found) throw new Error(`no provider ${id}`);
	return found;
}

const ACCT_A = "acct:claude-api-aaaa-a";
const ACCT_B = "acct:claude-bbbb-b";
const ACCT_C = "acct:codex-cccc-c@example.com-plus";

function testCatalog(): AccountCatalog {
	return buildCatalog(
		[claudeA, claudeB, codexC],
		new Map([
			[claudeA.key, [claudeModel]],
			[claudeB.key, [claudeModel]],
			[codexC.key, [codexModel]],
		]),
		() => undefined,
	);
}

interface RecordedRequest {
	method: string;
	path: string;
	headers: IncomingMessage["headers"];
	body: string;
}

/** The events oh-my-pi's runtime streams back for a model: Claude calls a tool, GPT answers in text. */
function piNativeTurn(modelId: string): string {
	if (modelId === codexModel.id) {
		return ompTurn({ model: modelId, api: "openai-codex-responses", provider: "openai-codex" })
			.start()
			.text("hello codex")
			.done("stop", { input: 5, output: 2 })
			.sse();
	}
	return ompTurn({ model: modelId })
		.start()
		.thinking("plan", "sig-A")
		.text("Reading it.")
		.toolCall("toolu_1", "read", { path: "a.txt" })
		.done("toolUse", { input: 12, output: 20 })
		.sse();
}

interface FakeResponse {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
}

interface FakeBrokerOptions {
	/** Where the discovery file goes; a new temp directory when omitted. */
	home?: string;
	/** Answers a request before the default routes do; undefined falls through to them. */
	respond?: (request: RecordedRequest) => FakeResponse | undefined;
}

/** A fake broker speaking the credne-broker IPC contract, with a discovery file in a temp home. */
async function startFakeBroker(
	options: FakeBrokerOptions = {},
): Promise<{ home: string; url: string; requests: RecordedRequest[] }> {
	const requests: RecordedRequest[] = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const path = request.url ?? "";
		const recorded: RecordedRequest = { method: request.method ?? "", path, headers: request.headers, body };
		requests.push(recorded);
		const auth = request.headers.authorization ?? `Bearer ${request.headers["x-api-key"] ?? ""}`;
		if (auth !== `Bearer ${TOKEN}`) {
			response.writeHead(401).end(JSON.stringify({ error: "missing or invalid broker token" }));
			return;
		}
		const custom = options.respond?.(recorded);
		if (custom) {
			response.writeHead(custom.status, { "Content-Type": "application/json", ...custom.headers });
			response.end(JSON.stringify(custom.body));
			return;
		}
		const json = (value: unknown) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(value));
		};
		if (path === "/credne/v1/health") return json({ ok: true, backend: "oh-my-pi" });
		if (path === "/credne/v1/providers") return json({ providers: familiarProviders });
		if (path === "/credne/v1/accounts") return json({ accounts: [claudeA, claudeB, codexC, { id: 7 }] });
		if (path.endsWith("/models")) {
			return json({ models: [path.includes(codexC.key) ? codexModel : claudeModel, { name: "no id" }] });
		}
		const target = /^\/credne\/v1\/route\/a\.([^/]+)\//.exec(path)?.[1];
		if (target) response.setHeader("X-Credne-Account", target);
		if (path.endsWith("/pi/stream")) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(piNativeTurn((JSON.parse(body) as { modelId: string }).modelId));
			return;
		}
		response.writeHead(404).end(JSON.stringify({ error: "not found" }));
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const home = options.home ?? tempDir();
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "broker.json"), JSON.stringify({ schema: 1, pid: process.pid, url, token: TOKEN }));
	return { home, url, requests };
}

function clientFor(home: string): BrokerClient {
	return new BrokerClient({ home, locateBinary: () => undefined });
}

describe("account catalog", () => {
	it("maps each account to a provider whose models use the omp-native API", () => {
		const catalog = testCatalog();
		const specs = providerSpecs(catalog);
		expect(specs.map((entry) => entry.id)).toEqual(["pool:all", "pool:claude", "pool:codex", ACCT_A, ACCT_B, ACCT_C]);
		const [claude] = catalog.accounts[0]!.models;
		expect(claude).toMatchObject({
			id: "claude-test-1",
			api: OMP_NATIVE_API,
			provider: ACCT_A,
			baseUrl: BROKER_PLACEHOLDER_URL,
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		// oh-my-pi builds the provider request, so there are no Pi adapter compatibility flags.
		expect(claude).not.toHaveProperty("compat");
		expect(catalog.accounts[2]!.models[0]).toMatchObject({ api: OMP_NATIVE_API, input: ["text", "image"] });
		expect(catalog.pools.map(({ name, accountCount }) => ({ name, accountCount }))).toEqual([
			{ name: "all", accountCount: 3 },
			{ name: "claude", accountCount: 2 },
			{ name: "codex", accountCount: 1 },
		]);
		expect(spec(ACCT_A).name).toBe("Claude · a (API key)");
		expect(spec(ACCT_B).name).toBe("Claude · b@example.com (subscription)");
		expect(spec("pool:codex").name).toBe("ChatGPT Codex pool (1 account)");
	});

	it("restores Claude subscriptions and pools while ignoring obsolete Console accounts in the cache", () => {
		const catalog = testCatalog();
		const path = join(tempDir(), "catalog.json");
		writeCatalog(path, {
			version: 3,
			accounts: [...catalog.accounts, { ...catalog.accounts[0]!, id: "console", kind: "api-credits" }],
			pools: catalog.pools.filter((pool) => pool.name === "codex"),
		});
		expect(readCatalog(path)).toEqual(catalog);
	});

	it("ignores a catalog file from before the omp-native API, whose models name APIs no provider serves", () => {
		const path = join(tempDir(), "catalog.json");
		writeCatalog(path, testCatalog());
		const stale = JSON.parse(readFileSync(path, "utf8")) as { version: number };
		writeFileSync(path, JSON.stringify({ ...stale, version: 2 }));
		expect(readCatalog(path).accounts).toEqual([]);
	});

	it("reuses Pi's catalog metadata for known models", () => {
		const known: Model<"anthropic-messages"> = {
			id: "claude-test-1",
			name: "Claude Test",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			thinkingLevelMap: { xhigh: "xhigh" },
			compat: { supportsMidConvoSystemMessages: true, supportsStrictTools: true },
		};
		const catalog = buildCatalog([claudeA], new Map([[claudeA.key, [claudeModel]]]), (provider, id) =>
			provider === "anthropic" && id === known.id ? known : undefined,
		);
		expect(catalog.accounts[0]!.models[0]).toMatchObject({
			name: "Claude Test",
			cost: known.cost,
			contextWindow: 1_000_000,
			thinkingLevelMap: { xhigh: "xhigh" },
		});
		// Pi's adapter flags describe Pi's own request; oh-my-pi builds this one.
		expect(catalog.accounts[0]!.models[0]).not.toHaveProperty("compat");
	});

	it("omits incompatible exact IDs from the global pool without losing family and pinned models", () => {
		const thirdParty = account({ id: "openrouter-a", provider: "openrouter" });
		const directModel = { ...codexModel, id: "direct-model", displayName: "Same label" };
		const routedModel = { ...codexModel, id: "routed-model", displayName: "Same label" };
		const models = new Map([
			[claudeA.key, [claudeModel]],
			[codexC.key, [codexModel, directModel]],
			[thirdParty.key, [codexModel, routedModel]],
		]);
		const catalog = buildCatalog([claudeA, codexC, thirdParty], models, () => undefined);
		const byProvider = new Map(providerSpecs(catalog).map((spec) => [spec.id, spec.models.map((model) => model.id)]));
		expect(byProvider.get("pool:all")).toEqual([claudeModel.id, directModel.id, routedModel.id]);
		expect(byProvider.get("pool:codex")).toEqual([codexModel.id, directModel.id]);
		expect(byProvider.get("pool:openrouter")).toEqual([codexModel.id, routedModel.id]);
		expect(byProvider.get(ACCT_C)).toEqual([codexModel.id, directModel.id]);
		expect(byProvider.get(`acct:${thirdParty.id}`)).toEqual([codexModel.id, routedModel.id]);

		const disabled = buildCatalog([codexC, { ...thirdParty, disabled: true }], models, () => undefined);
		expect(disabled.pools.find((entry) => entry.name === "all")?.models.map((model) => model.id)).toEqual([
			codexModel.id,
			directModel.id,
		]);
		const path = join(tempDir(), "catalog.json");
		writeCatalog(path, catalog);
		expect(readCatalog(path)).toEqual(catalog);
	});

	it.each([
		{ name: "OpenAI", subscription: codexC, apiKey: openaiKey },
		{
			name: "xAI",
			subscription: account({ id: "grok-sub", provider: "xai-oauth" }),
			apiKey: account({ id: "grok-key", provider: "xai", kind: "api-key" }),
		},
	])("merges compatible routes for $name into a global model with shared limits", ({ subscription, apiKey }) => {
		const premium: BrokerModel = {
			id: "shared",
			kind: "chat",
			thinking: true,
			thinkingLevels: ["low", "high", "xhigh"],
			contextLength: 200_000,
			maxCompletionTokens: 30_000,
			inputModalities: ["text", "image"],
		};
		const base: BrokerModel = {
			...premium,
			thinkingLevels: ["low", "high"],
			contextLength: 128_000,
			maxCompletionTokens: 20_000,
			inputModalities: ["text"],
		};
		const models = new Map([
			[subscription.key, [premium]],
			[apiKey.key, [base]],
		]);
		const catalog = buildCatalog([subscription, apiKey], models, () => undefined);
		expect(catalog.pools.find((pool) => pool.name === "all")?.models).toEqual([
			expect.objectContaining({
				id: "shared",
				api: OMP_NATIVE_API,
				contextWindow: 128_000,
				maxTokens: 20_000,
				thinkingLevelMap: expect.objectContaining({ low: "low", high: "high", xhigh: null }),
				input: ["text"],
			}),
		]);
		expect(catalog.accounts[0]?.models[0]).toMatchObject({
			contextWindow: 200_000,
			maxTokens: 30_000,
			thinkingLevelMap: { xhigh: "xhigh" },
			input: ["text", "image"],
		});
	});

	it("uses the exact source provider for Pi metadata, with broker metadata for new models", () => {
		const grok = account({ id: "grok-work", provider: "xai" });
		const cost = { input: 1, output: 5, cacheRead: 0.25, cacheWrite: 1 };
		const known: Model<"openai-completions"> = {
			id: "shared",
			name: "Known Grok",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://test.example",
			reasoning: false,
			input: ["text"],
			contextWindow: 50_000,
			maxTokens: 4_000,
			cost,
			promptCache: { short: 300 },
		};
		const catalog = buildCatalog(
			[grok],
			new Map([
				[
					grok.key,
					[
						{ id: known.id, thinking: false },
						{
							id: "new",
							displayName: "New Grok",
							thinking: false,
							contextLength: 96_000,
							maxCompletionTokens: 8_000,
							cost,
						},
					],
				],
			]),
			(provider, id) => (provider === "xai" && id === known.id ? known : undefined),
		);
		expect(catalog.accounts[0]?.models).toEqual([
			expect.objectContaining({
				name: known.name,
				contextWindow: known.contextWindow,
				cost,
				promptCache: { short: 300 },
			}),
			expect.objectContaining({ name: "New Grok", contextWindow: 96_000, maxTokens: 8_000, cost }),
		]);
	});

	describe("oh-my-pi identity", () => {
		const identified = (model: BrokerModel, identity: { provider: string; api: string }): BrokerModel => ({
			...model,
			...identity,
		});
		const gptOnCodex = identified(codexModel, codexIdentity);
		const gptOnKey = { ...identified(codexModel, openaiIdentity), kind: "chat" as const };
		const claude = identified(claudeModel, anthropicIdentity);

		function catalogOf(entries: [BrokerAccount, BrokerModel[]][]): AccountCatalog {
			return buildCatalog(
				entries.map(([entry]) => entry),
				new Map(entries.map(([entry, models]) => [entry.key, models])),
				() => undefined,
			);
		}
		const poolUpstream = (catalog: AccountCatalog, name: string) =>
			catalog.pools.find((pool) => pool.name === name)?.upstream;

		it("is kept per account model, and per pool model that every serving account agrees on", () => {
			const catalog = catalogOf([
				[claudeA, [claude]],
				[claudeB, [claude]],
				[codexC, [gptOnCodex]],
				[openaiKey, [gptOnKey]],
			]);

			expect(catalog.accounts.map((entry) => entry.upstream)).toEqual([
				{ "claude-test-1": anthropicIdentity },
				{ "claude-test-1": anthropicIdentity },
				{ "gpt-test": codexIdentity },
				{ "gpt-test": openaiIdentity },
			]);
			expect(poolUpstream(catalog, "claude")).toEqual({ "claude-test-1": anthropicIdentity });
			expect(poolUpstream(catalog, "codex")).toEqual({ "gpt-test": codexIdentity });
			expect(poolUpstream(catalog, "openai")).toEqual({ "gpt-test": openaiIdentity });
			// pool:all serves gpt-test through a ChatGPT subscription or an OpenAI key; it cannot tell which answers.
			expect(catalog.pools.find((pool) => pool.name === "all")?.models.map((model) => model.id)).toContain(
				"gpt-test",
			);
			expect(poolUpstream(catalog, "all")).toEqual({ "claude-test-1": anthropicIdentity });
		});

		it("is not kept for a pool model when an account serving it reports none", () => {
			const catalog = catalogOf([
				[claudeA, [claude]],
				[claudeB, [claudeModel]],
			]);
			expect(catalog.accounts.map((entry) => entry.upstream)).toEqual([
				{ "claude-test-1": anthropicIdentity },
				undefined,
			]);
			expect(poolUpstream(catalog, "claude")).toBeUndefined();
			expect(poolUpstream(catalog, "all")).toBeUndefined();
		});

		it("round-trips through the catalog file, and a file without identities has none", () => {
			const catalog = catalogOf([
				[claudeA, [claude]],
				[codexC, [gptOnCodex]],
				[openaiKey, [gptOnKey]],
			]);
			const path = join(tempDir(), "catalog.json");
			writeCatalog(path, catalog);
			expect(readCatalog(path)).toEqual(catalog);
			expect(readCatalog(path).pools.map((pool) => [pool.name, pool.upstream])).toEqual(
				catalog.pools.map((pool) => [pool.name, pool.upstream]),
			);

			const legacy = JSON.parse(readFileSync(path, "utf8")) as AccountCatalog;
			for (const entry of legacy.accounts) delete entry.upstream;
			for (const entry of legacy.pools) delete entry.upstream;
			writeFileSync(path, JSON.stringify(legacy));
			const read = readCatalog(path);
			expect(read.accounts.map((entry) => entry.upstream)).toEqual([undefined, undefined, undefined]);
			expect(read.pools.map((entry) => entry.upstream)).toEqual([undefined, undefined, undefined, undefined]);
		});

		it("drops entries of a catalog file that are malformed or not its own", () => {
			const catalog = catalogOf([[claudeA, [claude]]]);
			const path = join(tempDir(), "catalog.json");
			writeCatalog(path, catalog);
			const edited = JSON.parse(readFileSync(path, "utf8")) as AccountCatalog;
			edited.accounts[0]!.upstream = {
				ok: anthropicIdentity,
				missingApi: { provider: "anthropic" },
				notAnObject: "anthropic",
				nothing: null,
			} as never;
			writeFileSync(path, JSON.stringify(edited));
			expect(readCatalog(path).accounts[0]!.upstream).toEqual({ ok: anthropicIdentity });
			edited.accounts[0]!.upstream = "anthropic" as never;
			writeFileSync(path, JSON.stringify(edited));
			expect(readCatalog(path).accounts[0]!.upstream).toBeUndefined();
		});

		it("does not take an inherited property for a model ID", () => {
			const catalog = catalogOf([[claudeA, [claude]]]);
			const [specA] = providerSpecs(catalog).filter((entry) => entry.id === ACCT_A);
			expect(upstreamIdentity(specA!.upstream, "claude-test-1")).toEqual(anthropicIdentity);
			expect(upstreamIdentity(specA!.upstream, "constructor")).toBeUndefined();
			expect(upstreamIdentity(specA!.upstream, "__proto__")).toBeUndefined();
			expect(upstreamIdentity(undefined, "claude-test-1")).toBeUndefined();
		});
	});

	it("round-trips through the catalog file and ignores unreadable files", () => {
		const path = join(tempDir(), "accounts", "catalog.json");
		expect(readCatalog(path).accounts).toEqual([]);
		writeCatalog(path, testCatalog());
		expect(readCatalog(path)).toEqual(testCatalog());
		writeFileSync(path, "{ not json");
		expect(readCatalog(path).accounts).toEqual([]);
	});

	describe("gpt-6-luna classifier", () => {
		const modelsOf = (...entries: [BrokerAccount, BrokerModel[]][]) =>
			new Map(entries.map(([entry, models]) => [entry.key, models]));
		const catalogFor = (entries: BrokerAccount[], models: Map<string, BrokerModel[]>) =>
			buildCatalog(entries, models, () => undefined, lookupClassifier);

		it("goes to OpenAI API keys that list gpt-6-luna and to pool:openai, on System One with Pi's cost and limits", () => {
			const catalog = catalogFor([openaiKey], modelsOf([openaiKey, [lunaModel]]));
			// Pi's entry describes luna on the Decisions API; the broker route serves it on System One.
			expect(builtinLuna.api).toBe("openai-decisions");
			expect(catalog.accounts[0]!.classifiers).toEqual([
				{
					...builtinLuna,
					api: "typesafe-system-one",
					provider: "acct:openai-api-key-luna",
					baseUrl: BROKER_PLACEHOLDER_URL,
				},
			]);
			expect(catalog.pools.find((pool) => pool.name === "openai")?.classifiers).toEqual([
				{ ...builtinLuna, api: "typesafe-system-one", provider: "pool:openai", baseUrl: BROKER_PLACEHOLDER_URL },
			]);
			expect(catalog.pools.find((pool) => pool.name === "all")?.classifiers).toBeUndefined();
		});

		it("is not offered for ChatGPT subscriptions, which the Decisions API rejects", () => {
			const subscription = account({
				id: "codex-dddd-d@example.com.json",
				provider: "codex",
				email: "d@example.com",
			});
			const catalog = catalogFor(
				[subscription, openaiKey],
				modelsOf([subscription, [lunaModel]], [openaiKey, [lunaModel]]),
			);
			expect(catalog.accounts.map((entry) => [entry.id, entry.classifiers?.length])).toEqual([
				[subscription.id, undefined],
				[openaiKey.id, 1],
			]);
			expect(catalog.pools.map((pool) => [pool.name, pool.classifiers?.length])).toEqual([
				["all", undefined],
				["codex", undefined],
				["openai", 1],
			]);
			expect(providerSpecs(catalog).map((entry) => [entry.id, entry.classifiers?.length])).toEqual([
				["pool:all", undefined],
				["pool:codex", undefined],
				["pool:openai", 1],
				[`acct:${subscription.id.replace(/\.json$/, "")}`, undefined],
				[`acct:${openaiKey.id}`, 1],
			]);
		});

		it("is not offered when the key does not list the model, or Pi has no matching classifier", () => {
			const imageOnly = modelsOf([openaiKey, [{ id: "gpt-image-1", thinking: false }]]);
			expect(catalogFor([openaiKey], imageOnly).accounts[0]!.classifiers).toBeUndefined();
			expect(catalogFor([openaiKey], imageOnly).pools[0]!.classifiers).toBeUndefined();
			const listed = modelsOf([openaiKey, [lunaModel]]);
			expect(buildCatalog([openaiKey], listed, () => undefined).accounts[0]!.classifiers).toBeUndefined();
			const otherApi = () => ({ ...builtinLuna, api: "typesafe-system-one" });
			expect(buildCatalog([openaiKey], listed, () => undefined, otherApi).accounts[0]!.classifiers).toBeUndefined();
		});

		it("is kept in the catalog file, and entries this version cannot serve are dropped", () => {
			const catalog = catalogFor([openaiKey], modelsOf([openaiKey, [lunaModel]]));
			const path = join(tempDir(), "catalog.json");
			writeCatalog(path, catalog);
			expect(readCatalog(path)).toEqual(catalog);

			const [pinned] = catalog.accounts;
			writeFileSync(path, JSON.stringify({ ...catalog, accounts: [{ ...pinned, classifiers: "gpt-6-luna" }] }));
			const read = readCatalog(path);
			expect(read.accounts[0]!.classifiers).toBeUndefined();
			expect(read.pools.find((pool) => pool.name === "openai")?.classifiers).toBeUndefined();
		});

		it("drops a cached Decisions entry, which the broker no longer serves", () => {
			const catalog = catalogFor([openaiKey], modelsOf([openaiKey, [lunaModel]]));
			const path = join(tempDir(), "catalog.json");
			const decisions = { ...catalog.accounts[0]!.classifiers![0]!, api: "openai-decisions" };
			writeFileSync(
				path,
				JSON.stringify({ ...catalog, accounts: [{ ...catalog.accounts[0], classifiers: [decisions] }] }),
			);
			const read = readCatalog(path);
			expect(read.accounts[0]!.classifiers).toEqual([]);
			expect(read.pools.find((pool) => pool.name === "openai")?.classifiers).toEqual([]);
		});
	});

	describe("Jev classifier", () => {
		const modelsOf = (...models: BrokerModel[]) => new Map([[typesafeKey.key, models]]);
		const catalogFor = (entries: BrokerAccount[], models: Map<string, BrokerModel[]>) =>
			buildCatalog(entries, models, () => undefined, lookupClassifier);

		it("goes to TypeSafe keys and pool:typesafe from every classifier the key lists, and adds no chat models", () => {
			const fast: BrokerModel = { id: "jev-fast", kind: "classifier", thinking: false };
			const catalog = catalogFor([typesafeKey], modelsOf(jevModel, fast));
			expect(builtinJev.api).toBe("typesafe-system-one");
			const expected = (provider: string) => [
				{ ...builtinJev, name: "Jev (latest)", provider, baseUrl: BROKER_PLACEHOLDER_URL },
				{ ...builtinJev, id: "jev-fast", name: "jev-fast", provider, baseUrl: BROKER_PLACEHOLDER_URL },
			];
			expect(catalog.accounts[0]!.models).toEqual([]);
			expect(catalog.accounts[0]!.classifiers).toEqual(expected("acct:typesafe-key-jev"));
			expect(catalog.pools.map((pool) => [pool.name, pool.models.length, pool.classifiers?.length])).toEqual([
				["all", 0, undefined],
				["typesafe", 0, 2],
			]);
			expect(catalog.pools.find((pool) => pool.name === "typesafe")?.classifiers).toEqual(expected("pool:typesafe"));
			expect(accountDisplayName(catalog.accounts[0]!)).toBe("TypeSafe · jev (API key)");
		});

		it("lives beside the gpt-6-luna classifier without leaking into other pools", () => {
			const catalog = catalogFor(
				[openaiKey, typesafeKey, claudeB],
				new Map([
					[openaiKey.key, [lunaModel]],
					[typesafeKey.key, [jevModel]],
					[claudeB.key, [claudeModel]],
				]),
			);
			expect(
				catalog.pools.map((pool) => [pool.name, pool.models.length, pool.classifiers?.map((m) => m.id)]),
			).toEqual([
				["all", 1, undefined],
				["claude", 1, undefined],
				["openai", 0, ["gpt-6-luna"]],
				["typesafe", 0, ["jev-latest"]],
			]);
		});

		it("is not offered for models the broker does not list as classifiers, or when Pi has no matching entry", () => {
			const chat = modelsOf({ id: "jev-latest", kind: "chat", thinking: false });
			expect(catalogFor([typesafeKey], chat).accounts[0]!.classifiers).toBeUndefined();
			const listed = modelsOf(jevModel);
			expect(buildCatalog([typesafeKey], listed, () => undefined).accounts[0]!.classifiers).toBeUndefined();
			const otherApi = () => ({ ...builtinJev, api: "openai-decisions" });
			expect(
				buildCatalog([typesafeKey], listed, () => undefined, otherApi).accounts[0]!.classifiers,
			).toBeUndefined();
		});

		it("is not offered for a disabled key's pool", () => {
			const catalog = catalogFor([{ ...typesafeKey, disabled: true }], modelsOf(jevModel));
			expect(catalog.accounts[0]!.classifiers).toHaveLength(1);
			expect(catalog.pools).toEqual([]);
		});

		it("is kept in the catalog file next to gpt-6-luna, and entries this version cannot serve are dropped", () => {
			const catalog = catalogFor(
				[openaiKey, typesafeKey],
				new Map([
					[openaiKey.key, [lunaModel]],
					[typesafeKey.key, [jevModel]],
				]),
			);
			const path = join(tempDir(), "catalog.json");
			writeCatalog(path, catalog);
			expect(readCatalog(path)).toEqual(catalog);

			const pinned = catalog.accounts[1]!;
			const unsupported = { ...pinned.classifiers![0]!, api: "cloudflare-workers-ai-system-one" };
			writeFileSync(path, JSON.stringify({ ...catalog, accounts: [{ ...pinned, classifiers: [unsupported] }] }));
			const read = readCatalog(path);
			expect(read.accounts[0]!.classifiers).toEqual([]);
			expect(read.pools.find((pool) => pool.name === "typesafe")?.classifiers).toEqual([]);
		});
	});
});

describe("accounts extension", () => {
	it("registers cached accounts synchronously and adds its commands", async () => {
		const agentDir = tempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		writeCatalog(join(agentDir, "accounts", "catalog.json"), testCatalog());
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			accountsExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:accounts",
		);
		expect([...extension.commands.keys()].sort()).toEqual(["accounts", "models"]);
		expect(runtime.pendingNativeProviderRegistrations.map((entry) => entry.provider.id)).toEqual(
			providerSpecs(testCatalog()).map((spec) => spec.id),
		);
		expect(runtime.pendingVirtualModelRegistrations).toEqual([]);
	});

	it("registers providers that send oh-my-pi's identity for earlier turns of any cataloged account or pool", async () => {
		const broker = await startFakeBroker();
		const claude = { ...claudeModel, ...anthropicIdentity };
		const catalog = buildCatalog(
			[claudeA, claudeB],
			new Map([
				[claudeA.key, [claude]],
				[claudeB.key, [claude]],
			]),
			() => undefined,
		);
		const path = join(tempDir(), "catalog.json");
		writeCatalog(path, catalog);
		const registered: Provider[] = [];
		const pi = {
			registerProvider: (provider: Provider) => registered.push(provider),
			unregisterProvider: vi.fn(),
		} as unknown as ExtensionAPI;
		const registry = new AccountRegistry(pi, clientFor(broker.home), path, () => {});

		const turn = (provider: string): AssistantMessage => ({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig-A" },
				{ type: "text", text: "Earlier answer." },
			],
			api: OMP_NATIVE_API,
			provider,
			model: claudeModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});
		// The request goes to pool:claude. Its history holds turns of two accounts, the pool and a removed account.
		const requestProvider = registered.find((provider) => provider.id === "pool:claude")!;
		const requestModel: Model<Api> = {
			...registry.provider("pool:claude")!.models[0]!,
			baseUrl: `${broker.url}/credne/v1/route/p.claude`,
		};
		const history = ["acct:claude-bbbb-b", "pool:claude", "acct:claude-api-aaaa-a", "acct:gone"].flatMap(
			(provider) => [{ role: "user" as const, content: "go", timestamp: 1 }, turn(provider)],
		);
		const message = await requestProvider
			.streamSimple(requestModel, normalizeContext({ messages: history }), { apiKey: TOKEN })
			.result();

		expect(message.stopReason).toBe("toolUse");
		const sent = broker.requests.find((request) => request.path.endsWith("/pi/stream"))!;
		const body = JSON.parse(sent.body) as {
			context: { messages: { role: string; provider?: string; api?: string }[] };
		};
		expect(
			body.context.messages
				.filter((entry) => entry.role === "assistant")
				.map(({ provider, api }) => [provider, api]),
		).toEqual([
			["anthropic", "anthropic-messages"],
			["anthropic", "anthropic-messages"],
			["anthropic", "anthropic-messages"],
			["acct:gone", OMP_NATIVE_API],
		]);
	});

	it.each(["omp-accounts.json", "api-accounts.json"])(
		"detects a stopped broker from %s without a catalog or discovery file",
		async (metadata) => {
			const agentDir = tempDir();
			const home = join(agentDir, "accounts");
			mkdirSync(home);
			writeFileSync(join(home, metadata), "{}");
			vi.stubEnv("PI_ACCOUNTS_BROKER", join(agentDir, "missing-broker"));
			const extension = await loadExtensionFromFactory(
				(pi) => accountsExtension(pi, agentDir),
				process.cwd(),
				createEventBus(),
				createExtensionRuntime(),
				"builtin:accounts",
			);
			const notify = vi.fn();
			await extension.commands.get("accounts")!.handler("list", { hasUI: false, ui: { notify } } as never);
			// The metadata triggers a start attempt even though there is no cached provider yet.
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("Account broker not installed"), "warning");
		},
	);

	it("leaves legacy local Claude credentials untouched and directs users to broker sign-in", async () => {
		const agentDir = tempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const home = join(agentDir, "accounts");
		mkdirSync(join(home, "auths"), { recursive: true });
		const localPath = join(home, "claude-subscriptions.json");
		const brokerPath = join(home, "auths", "claude-legacy.json");
		const local = JSON.stringify({ "claude-sub:legacy": { type: "oauth", refresh: "local-test-token" } });
		const broker = JSON.stringify({ type: "claude", refresh_token: "broker-test-token" });
		writeFileSync(localPath, local);
		writeFileSync(brokerPath, broker);
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			accountsExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:accounts",
		);
		const notify = vi.fn();
		const ctx = { ui: { notify, setStatus: vi.fn() } } as never;
		await extension.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await extension.commands.get("accounts")!.handler("remove claude-sub:legacy", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("/accounts add claude-subscription"), "warning");
		expect(runtime.pendingNativeProviderRegistrations).toEqual([]);
		expect(readFileSync(localPath, "utf8")).toBe(local);
		expect(readFileSync(brokerPath, "utf8")).toBe(broker);
	});

	it("keeps file tools out of the credential directory", async () => {
		const agentDir = tempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const extension = await loadExtensionFromFactory(
			accountsExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"builtin:accounts",
		);
		const [guard] = extension.handlers.get("tool_call") ?? [];
		const call = (toolName: string, path: string) =>
			guard!({ type: "tool_call", toolCallId: "1", toolName, input: { path } }, { cwd: agentDir } as never);
		expect(await call("read", join(agentDir, "accounts", "auths", "claude.json"))).toMatchObject({ block: true });
		expect(await call("write", "accounts/broker.json")).toMatchObject({ block: true });
		expect(await call("read", join(agentDir, "accounts", "claude-subscriptions.json"))).toMatchObject({
			block: true,
		});
		expect(await call("edit", "accounts/claude-subscriptions.json")).toMatchObject({ block: true });
		expect(await call("read", join(agentDir, "settings.json"))).toBeUndefined();
	});
});

describe("account model refresh", () => {
	const newerCodexModel: BrokerModel = { id: "gpt-test-2", thinking: true };
	const codexProviderId = "acct:codex-cccc-c@example.com-plus";

	/** Loads the extension over a cached catalog in which the Codex account serves only `gpt-test`. */
	async function loadCached() {
		const agentDir = tempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const home = join(agentDir, "accounts");
		writeCatalog(join(home, "catalog.json"), testCatalog());
		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(accountsExtension, process.cwd(), createEventBus(), runtime, "builtin:accounts");
		const refreshAll = (allowNetwork: boolean) =>
			Promise.all(
				runtime.pendingNativeProviderRegistrations.map(({ provider }) =>
					provider.refreshModels!({
						allowNetwork,
						signal: new AbortController().signal,
						publish: async () => true,
					}),
				),
			);
		const codexModels = () =>
			runtime.pendingNativeProviderRegistrations
				.filter(({ provider }) => provider.id === codexProviderId)
				.map(({ provider }) => provider.getModels().map((model) => model.id));
		return { home, runtime, refreshAll, codexModels };
	}

	it("re-registers accounts with the models a running broker now lists, reading it once per refresh", async () => {
		const { home, refreshAll, codexModels } = await loadCached();
		const broker = await startFakeBroker({
			home,
			respond: (request) =>
				request.path.endsWith(`${codexC.key}/models`)
					? { status: 200, body: { models: [codexModel, newerCodexModel] } }
					: undefined,
		});
		await refreshAll(true);
		expect(broker.requests.filter((request) => request.path === "/credne/v1/accounts")).toHaveLength(1);
		expect(codexModels()).toEqual([["gpt-test"], ["gpt-test", "gpt-test-2"]]);
		const cached = readCatalog(join(home, "catalog.json")).accounts.find((entry) => entry.id === codexC.id);
		expect(cached?.models.map((model) => model.id)).toEqual(["gpt-test", "gpt-test-2"]);
		// An unchanged broker list registers nothing again.
		await refreshAll(true);
		expect(codexModels()).toHaveLength(2);
	});

	it("does not contact the broker in the offline phase and never starts one", async () => {
		const { home, runtime, refreshAll, codexModels } = await loadCached();
		const registered = runtime.pendingNativeProviderRegistrations.length;
		await refreshAll(true);
		expect(runtime.pendingNativeProviderRegistrations).toHaveLength(registered);
		const broker = await startFakeBroker({ home });
		await refreshAll(false);
		expect(broker.requests).toEqual([]);
		expect(codexModels()).toEqual([["gpt-test"]]);
	});
});

describe("Jev account warning", () => {
	const warning =
		"No Jev account. Add one with /accounts add jev; decisions fall back to gpt-6-luna or the session model.";

	/** Starts `sessions` sessions against a running broker that lists `accounts`, and returns what the UI was told. */
	async function startSessions(accounts: BrokerAccount[], options: { hasUI?: boolean; sessions?: number } = {}) {
		const agentDir = tempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		await startFakeBroker({
			home: join(agentDir, "accounts"),
			respond: (request) => {
				if (request.path === "/credne/v1/accounts") return { status: 200, body: { accounts } };
				if (!request.path.endsWith("/models")) return undefined;
				return { status: 200, body: { models: [request.path.includes(typesafeKey.key) ? jevModel : claudeModel] } };
			},
		});
		const extension = await loadExtensionFromFactory(
			accountsExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"builtin:accounts",
		);
		const notify = vi.fn();
		const refresh = vi.fn(async () => {});
		const ctx = { hasUI: options.hasUI ?? true, ui: { notify, setStatus: vi.fn() }, modelRegistry: { refresh } };
		const [onSessionStart] = extension.handlers.get("session_start") ?? [];
		for (let started = 1; started <= (options.sessions ?? 1); started++) {
			await onSessionStart!({ type: "session_start", reason: "startup" }, ctx as never);
			// The hook returns before the broker answers; it refreshes the model registry once the catalog is synced.
			await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(started));
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		return notify;
	}

	it("warns once when the synced catalog has no TypeSafe account, however many sessions start", async () => {
		const notify = await startSessions([claudeB], { sessions: 2 });
		expect(notify.mock.calls).toEqual([[warning, "warning"]]);
	});

	it("warns when the only TypeSafe account is disabled", async () => {
		const notify = await startSessions([claudeB, { ...typesafeKey, disabled: true }]);
		expect(notify.mock.calls).toEqual([[warning, "warning"]]);
	});

	it("stays quiet when an enabled TypeSafe account exists", async () => {
		const notify = await startSessions([claudeB, typesafeKey], { sessions: 2 });
		expect(notify).not.toHaveBeenCalled();
	});

	it("stays quiet without a UI", async () => {
		const notify = await startSessions([claudeB], { hasUI: false });
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("accounts panel command", () => {
	async function runPanel(
		keys: string[][],
		options: { manageChoice?: string; confirm?: boolean; respond?: FakeBrokerOptions["respond"] } = {},
	) {
		initTheme("dark");
		const agentDir = tempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const broker = await startFakeBroker({
			home: join(agentDir, "accounts"),
			respond: (request) =>
				options.respond?.(request) ?? (request.path.endsWith("/disable") ? { status: 200, body: {} } : undefined),
		});
		writeCatalog(join(agentDir, "accounts", "catalog.json"), testCatalog());
		const runtime = createExtensionRuntime();
		const setModel = vi.fn(async () => true);
		runtime.setModel = setModel;
		runtime.getSettings = () => ({ defaultProvider: ACCT_C });
		const extension = await loadExtensionFromFactory(
			accountsExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:accounts",
		);
		const panels: string[][] = [];
		const confirm = vi.fn(async () => options.confirm ?? false);
		const select = vi.fn(async () => options.manageChoice);
		const ctx = {
			hasUI: true,
			model: spec(ACCT_A).models[0],
			modelRegistry: {
				find: () => undefined,
				refresh: async () => {},
				getAll: () => providerSpecs(testCatalog()).flatMap((entry) => entry.models),
			},
			sessionManager: { getEntries: () => [], getBranch: () => [] },
			ui: {
				confirm,
				select,
				notify: vi.fn(),
				custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
					let result: unknown;
					const component = await factory(
						new TuiMainScreen(new VirtualTerminal()),
						theme,
						new KeybindingsManager(),
						(value) => {
							result = value;
						},
					);
					panels.push(component.render(120).map(stripVTControlCharacters));
					for (const key of keys[panels.length - 1] ?? ["\x1b"]) component.handleInput?.(key);
					component.dispose?.();
					return result;
				},
			},
		};
		await extension.commands.get("accounts")!.handler("", ctx as never);
		return { setModel, select, confirm, panels, broker, notifications: ctx.ui.notify.mock.calls };
	}

	it("Enter selects an account and Pin remembers it and its model for new sessions", async () => {
		const result = await runPanel([["\x1b[B", "\r", "\t", "\r"]]);
		expect(result.setModel).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ provider: ACCT_B, id: claudeModel.id }),
			{ persist: true },
		);
		expect(result.select).not.toHaveBeenCalled();
	});

	it("cancelling the default panel never switches provider", async () => {
		const result = await runPanel([["\x1b[B", "\x1b"]]);
		expect(result.setModel).not.toHaveBeenCalled();
		expect(result.select).not.toHaveBeenCalled();
	});

	it("returns from management to the same selected account", async () => {
		const result = await runPanel([["\x1b[B", "\x0f"], ["\x1b"]], { manageChoice: "Disable" });
		expect(result.panels).toHaveLength(2);
		expect(result.panels[1]).toEqual(expect.arrayContaining([expect.stringMatching(/^› .*b@example\.com.*│/)]));
		expect(
			result.broker.requests.some((request) => request.path === `/credne/v1/accounts/${claudeB.key}/disable`),
		).toBe(true);
		expect(result.setModel).not.toHaveBeenCalled();
	});

	it("uses the toolbar to mark accounts and restores marks after declining batch deletion", async () => {
		const result = await runPanel([["\t", "\x1b[C", "\r", "\t", "\x1b[3~"], ["\x1b"]]);
		expect(result.confirm).toHaveBeenCalledExactlyOnceWith(
			"Delete 3 accounts?",
			expect.stringMatching(/Claude · a \(API key\).*\n.*b@example\.com.*\n.*c@example\.com/),
		);
		expect(result.panels[1]).toEqual(
			expect.arrayContaining([
				expect.stringContaining("3 selected"),
				expect.stringMatching(/^› \[x\].*Claude · a .*●.*│/),
				expect.stringMatching(/^ {2}\[x\].*b@example\.com.*│/),
				expect.stringMatching(/^ {2}\[x\].*c@example\.com.*◆.*│/),
				expect.stringMatching(/^ {2}Pool: /),
			]),
		);
		expect(result.broker.requests.some((request) => request.method === "DELETE")).toBe(false);
		expect(result.setModel).not.toHaveBeenCalled();
	});

	it("deletes only marked accounts after one confirmation and keeps the failed account marked", async () => {
		const one = `/credne/v1/accounts/${claudeA.key}`;
		const two = `/credne/v1/accounts/${claudeB.key}`;
		let deleted = false;
		const result = await runPanel([[" ", "\x1b[B", " ", "\x1b[3~"], ["\x1b"]], {
			confirm: true,
			respond: ({ method, path }) => {
				if (path === "/credne/v1/accounts" && deleted)
					return { status: 200, body: { accounts: [claudeB, codexC] } };
				if (method === "DELETE" && path === one) {
					deleted = true;
					return { status: 200, body: {} };
				}
				return method === "DELETE" && path === two
					? { status: 500, body: { error: "Could not delete account" } }
					: undefined;
			},
		});
		expect(result.confirm).toHaveBeenCalledExactlyOnceWith("Delete 2 accounts?", expect.stringContaining(ACCT_B));
		expect(
			result.broker.requests.filter((request) => request.method === "DELETE").map((request) => request.path),
		).toEqual([one, two]);
		expect(result.notifications).toContainEqual([expect.stringContaining("Could not delete account"), "error"]);
		expect(result.panels[1]).toEqual(
			expect.arrayContaining([
				expect.stringContaining("1 selected"),
				expect.stringMatching(/^› \[x\].*b@example\.com/),
			]),
		);
		expect(result.setModel).not.toHaveBeenCalled();
	});
});

describe("broker client", () => {
	it("discovers a running broker and parses accounts defensively", async () => {
		const broker = await startFakeBroker();
		const client = clientFor(broker.home);
		expect(await client.connectExisting()).toMatchObject({ url: broker.url, token: TOKEN });
		expect((await client.listAccounts()).map((entry) => entry.id)).toEqual([claudeA.id, claudeB.id, codexC.id]);
		expect(await client.accountModels(claudeA.key)).toEqual([claudeModel]);
	});

	it("parses the provider and API oh-my-pi resolved for each model, ignoring what is not text", async () => {
		const broker = await startFakeBroker({
			respond: (request) =>
				request.path.endsWith("/models")
					? {
							status: 200,
							body: {
								models: [
									{ id: "claude-test-1", ...anthropicIdentity, thinking: true },
									{ id: "bare", thinking: false },
									{ id: "odd", provider: 7, api: "", thinking: false },
								],
							},
						}
					: undefined,
		});
		expect(await clientFor(broker.home).accountModels(claudeA.key)).toEqual([
			{ id: "claude-test-1", ...anthropicIdentity, thinking: true },
			{ id: "bare", thinking: false },
			{ id: "odd", thinking: false },
		]);
	});

	it("discovers only supported auth methods using the loopback broker token", async () => {
		const broker = await startFakeBroker({
			respond: (request) =>
				request.path === "/credne/v1/providers"
					? {
							status: 200,
							body: {
								providers: [
									{
										id: "custom",
										name: "Custom",
										authMethods: ["api-key", "oauth", "oauth", "external"],
										secret: "hidden",
									},
									{ id: "external", name: "External only", authMethods: ["external"] },
									{ id: "invalid", name: 1, authMethods: ["oauth"] },
								],
							},
						}
					: undefined,
		});
		expect(await clientFor(broker.home).listProviders()).toEqual([
			{ id: "custom", name: "Custom", authMethods: ["api-key", "oauth"] },
		]);
		expect(broker.requests).toContainEqual(
			expect.objectContaining({
				method: "GET",
				path: "/credne/v1/providers",
				headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
			}),
		);
	});

	it("preserves broker chat identification and cost rates from /models", async () => {
		const cost = { input: 1, output: 5, cacheRead: 0.25, cacheWrite: 1 };
		const broker = await startFakeBroker({
			respond: (request) =>
				request.path.endsWith("/models")
					? {
							status: 200,
							body: {
								models: [
									{
										id: "new",
										kind: "chat",
										thinking: true,
										thinkingLevels: ["low", "high"],
										cost: { ...cost, secret: "hidden" },
									},
									{ id: "not-chat", kind: "image", cost: { ...cost, output: -1 } },
								],
							},
						}
					: undefined,
		});
		expect(await clientFor(broker.home).accountModels(openaiKey.key)).toEqual([
			{ id: "new", kind: "chat", thinking: true, thinkingLevels: ["low", "high"], cost },
			{ id: "not-chat", thinking: false },
		]);
	});

	it("parses normalized quota windows and credits without forwarding unknown provider fields", async () => {
		const broker = await startFakeBroker({
			respond: (request) =>
				request.path.endsWith("/usage")
					? {
							status: 200,
							body: {
								status: "available",
								windows: [
									{ label: "5-hour", usedPercent: 0, resetAt: "2026-05-01T13:00:00Z", accessToken: "secret" },
								],
								credits: [{ label: "Credit balance", amount: 12.34, unit: "credits" }],
								secret: "hidden",
							},
						}
					: undefined,
		});
		expect(await clientFor(broker.home).accountUsage(claudeA.key)).toEqual({
			status: "available",
			windows: [{ label: "5-hour", usedPercent: 0, resetAt: "2026-05-01T13:00:00Z" }],
			credits: [{ label: "Credit balance", amount: 12.34, unit: "credits", unlimited: false }],
		});
	});

	it.each([
		{},
		{ status: "available", windows: [{ label: "5-hour" }], credits: [] },
		{ status: "available", windows: [{ label: "5-hour", usedPercent: 101 }], credits: [] },
		{ status: "available", windows: [{ label: "5-hour", usedPercent: 50, resetAt: "invalid" }], credits: [] },
	])("rejects malformed quota responses instead of making up zero usage: %j", async (body) => {
		const broker = await startFakeBroker({
			respond: (request) => (request.path.endsWith("/usage") ? { status: 200, body } : undefined),
		});
		await expect(clientFor(broker.home).accountUsage(claudeA.key)).rejects.toThrow();
	});

	it.each(["unsupported", "unavailable"])("preserves %s with its reason and no windows", async (status) => {
		const broker = await startFakeBroker({
			respond: (request) =>
				request.path.endsWith("/usage")
					? { status: 200, body: { status, reason: "Provider did not report limits." } }
					: undefined,
		});
		expect(await clientFor(broker.home).accountUsage(claudeA.key)).toEqual({
			status,
			reason: "Provider did not report limits.",
			windows: [],
			credits: [],
		});
	});

	it("never sends the token to a non-loopback discovery URL", async () => {
		const home = tempDir();
		writeFileSync(join(home, "broker.json"), JSON.stringify({ url: "http://example.com:80", token: TOKEN, pid: 1 }));
		expect(await clientFor(home).connectExisting()).toBeUndefined();
	});

	it("reports a missing broker binary instead of hanging", async () => {
		await expect(clientFor(tempDir()).listAccounts()).rejects.toThrow("Account broker not installed");
	});
});

describe("daemon upgrade", () => {
	it("refuses a previous backend without starting a second daemon", async () => {
		const broker = await startFakeBroker({
			respond: (request) => (request.path === "/credne/v1/health" ? { status: 200, body: { ok: true } } : undefined),
		});
		const locateBinary = vi.fn(() => undefined);
		const client = new BrokerClient({ home: broker.home, locateBinary });
		await expect(client.connect()).rejects.toThrow("previous account broker");
		expect(locateBinary).not.toHaveBeenCalled();
		expect(broker.requests.map((request) => request.path)).toEqual(["/credne/v1/health"]);
	});

	it("does not start a second core while the existing daemon is unresponsive", async () => {
		const broker = await startFakeBroker({
			respond: (request) =>
				request.path === "/credne/v1/health" ? { status: 503, body: { error: "busy" } } : undefined,
		});
		const locateBinary = vi.fn(() => undefined);
		await expect(new BrokerClient({ home: broker.home, locateBinary }).connect()).rejects.toThrow(
			"still running but not responding",
		);
		expect(locateBinary).not.toHaveBeenCalled();
		expect(broker.requests.map((request) => request.path)).toEqual(["/credne/v1/health"]);
	});

	it("can stop a previous daemon without accepting its provider backend", async () => {
		const broker = await startFakeBroker({
			respond: (request) =>
				request.path === "/credne/v1/shutdown" ? { status: 200, body: { ok: true } } : undefined,
		});
		await clientFor(broker.home).shutdown();
		expect(broker.requests.map((request) => [request.method, request.path])).toEqual([
			["POST", "/credne/v1/shutdown"],
		]);
	});
});

describe("account providers", () => {
	it("a broker pool routes Claude and GPT models through one pool URL in the pi-native protocol", async () => {
		const broker = await startFakeBroker();
		const models = createModels();
		const mixed = spec("pool:all");
		models.setProvider(createAccountProvider(mixed, clientFor(broker.home)));
		const [claude, gpt] = mixed.models;
		await models.completeSimple(claude!, { messages: [{ role: "user", content: "a", timestamp: Date.now() }] });
		await models.completeSimple(gpt!, { messages: [{ role: "user", content: "b", timestamp: Date.now() }] });
		const sent = broker.requests.filter((request) => request.path.startsWith("/credne/v1/route/"));
		expect(sent.map((request) => request.path)).toEqual([
			"/credne/v1/route/p.all/pi/stream",
			"/credne/v1/route/p.all/pi/stream",
		]);
		// oh-my-pi resolves the bare model ID on the pool, so one route serves both families.
		expect(sent.map((request) => (JSON.parse(request.body) as { modelId: string }).modelId)).toEqual([
			claudeModel.id,
			codexModel.id,
		]);
	});

	it("does not redirect the broker token or use caller-provided inference fetch", async () => {
		const broker = await startFakeBroker({
			respond: (request) =>
				request.path.includes("/pi/stream")
					? { status: 307, body: {}, headers: { location: "/other-endpoint" } }
					: undefined,
		});
		const models = createModels();
		const pinned = spec(ACCT_B);
		models.setProvider(createAccountProvider(pinned, clientFor(broker.home)));
		const fetch = vi.fn(globalThis.fetch);
		const reply = await models.completeSimple(
			pinned.models[0]!,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ fetch, maxRetries: 0 },
		);
		expect(reply.stopReason).toBe("error");
		expect(fetch).not.toHaveBeenCalled();
		expect(broker.requests.map((request) => request.path)).toEqual([
			"/credne/v1/health",
			`/credne/v1/route/a.${claudeB.key}/pi/stream`,
		]);
	});

	it("reports which account served a request", async () => {
		const broker = await startFakeBroker();
		const models = createModels();
		const served: [string, string][] = [];
		models.setProvider(
			createAccountProvider(spec(ACCT_B), clientFor(broker.home), (id, key) => served.push([id, key])),
		);
		await models.completeSimple(spec(ACCT_B).models[0]!, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});
		expect(served).toEqual([[ACCT_B, claudeB.key]]);
	});

	it("check() needs no broker; resolve() returns the broker token and the pinned or pool route", async () => {
		const broker = await startFakeBroker();
		const client = clientFor(broker.home);
		const pinned = createAccountProvider(spec(ACCT_A), client);
		const pool = createAccountProvider(spec("pool:codex"), client);
		const signal = new AbortController().signal;
		const ctx = { env: async () => undefined, fileExists: async () => false };
		expect(await pinned!.auth.apiKey!.check!({ ctx, signal })).toEqual({ type: "api_key", source: "account broker" });
		const pinnedAuth = await pinned!.auth.apiKey!.resolve({ ctx, signal });
		expect(pinnedAuth?.auth).toEqual({
			apiKey: TOKEN,
			baseUrl: `${broker.url}/credne/v1/route/a.${claudeA.key}`,
		});
		const poolAuth = await pool!.auth.apiKey!.resolve({ ctx, signal });
		expect(poolAuth?.auth.baseUrl).toBe(`${broker.url}/credne/v1/route/p.codex`);

		const disabled = createAccountProvider({ ...spec(ACCT_A), disabled: true }, client);
		expect(await disabled.auth.apiKey!.check!({ ctx, signal })).toBeUndefined();
	});

	it("streams a Claude subscription through the broker using only the loopback token", async () => {
		const broker = await startFakeBroker();
		const models = createModels();
		const pinned = spec(ACCT_B);
		const provider = createAccountProvider(pinned, clientFor(broker.home));
		expect(provider.auth.oauth).toBeUndefined();
		models.setProvider(provider);
		const message = await models.completeSimple(pinned.models[0]!, {
			messages: [{ role: "user", content: "read a.txt", timestamp: Date.now() }],
		});
		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			expect.objectContaining({ type: "thinking", thinking: "plan", thinkingSignature: "sig-A" }),
			expect.objectContaining({ type: "text", text: "Reading it." }),
			expect.objectContaining({ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } }),
		]);
		expect(message.usage).toMatchObject({ input: 12, output: 20 });
		const sent = broker.requests.find((request) => request.path.includes("/pi/stream"))!;
		expect(sent.path).toBe(`/credne/v1/route/a.${claudeB.key}/pi/stream`);
		expect(sent.headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(sent.headers["x-api-key"]).toBeUndefined();
		expect(JSON.parse(sent.body)).toMatchObject({
			modelId: "claude-test-1",
			stream: true,
			context: { messages: [{ role: "user", content: "read a.txt" }] },
		});
	});

	it("streams a Codex account the same way, whatever API its models speak upstream", async () => {
		const broker = await startFakeBroker();
		const models = createModels();
		const codex = spec(ACCT_C);
		models.setProvider(createAccountProvider(codex, clientFor(broker.home)));
		const message = await models.completeSimple(codex.models[0]!, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});
		expect(message).toMatchObject({
			stopReason: "stop",
			api: OMP_NATIVE_API,
			provider: ACCT_C,
			content: [expect.objectContaining({ text: "hello codex" })],
		});
		const sent = broker.requests.find((request) => request.path.endsWith("/pi/stream"))!;
		expect(sent.path).toBe(`/credne/v1/route/a.${codexC.key}/pi/stream`);
		expect(sent.headers.authorization).toBe(`Bearer ${TOKEN}`);
	});

	it("sends the whole history with its reasoning to whichever account the next request goes to", async () => {
		const broker = await startFakeBroker();
		const client = clientFor(broker.home);
		const models = createModels();
		const specA = spec(ACCT_A);
		const specB = spec(ACCT_B);
		models.setProvider(createAccountProvider(specA!, client));
		models.setProvider(createAccountProvider(specB!, client));
		const fromA: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig-A" },
				{ type: "text", text: "Earlier answer from account A." },
			],
			api: OMP_NATIVE_API,
			provider: specA!.id,
			model: "claude-test-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const history = [
			{ role: "user" as const, content: "first", timestamp: Date.now() },
			fromA,
			{ role: "user" as const, content: "continue", timestamp: Date.now() },
		];
		const request = async (model: Model<Api>) => {
			broker.requests.length = 0;
			await models.completeSimple(model, { messages: history });
			const sent = broker.requests.find((entry) => entry.path.includes("/pi/stream"))!;
			const body = JSON.parse(sent.body) as {
				context: {
					messages: { role: string; provider?: string; content: { type: string; thinkingSignature?: string }[] }[];
				};
			};
			return { path: sent.path, assistant: body.context.messages.find((entry) => entry.role === "assistant")! };
		};
		// Which of its blocks a target replays is oh-my-pi's rule, applied where the request is built.
		for (const [target, key] of [
			[specA, claudeA.key],
			[specB, claudeB.key],
		] as const) {
			const sent = await request(target!.models[0]!);
			expect(sent.path).toBe(`/credne/v1/route/a.${key}/pi/stream`);
			expect(sent.assistant).toMatchObject({ provider: specA!.id });
			expect(sent.assistant.content).toContainEqual(
				expect.objectContaining({ type: "thinking", thinkingSignature: "sig-A" }),
			);
		}
	});

	describe("gpt-6-luna classifier", () => {
		const catalog = buildCatalog(
			[openaiKey, codexC],
			new Map([
				[openaiKey.key, [lunaModel]],
				[codexC.key, [lunaModel]],
			]),
			() => undefined,
			lookupClassifier,
		);
		const specOf = (id: string): AccountProviderSpec => providerSpecs(catalog).find((entry) => entry.id === id)!;
		const pinned = specOf(`acct:${openaiKey.id}`);
		const pool = specOf("pool:openai");
		const context: ClassifierContext = {
			state: { task: "rename a variable" },
			questions: {
				difficulty: { type: "score", instructions: "How hard is the task?", criteria: ["easy", "hard"] },
			},
		};
		const systemOneAnswer = {
			model: "gpt-6-luna",
			answers: {
				difficulty: { type: "score", score: 1.5, probabilities: { "0": 0.4, "1": 0.6 }, confidence: 0.8 },
			},
			usage: { input_tokens: 100, output_tokens: 0 },
		};

		it("posts to the systemone route of a pinned account or of pool:openai with the broker token", async () => {
			const broker = await startFakeBroker({
				respond: (request) =>
					request.path.endsWith("/systemone") ? { status: 200, body: systemOneAnswer } : undefined,
			});
			const models = createModels();
			models.setProvider(createAccountProvider(pinned, clientFor(broker.home)));
			models.setProvider(createAccountProvider(pool, clientFor(broker.home)));

			const results = [];
			for (const spec of [pinned, pool]) {
				results.push(await models.classify(spec.classifiers![0]!, context));
			}

			for (const result of results) {
				expect(result).toMatchObject({
					stopReason: "stop",
					answers: { difficulty: { type: "score", score: 1.5, confidence: 0.8 } },
				});
				// Priced from the built-in entry: 100 input tokens at its input rate.
				expect(result.usage?.cost.total).toBeCloseTo((100 * builtinLuna.cost.input) / 1_000_000, 12);
			}
			const sent = broker.requests.filter((request) => request.path.includes("/route/"));
			expect(sent.map((request) => request.path)).toEqual([
				`/credne/v1/route/a.${openaiKey.key}/systemone`,
				"/credne/v1/route/p.openai/systemone",
			]);
			for (const request of sent) {
				expect(request.method).toBe("POST");
				expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
				expect(JSON.parse(request.body)).toEqual({
					model: "gpt-6-luna",
					state: context.state,
					questions: context.questions,
				});
			}
		});

		it("is available for an enabled API-key account and pool, never for a subscription or a disabled account", async () => {
			const broker = await startFakeBroker();
			const availableFor = async (spec: AccountProviderSpec) => {
				const models = createModels();
				models.setProvider(createAccountProvider(spec, clientFor(broker.home)));
				return (await models.getAvailableOfType("classifier")).map((model) => `${model.provider}/${model.id}`);
			};
			expect(await availableFor(pinned)).toEqual([`acct:${openaiKey.id}/gpt-6-luna`]);
			expect(await availableFor(pool)).toEqual(["pool:openai/gpt-6-luna"]);
			expect(await availableFor(specOf("pool:codex"))).toEqual([]);
			expect(await availableFor(specOf(ACCT_C))).toEqual([]);
			expect(await availableFor({ ...pinned, disabled: true })).toEqual([]);
			expect(broker.requests).toEqual([]);
		});
	});

	describe("Jev classifier", () => {
		const catalog = buildCatalog(
			[typesafeKey, codexC],
			new Map([
				[typesafeKey.key, [jevModel]],
				[codexC.key, [codexModel]],
			]),
			() => undefined,
			lookupClassifier,
		);
		const specOf = (id: string): AccountProviderSpec => providerSpecs(catalog).find((entry) => entry.id === id)!;
		const pinned = specOf(`acct:${typesafeKey.id}`);
		const pool = specOf("pool:typesafe");
		const context: ClassifierContext = {
			state: { task: "rename a variable" },
			questions: {
				difficulty: { type: "score", instructions: "How hard is the task?", criteria: ["easy", "hard"] },
			},
		};
		const systemOneAnswer = {
			answers: {
				difficulty: { type: "score", score: 1.5, probabilities: { "0": 0.4, "1": 0.6 }, confidence: 0.8 },
			},
			usage: { input_tokens: 100, output_tokens: 0 },
		};
		const image = { type: "image", data: "aGk=", mimeType: "image/png" } as const;

		/** Classifies once on each of the given specs against a broker that answers the System One route. */
		async function classifyOn(specs: AccountProviderSpec[], withContext: ClassifierContext) {
			const broker = await startFakeBroker({
				respond: (request) =>
					request.path.endsWith("/systemone") ? { status: 200, body: systemOneAnswer } : undefined,
			});
			const models = createModels();
			for (const spec of specs) models.setProvider(createAccountProvider(spec, clientFor(broker.home)));
			const results = [];
			for (const spec of specs) results.push(await models.classify(spec.classifiers![0]!, withContext));
			return { results, sent: broker.requests.filter((request) => request.path.includes("/route/")) };
		}

		it("posts to the systemone route of a pinned account or of pool:typesafe with the broker token", async () => {
			const { results, sent } = await classifyOn([pinned, pool], context);

			for (const result of results) {
				expect(result).toMatchObject({
					stopReason: "stop",
					answers: { difficulty: { type: "score", score: 1.5, confidence: 0.8 } },
				});
			}
			expect(sent.map((request) => request.path)).toEqual([
				`/credne/v1/route/a.${typesafeKey.key}/systemone`,
				"/credne/v1/route/p.typesafe/systemone",
			]);
			for (const request of sent) {
				expect(request.method).toBe("POST");
				expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
				expect(request.headers["typesafe-danger-zone-images"]).toBeUndefined();
				expect(JSON.parse(request.body)).toEqual({
					model: "jev-latest",
					state: context.state,
					questions: context.questions,
				});
			}
		});

		it("sends images as assets and opts in to TypeSafe's experimental image input", async () => {
			const { results, sent } = await classifyOn([pinned], { ...context, images: [image] });

			expect(results[0]).toMatchObject({ stopReason: "stop" });
			expect(sent[0]!.headers["typesafe-danger-zone-images"]).toBe("true");
			expect(JSON.parse(sent[0]!.body)).toMatchObject({
				model: "jev-latest",
				state: ["<image-1>", context.state],
				assets: { "<image-1>": { type: "image", format: "png", data_base64: "aGk=" } },
			});
		});

		it("is available for an enabled TypeSafe account and its pool, never for a disabled one or another account", async () => {
			const broker = await startFakeBroker();
			const availableFor = async (entry: AccountProviderSpec) => {
				const models = createModels();
				models.setProvider(createAccountProvider(entry, clientFor(broker.home)));
				return (await models.getAvailableOfType("classifier")).map((model) => `${model.provider}/${model.id}`);
			};
			expect(await availableFor(pinned)).toEqual([`acct:${typesafeKey.id}/jev-latest`]);
			expect(await availableFor(pool)).toEqual(["pool:typesafe/jev-latest"]);
			expect(await availableFor(specOf("pool:all"))).toEqual([]);
			expect(await availableFor(specOf(ACCT_C))).toEqual([]);
			expect(await availableFor({ ...pinned, disabled: true })).toEqual([]);
			expect(broker.requests).toEqual([]);
		});
	});
});

describe("account command flows", () => {
	const claudeLabels = ["Subscription (Pro, Max, Team sign-in)", "API key (Anthropic Console key)"];
	const addArguments = [
		"claude",
		"claude-subscription",
		"claude-api-key",
		"chatgpt",
		"openai-api-key",
		"codex",
		"jev",
		"jev-api-key",
		"other",
	];
	const discoveryPaths = ["/credne/v1/health", "/credne/v1/providers"];
	const deviceProvider: BrokerProvider = { id: "xai-oauth", name: "SuperGrok", authMethods: ["oauth"] };
	const deviceAccount = account({ id: "xai-oauth-work", provider: "xai-oauth", label: "work" });
	const deviceUrl = "https://auth.example/device";
	const deviceInstructions = "Enter WXYZ at the verification page.";

	beforeEach(() => {
		vi.mocked(openBrowser).mockClear();
	});

	/** Simulate a broker login with an optional warning before the browser URL becomes available. */
	function loginRoutes(status: unknown, riskWarning?: string): FakeBrokerOptions["respond"] {
		return (request) => {
			if (request.method === "POST" && request.path === "/credne/v1/logins") {
				return {
					status: 200,
					body: { state: "login-1", url: riskWarning ? "" : "https://auth.example/start", riskWarning },
				};
			}
			if (riskWarning && request.method === "POST" && request.path === "/credne/v1/logins/login-1/acknowledge") {
				return { status: 200, body: { state: "login-1", url: "https://auth.example/confirmed" } };
			}
			return request.path === "/credne/v1/logins/login-1" ? { status: 200, body: status } : undefined;
		};
	}

	function deviceRoutes(status: unknown): FakeBrokerOptions["respond"] {
		return (request) => {
			if (request.method === "POST" && request.path === "/credne/v1/logins") {
				return {
					status: 200,
					body: { state: "login-1", flow: "device", url: deviceUrl, instructions: deviceInstructions },
				};
			}
			return request.path === "/credne/v1/logins/login-1" ? { status: 200, body: status } : undefined;
		};
	}

	function loadAccountsExtension(agentDir: string, runtime = createExtensionRuntime()) {
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		return loadExtensionFromFactory(accountsExtension, process.cwd(), createEventBus(), runtime, "builtin:accounts");
	}

	interface AddScript {
		/** Labels picked at the menus in order; undefined presses Escape. */
		choices?: (string | undefined)[];
		/** Answers to the name and key inputs in order. */
		answers?: string[];
		confirm?: (title: string, warning: string) => boolean;
		respond?: FakeBrokerOptions["respond"];
		providers?: BrokerProvider[];
		withoutDefault?: boolean;
		model?: Model<Api>;
		available?: Model<Api>[];
	}

	/** Runs `/accounts <args>` through the registered command against a fake broker and a scripted UI. */
	async function runAccount(args: string, script: AddScript = {}) {
		const agentDir = tempDir();
		const broker = await startFakeBroker({
			home: join(agentDir, "accounts"),
			respond: (request) =>
				request.path === "/credne/v1/providers" && script.providers
					? { status: 200, body: { providers: script.providers } }
					: script.respond?.(request),
		});
		const runtime = createExtensionRuntime();
		const setModel = vi.fn(async () => true);
		runtime.setModel = setModel;
		runtime.getSettings = () => ({ defaultProvider: script.withoutDefault ? undefined : "anthropic" });
		const extension = await loadAccountsExtension(agentDir, runtime);
		const menus: { title: string; options: string[] }[] = [];
		const inputs: string[] = [];
		const notifications: { message: string; type?: string }[] = [];
		const choices = [...(script.choices ?? [])];
		const answers = [...(script.answers ?? [])];
		const ctx = {
			hasUI: true,
			model: script.model,
			modelRegistry: {
				find: () => undefined,
				refresh: async () => {},
				getAll: () => script.available ?? providerSpecs(testCatalog()).flatMap((entry) => entry.models),
			},
			ui: {
				confirm: async (title: string, warning: string) => script.confirm?.(title, warning) ?? false,
				select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) => {
					menus.push({ title, options });
					const signal = opts?.signal;
					if (!signal || choices.length > 0) return choices.shift();
					return new Promise<string | undefined>((resolve) =>
						signal.addEventListener("abort", () => resolve(undefined), { once: true }),
					);
				},
				input: (title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => {
					inputs.push(title);
					const signal = opts?.signal;
					if (!signal) return Promise.resolve(answers.shift());
					// The sign-in wait dialog stays open until the command dismisses it.
					return new Promise<string | undefined>((resolve) =>
						signal.addEventListener("abort", () => resolve(undefined)),
					);
				},
				notify: (message: string, type?: string) => notifications.push({ message, type }),
				setStatus: () => {},
			},
		};
		await extension.commands.get("accounts")!.handler(args, ctx as never);
		return { menus, inputs, notifications, requests: broker.requests, setModel };
	}

	function loginRequest(requests: RecordedRequest[]): { provider: string; name?: string } | undefined {
		const start = requests.find((request) => request.method === "POST" && request.path === "/credne/v1/logins");
		return start ? (JSON.parse(start.body) as { provider: string; name?: string }) : undefined;
	}

	it("lists the Claude ways in order and returns to the first menu on Escape", async () => {
		const { menus, notifications, requests } = await runAccount("add", {
			choices: ["Claude account", undefined, undefined],
		});
		expect(menus).toEqual([
			{ title: "Add account", options: ["Claude account", "ChatGPT account"] },
			{ title: "Add Claude account", options: claudeLabels },
			{ title: "Add account", options: ["Claude account", "ChatGPT account"] },
		]);
		expect(notifications).toEqual([]);
		expect(requests.map((request) => request.path)).toEqual(discoveryPaths);
	});

	it("adds an API key chosen in the Claude menu", async () => {
		const { menus, inputs, notifications, requests } = await runAccount("add", {
			choices: ["Claude account", "API key (Anthropic Console key)"],
			answers: ["work", "sk-ant-api03-test"],
			respond: (request) =>
				request.path === "/credne/v1/api-keys" ? { status: 200, body: { account: claudeA } } : undefined,
		});
		expect(menus.map((menu) => menu.title)).toEqual(["Add account", "Add Claude account"]);
		expect(inputs).toEqual(["Name for this API key", "Anthropic API key (visible while typing)"]);
		const added = requests.find((request) => request.path === "/credne/v1/api-keys")!;
		expect(added.method).toBe("POST");
		expect(JSON.parse(added.body)).toEqual({ provider: "anthropic", name: "work", key: "sk-ant-api03-test" });
		expect(notifications).toEqual([{ message: expect.stringContaining("Added Claude · a (API key)"), type: "info" }]);
	});

	it.each(["add jev", "add jev-api-key", "add typesafe"])(
		"/accounts %s enrolls a TypeSafe API key without menus",
		async (args) => {
			const { menus, inputs, notifications, requests } = await runAccount(args, {
				providers: [...familiarProviders, typesafeProvider],
				answers: ["jev", "ts-test-key"],
				respond: (request) =>
					request.path === "/credne/v1/api-keys" ? { status: 200, body: { account: typesafeKey } } : undefined,
			});
			expect(menus).toEqual([]);
			expect(inputs).toEqual(["Name for this API key", "TypeSafe API key (visible while typing)"]);
			const added = requests.find((request) => request.path === "/credne/v1/api-keys")!;
			expect(added.method).toBe("POST");
			expect(JSON.parse(added.body)).toEqual({ provider: "typesafe", name: "jev", key: "ts-test-key" });
			expect(loginRequest(requests)).toBeUndefined();
			expect(notifications).toEqual([
				{ message: expect.stringContaining("Added TypeSafe · jev (API key)"), type: "info" },
			]);
		},
	);

	it("lists Jev as its own entry when the broker offers TypeSafe, not under other providers", async () => {
		const { menus } = await runAccount("add", {
			providers: [...familiarProviders, typesafeProvider],
			choices: [undefined],
		});
		expect(menus).toEqual([{ title: "Add account", options: ["Claude account", "ChatGPT account", "Jev account"] }]);
	});

	it("never prompts for a Jev key when the broker does not offer TypeSafe", async () => {
		const { menus, inputs, notifications, requests } = await runAccount("add jev");
		expect(menus).toEqual([]);
		expect(inputs).toEqual([]);
		expect(requests.map((request) => request.path)).toEqual(discoveryPaths);
		expect(notifications).toEqual([
			{ message: expect.stringContaining("not available through this broker"), type: "warning" },
		]);
	});

	it("offers ChatGPT API keys and subscription sign-in in the second menu", async () => {
		const { menus, inputs, notifications, requests } = await runAccount("add", {
			choices: ["ChatGPT account", "Subscription (ChatGPT sign-in through Codex)"],
			respond: loginRoutes({ status: "ok", account: codexC }),
		});
		expect(menus).toEqual([
			{ title: "Add account", options: ["Claude account", "ChatGPT account"] },
			{
				title: "Add ChatGPT account",
				options: ["API key (OpenAI API credits)", "Subscription (ChatGPT sign-in through Codex)"],
			},
		]);
		expect(loginRequest(requests)?.provider).toBe("openai-codex");
		expect(inputs).toEqual(["Waiting for ChatGPT Codex sign-in"]);
		expect(openBrowser).toHaveBeenCalledWith("https://auth.example/start");
		expect(notifications.map((entry) => entry.message)).toEqual([
			expect.stringContaining("Sign in to ChatGPT Codex in your browser"),
			expect.stringContaining("Added ChatGPT Codex · c@example.com (subscription)"),
		]);
	});

	it("/accounts add codex signs in through the broker without menus", async () => {
		const { menus, requests } = await runAccount("add codex", {
			respond: loginRoutes({ status: "ok", account: codexC }),
		});
		expect(menus).toEqual([]);
		expect(loginRequest(requests)?.provider).toBe("openai-codex");
	});

	it("/accounts add claude opens the Claude menu directly", async () => {
		const { menus, requests } = await runAccount("add claude", { choices: [undefined] });
		expect(menus).toEqual([{ title: "Add Claude account", options: claudeLabels }]);
		expect(requests.map((request) => request.path)).toEqual(discoveryPaths);
	});

	it.each(["no warning", "warning accepted", "warning declined"])(
		"runs /accounts add claude-subscription without menus: %s",
		async (outcome) => {
			const warning = "The provider may enforce its subscription terms when using a third-party client.";
			const confirm = vi.fn(() => {
				expect(openBrowser).not.toHaveBeenCalled();
				return outcome === "warning accepted";
			});
			const { menus, inputs, notifications, requests } = await runAccount("add claude-subscription", {
				confirm,
				respond: loginRoutes({ status: "ok", account: claudeB }, outcome === "no warning" ? undefined : warning),
			});
			expect(menus).toEqual([]);
			expect(loginRequest(requests)).toEqual({ provider: "anthropic" });
			if (outcome === "no warning") expect(confirm).not.toHaveBeenCalled();
			else expect(confirm).toHaveBeenCalledExactlyOnceWith("Acknowledge subscription sign-in risk?", warning);

			const pending = "/credne/v1/logins/login-1";
			const afterStart = requests.filter((request) => request.path.startsWith(pending));
			const actions = afterStart.map(({ method, path }) => `${method} ${path}`);
			if (outcome === "warning declined") {
				expect(actions).toEqual([`DELETE ${pending}`]);
				expect(openBrowser).not.toHaveBeenCalled();
				expect(inputs).toEqual([]);
				expect(notifications).toEqual([{ message: "Sign-in cancelled.", type: "warning" }]);
				return;
			}
			if (outcome === "warning accepted") {
				expect(actions).toEqual([`POST ${pending}/acknowledge`, `GET ${pending}`]);
				expect(JSON.parse(afterStart[0]!.body)).toEqual({ answer: "yes" });
				expect(openBrowser).toHaveBeenCalledExactlyOnceWith("https://auth.example/confirmed");
			} else {
				expect(actions).toEqual([`GET ${pending}`]);
				expect(openBrowser).toHaveBeenCalledExactlyOnceWith("https://auth.example/start");
			}
			expect(inputs).toEqual(["Waiting for Claude sign-in"]);
			expect(notifications.map((entry) => entry.message)).toEqual([
				expect.stringContaining("Sign in to Claude in your browser"),
				expect.stringContaining("Added Claude · b@example.com (subscription)"),
			]);
		},
	);

	it("enrolls the exact other provider chosen from the broker catalog", async () => {
		const custom = account({ id: "custom-two-work", provider: "custom-two", kind: "api-key", label: "work" });
		const { menus, inputs, notifications, requests } = await runAccount("add", {
			providers: [
				...familiarProviders,
				{ id: "custom-one", name: "Custom", authMethods: ["oauth"] },
				{ id: "custom-two", name: "Custom", authMethods: ["api-key", "oauth"] },
			],
			choices: ["Other providers", "Custom (custom-two)", "API key"],
			answers: ["work", "test-key"],
			respond: (request) =>
				request.path === "/credne/v1/api-keys" ? { status: 200, body: { account: custom } } : undefined,
		});
		expect(menus).toEqual([
			{ title: "Add account", options: ["Claude account", "ChatGPT account", "Other providers"] },
			{ title: "Other providers", options: ["Custom (custom-one)", "Custom (custom-two)"] },
			{ title: "Add Custom (custom-two)", options: ["API key", "Sign in (OAuth)"] },
		]);
		expect(inputs).toEqual([
			"Name for this API key",
			"Custom API key (visible while typing; validation may incur a charge)",
		]);
		expect(JSON.parse(requests.find((request) => request.path === "/credne/v1/api-keys")!.body)).toEqual({
			provider: "custom-two",
			name: "work",
			key: "test-key",
		});
		expect(loginRequest(requests)).toBeUndefined();
		expect(notifications).toEqual([{ message: expect.stringContaining("Added Custom-two · work"), type: "info" }]);
	});

	it("offers only broker-enabled familiar methods and never prompts for an unavailable one", async () => {
		const providers: BrokerProvider[] = [{ id: "anthropic", name: "Anthropic", authMethods: ["api-key"] }];
		const menu = await runAccount("add", { providers, choices: ["Claude account"] });
		expect(menu.menus).toEqual([{ title: "Add account", options: ["Claude account"] }]);
		expect(menu.inputs).toEqual(["Name for this API key"]);
		const unavailable = await runAccount("add claude-subscription", { providers });
		expect(unavailable.inputs).toEqual([]);
		expect(unavailable.requests.map((request) => request.path)).toEqual(discoveryPaths);
		expect(unavailable.notifications).toContainEqual({
			message: expect.stringContaining("does not offer"),
			type: "warning",
		});
	});

	it("shows no enrollment options when the broker has none", async () => {
		const { menus, inputs, notifications, requests } = await runAccount("add", { providers: [] });
		expect(menus).toEqual([]);
		expect(inputs).toEqual([]);
		expect(requests.map((request) => request.path)).toEqual(discoveryPaths);
		expect(notifications).toEqual([
			{ message: expect.stringContaining("does not offer any enrollment methods"), type: "warning" },
		]);
	});

	it("uses an exact provider and method for device sign-in, with no redirect input", async () => {
		const { menus, inputs, notifications, requests } = await runAccount("add xai-oauth oauth", {
			providers: [deviceProvider],
			respond: deviceRoutes({ status: "ok", account: deviceAccount }),
		});
		expect(menus).toEqual([{ title: "Waiting for SuperGrok sign-in", options: ["Cancel sign-in"] }]);
		expect(inputs).toEqual([]);
		expect(loginRequest(requests)).toEqual({ provider: "xai-oauth" });
		expect(requests.some((request) => request.path.endsWith("/callback"))).toBe(false);
		expect(openBrowser).toHaveBeenCalledExactlyOnceWith(deviceUrl);
		expect(notifications.map((entry) => entry.message)).toEqual([
			expect.stringContaining(`${deviceUrl}\n${deviceInstructions}`),
			expect.stringContaining("Added Xai-oauth"),
		]);
	});

	it("cancels a device flow without supplying any text or callback", async () => {
		const { inputs, notifications, requests } = await runAccount("add xai-oauth", {
			providers: [deviceProvider],
			choices: ["Cancel sign-in"],
			respond: deviceRoutes({ status: "wait" }),
		});
		expect(inputs).toEqual([]);
		expect(requests.some((request) => request.path.endsWith("/callback"))).toBe(false);
		expect(requests.at(-1)).toMatchObject({ method: "DELETE", path: "/credne/v1/logins/login-1" });
		expect(notifications.at(-1)).toEqual({ message: "Sign-in cancelled.", type: "warning" });
	});

	it("does not replace a selected session model when enrolling an account with no default configured", async () => {
		const { notifications, setModel } = await runAccount("add codex", {
			respond: loginRoutes({ status: "ok", account: codexC }),
			withoutDefault: true,
			model: spec(ACCT_B).models[0],
		});
		expect(notifications).toContainEqual({ message: expect.stringContaining("Added ChatGPT Codex"), type: "info" });
		expect(setModel).not.toHaveBeenCalled();
	});

	it("requires an explicit model choice when switching between unrelated accounts with the same model ID", async () => {
		const xai = account({ id: "xai-work", provider: "xai", label: "work" });
		const other = account({ id: "other-work", provider: "other", label: "work" });
		const shared = { id: "shared", thinking: false };
		const distinct = { id: "distinct", thinking: false };
		const models = new Map([
			[xai.key, [shared]],
			[other.key, [shared, distinct]],
		]);
		const catalog = buildCatalog([xai, other], models, () => undefined);
		const available = providerSpecs(catalog).flatMap((entry) => entry.models);
		const { menus, setModel } = await runAccount("switch acct:other-work", {
			model: available.find((model) => model.provider === "acct:xai-work"),
			available,
			choices: ["distinct"],
			respond: (request) => {
				if (request.path === "/credne/v1/accounts") return { status: 200, body: { accounts: [xai, other] } };
				const key = request.path.split("/").at(-2) ?? "";
				if (request.path.endsWith("/models")) return { status: 200, body: { models: models.get(key) } };
				return undefined;
			},
		});
		expect(menus).toEqual([{ title: "Model on Other · work (subscription)", options: ["shared", "distinct"] }]);
		expect(setModel).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ id: "distinct", provider: "acct:other-work" }),
			{ persist: true },
		);
	});

	it("explains that Console credits are unsupported without starting the broker", async () => {
		const { menus, inputs, notifications, requests } = await runAccount("add claude-api-credits");
		expect(menus).toEqual([]);
		expect(inputs).toEqual([]);
		expect(requests).toEqual([]);
		expect(notifications).toEqual([
			{ message: expect.stringContaining("Use /accounts add claude-api-key"), type: "warning" },
		]);
	});

	it("warns about an unknown provider without sending an enrollment request", async () => {
		const { menus, notifications, requests } = await runAccount("add gemini");
		expect(menus).toEqual([]);
		expect(requests.map((request) => request.path)).toEqual(discoveryPaths);
		expect(notifications).toEqual([
			{ message: expect.stringContaining('Unknown account type "gemini".'), type: "warning" },
		]);
	});

	it("completes the add arguments instead of provider ids", async () => {
		const extension = await loadAccountsExtension(tempDir());
		const complete = async (prefix: string) =>
			((await extension.commands.get("accounts")!.getArgumentCompletions!(prefix)) ?? []).map((item) => item.value);
		expect(await complete("add ")).toEqual(addArguments.map((entry) => `add ${entry}`));
		expect(await complete("add claude-api")).toEqual(["add claude-api-key"]);
		expect(await complete("add j")).toEqual(["add jev", "add jev-api-key"]);
		expect(await complete("add x")).toEqual([]);
	});

	it.each([
		{
			name: "addApiKey",
			args: "add",
			choices: ["Claude account", "API key (Anthropic Console key)"],
			answers: ["work", "sk-ant-api03-dup"],
			respond: (request: RecordedRequest): FakeResponse | undefined =>
				request.path === "/credne/v1/api-keys"
					? { status: 409, body: { error: "This API key is already added as a@example.com." } }
					: undefined,
			message: "Account broker: This API key is already added as a@example.com.",
		},
		{
			name: "startLogin",
			args: "add codex",
			choices: [],
			answers: [],
			respond: (request: RecordedRequest): FakeResponse | undefined =>
				request.path === "/credne/v1/logins"
					? { status: 409, body: { error: "This ChatGPT account is already added as a@example.com." } }
					: undefined,
			message: "Account broker: This ChatGPT account is already added as a@example.com.",
		},
		{
			name: "loginStatus",
			args: "add codex",
			choices: [],
			answers: [],
			respond: loginRoutes({ status: "error", error: "This ChatGPT account is already added as a@example.com." }),
			message: "This ChatGPT account is already added as a@example.com.",
		},
	])("shows a duplicate from $name as one error", async ({ args, choices, answers, respond, message }) => {
		const { notifications } = await runAccount(args, { choices, answers, respond });
		expect(notifications.filter((entry) => entry.type !== "info")).toEqual([{ message, type: "error" }]);
	});
});
