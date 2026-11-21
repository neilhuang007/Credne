import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createModels, type Model } from "@earendil-works/pi-ai";
import { REASONING_SUMMARY_LABEL } from "@earendil-works/pi-ai/api/transform-messages";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type AccountCatalog,
	BROKER_PLACEHOLDER_URL,
	buildCatalog,
	readCatalog,
	writeCatalog,
} from "../src/extensions/accounts/catalog.ts";
import { importBrokerClaudeAccounts } from "../src/extensions/accounts/claude-import.ts";
import { LocalClaudeStore } from "../src/extensions/accounts/claude-store.ts";
import { type BrokerAccount, BrokerClient, type BrokerModel } from "../src/extensions/accounts/client.ts";
import accountsExtension from "../src/extensions/accounts/index.ts";
import { type BrokerProviderSpec, createAccountProvider, providerSpecs } from "../src/extensions/accounts/provider.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

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
const claudeB = account({ id: "claude-api-bbbb-b.json", provider: "claude-api", kind: "api-credits", label: "b" });
const codexC = account({ id: "codex-cccc-c@example.com-plus.json", provider: "codex", email: "c@example.com" });
const claudeModel: BrokerModel = {
	id: "claude-test-1",
	contextLength: 200_000,
	maxCompletionTokens: 64_000,
	thinking: true,
};
const codexModel: BrokerModel = { id: "gpt-test", thinking: true, inputModalities: ["text", "image"] };

function spec(id: string): BrokerProviderSpec {
	const found = providerSpecs(testCatalog()).find((entry) => entry.id === id);
	if (!found) throw new Error(`no provider ${id}`);
	return found;
}

const ACCT_A = "acct:claude-api-aaaa-a";
const ACCT_B = "acct:claude-api-bbbb-b";
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

function sse(response: ServerResponse, events: [string, unknown][]): void {
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	response.end();
}

const ANTHROPIC_EVENTS: [string, unknown][] = [
	[
		"message_start",
		{
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude-test-1",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 12, output_tokens: 0 },
			},
		},
	],
	[
		"content_block_start",
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
	],
	[
		"content_block_delta",
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
	],
	[
		"content_block_delta",
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-A" } },
	],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
	[
		"content_block_delta",
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading it." } },
	],
	["content_block_stop", { type: "content_block_stop", index: 1 }],
	[
		"content_block_start",
		{
			type: "content_block_start",
			index: 2,
			content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
		},
	],
	[
		"content_block_delta",
		{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } },
	],
	["content_block_stop", { type: "content_block_stop", index: 2 }],
	["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }],
	["message_stop", { type: "message_stop" }],
];

const RESPONSES_EVENTS: [string, unknown][] = [
	["response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } }],
	[
		"response.output_item.added",
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] },
		},
	],
	[
		"response.content_part.added",
		{
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
	],
	[
		"response.output_text.delta",
		{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hello codex" },
	],
	[
		"response.output_item.done",
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "hello codex", annotations: [] }],
			},
		},
	],
	[
		"response.completed",
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				output: [],
				usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	],
];

interface FakeResponse {
	status: number;
	body: unknown;
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
			response.writeHead(custom.status, { "Content-Type": "application/json" });
			response.end(JSON.stringify(custom.body));
			return;
		}
		const json = (value: unknown) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(value));
		};
		if (path === "/credne/v1/health") return json({ ok: true, backend: "oh-my-pi" });
		if (path === "/credne/v1/accounts") return json({ accounts: [claudeA, claudeB, codexC, { id: 7 }] });
		if (path.endsWith("/models")) return json({ models: [claudeModel, { name: "no id" }] });
		const target = /^\/credne\/v1\/route\/a\.([^/]+)\//.exec(path)?.[1];
		if (target) response.setHeader("X-Credne-Account", target);
		if (path.endsWith("/v1/messages") || path.includes("/v1/messages?")) return sse(response, ANTHROPIC_EVENTS);
		if (path.endsWith("/responses")) return sse(response, RESPONSES_EVENTS);
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
	it("maps each account to a provider on Pi's native adapter for its upstream", () => {
		const catalog = testCatalog();
		const specs = providerSpecs(catalog);
		// The virtual pools pool:claude and pool:all are not the broker's; they span these accounts and local subscriptions.
		expect(specs.map((entry) => entry.id)).toEqual(["pool:codex", ACCT_A, ACCT_B, ACCT_C]);
		const [claude] = catalog.accounts[0]!.models;
		expect(claude).toMatchObject({
			id: "claude-test-1",
			api: "anthropic-messages",
			provider: ACCT_A,
			baseUrl: BROKER_PLACEHOLDER_URL,
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
			// Server-side continuation is bound to one account and must not survive a switch.
			compat: { supportsMessageThreads: false, sendSessionAffinityHeaders: true },
		});
		expect(catalog.accounts[2]!.models[0]).toMatchObject({ api: "openai-responses", input: ["text", "image"] });
		expect(catalog.pools.map(({ name, accountCount }) => ({ name, accountCount }))).toEqual([
			{ name: "codex", accountCount: 1 },
		]);
		expect(spec(ACCT_A).name).toBe("Claude · a (API key)");
		expect(spec("pool:codex").name).toBe("ChatGPT Codex pool (1 account)");
	});

	it("leaves Claude subscriptions to this process, in new and in older catalog files", () => {
		const subscription = account({
			id: "claude-aaaa-sub@example.com.json",
			provider: "claude",
			email: "sub@example.com",
		});
		const catalog = buildCatalog(
			[subscription, claudeA],
			new Map([
				[subscription.key, [claudeModel]],
				[claudeA.key, [claudeModel]],
			]),
			() => undefined,
		);
		expect(catalog.accounts.map((entry) => entry.id)).toEqual([claudeA.id]);
		expect(catalog.pools).toEqual([]);

		const path = join(tempDir(), "catalog.json");
		writeCatalog(path, {
			version: 2,
			accounts: [
				{ ...catalog.accounts[0]!, id: subscription.id, key: subscription.key, provider: "claude", kind: "oauth" },
				...catalog.accounts,
			],
			pools: [
				{ name: "claude", accountCount: 1, models: [] },
				{ name: "all", accountCount: 1, models: [] },
				{ name: "codex", accountCount: 1, models: [] },
			],
		});
		const read = readCatalog(path);
		expect(read.accounts.map((entry) => entry.id)).toEqual([claudeA.id]);
		expect(read.pools.map((entry) => entry.name)).toEqual(["codex"]);
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
			compat: { supportsStrictTools: true, supportsMessageThreads: false },
		});
		expect(catalog.accounts[0]!.models[0]!.compat).not.toHaveProperty("supportsMidConvoSystemMessages");
	});

	it("round-trips through the catalog file and ignores unreadable files", () => {
		const path = join(tempDir(), "accounts", "catalog.json");
		expect(readCatalog(path).accounts).toEqual([]);
		writeCatalog(path, testCatalog());
		expect(readCatalog(path)).toEqual(testCatalog());
		writeFileSync(path, "{ not json");
		expect(readCatalog(path).accounts).toEqual([]);
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
		// The Claude pools are virtual models of the same provider ids, one per model of their accounts.
		expect(
			runtime.pendingVirtualModelRegistrations.map(({ definition }) => `${definition.provider}/${definition.id}`),
		).toEqual(["pool:all/gpt-test", "pool:all/claude-test-1", "pool:claude/claude-test-1"]);
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

describe("accounts panel command", () => {
	async function runPanel(keys: string[][], manageChoice?: string) {
		initTheme("dark");
		const agentDir = tempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const broker = await startFakeBroker({
			home: join(agentDir, "accounts"),
			respond: (request) => (request.path.endsWith("/disable") ? { status: 200, body: {} } : undefined),
		});
		writeCatalog(join(agentDir, "accounts", "catalog.json"), testCatalog());
		const runtime = createExtensionRuntime();
		const setModel = vi.fn(async () => true);
		runtime.setModel = setModel;
		const extension = await loadExtensionFromFactory(
			accountsExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:accounts",
		);
		const panels: string[][] = [];
		const select = vi.fn(async () => manageChoice);
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
					panels.push(component.render(120));
					for (const key of keys[panels.length - 1] ?? []) component.handleInput?.(key);
					component.dispose?.();
					return result;
				},
			},
		};
		await extension.commands.get("accounts")!.handler("", ctx as never);
		return { setModel, select, panels, broker, notifications: ctx.ui.notify.mock.calls };
	}

	it("default opens a custom panel and Enter remembers the account and model for new sessions", async () => {
		const result = await runPanel([["\x1b[B", "\r"]]);
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
		const result = await runPanel([["\x1b[B", "\x0f"], ["\x1b"]], "Disable");
		expect(result.panels).toHaveLength(2);
		expect(result.panels[1].some((line) => line.startsWith("\x1b[7m› Claude · b (API credits)"))).toBe(true);
		expect(
			result.broker.requests.some((request) => request.path === `/credne/v1/accounts/${claudeB.key}/disable`),
		).toBe(true);
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

	it("does not copy rotating Claude credentials while a previous daemon owns them", async () => {
		const broker = await startFakeBroker({
			respond: (request) => (request.path === "/credne/v1/health" ? { status: 200, body: { ok: true } } : undefined),
		});
		const path = join(broker.home, "auths", "claude-work.json");
		mkdirSync(join(broker.home, "auths"));
		writeFileSync(
			path,
			JSON.stringify({ type: "claude", access_token: "fake-access", refresh_token: "fake-refresh" }),
		);
		const store = new LocalClaudeStore(broker.home);
		await expect(importBrokerClaudeAccounts(store, clientFor(broker.home))).rejects.toThrow(
			"previous account broker",
		);
		expect(store.list()).toEqual([]);
		expect(existsSync(path)).toBe(true);
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
	it("a broker pool routes Claude and GPT models through one pool URL on their own APIs", async () => {
		const broker = await startFakeBroker();
		const models = createModels();
		const mixed: BrokerProviderSpec = {
			id: "pool:mixed",
			name: "Mixed pool",
			target: { type: "pool", name: "mixed" },
			family: "mixed",
			subscription: false,
			disabled: false,
			models: [...spec(ACCT_A).models, ...spec(ACCT_C).models].map((model) => ({
				...model,
				provider: "pool:mixed",
			})),
		};
		models.setProvider(createAccountProvider(mixed, clientFor(broker.home)));
		const [claude, gpt] = mixed.models;
		await models.completeSimple(claude!, { messages: [{ role: "user", content: "a", timestamp: Date.now() }] });
		await models.completeSimple(gpt!, { messages: [{ role: "user", content: "b", timestamp: Date.now() }] });
		const paths = broker.requests
			.filter((request) => request.path.startsWith("/credne/v1/route/"))
			.map((r) => r.path);
		expect(paths).toEqual(["/credne/v1/route/p.mixed/v1/messages?beta=true", "/credne/v1/route/p.mixed/responses"]);
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

	it("streams thinking, text, tool calls and usage through Pi's Anthropic adapter", async () => {
		const broker = await startFakeBroker();
		const models = createModels();
		const pinned = spec(ACCT_A);
		models.setProvider(createAccountProvider(pinned, clientFor(broker.home)));
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
		const sent = broker.requests.find((request) => request.path.includes("/v1/messages"))!;
		expect(sent.path.startsWith(`/credne/v1/route/a.${claudeA.key}/v1/messages`)).toBe(true);
		expect(sent.headers["x-api-key"]).toBe(TOKEN);
	});

	it("streams through Pi's Responses adapter for Codex accounts", async () => {
		const broker = await startFakeBroker();
		const models = createModels();
		const codex = spec(ACCT_C);
		models.setProvider(createAccountProvider(codex, clientFor(broker.home)));
		const message = await models.completeSimple(codex.models[0]!, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});
		expect(message).toMatchObject({
			stopReason: "stop",
			content: [expect.objectContaining({ text: "hello codex" })],
		});
		const sent = broker.requests.find((request) => request.path.endsWith("/responses"))!;
		expect(sent.path).toBe(`/credne/v1/route/a.${codexC.key}/responses`);
		expect(sent.headers.authorization).toBe(`Bearer ${TOKEN}`);
	});

	it("switching accounts keeps history and replays the previous account's reasoning as a summary", async () => {
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
			api: "anthropic-messages",
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
		const assistantBlocks = async (model: Model<"anthropic-messages">) => {
			broker.requests.length = 0;
			await models.completeSimple(model, { messages: history });
			const body = JSON.parse(broker.requests.find((request) => request.path.includes("/v1/messages"))!.body) as {
				messages: { role: string; content: { type: string; signature?: string; text?: string }[] }[];
			};
			return body.messages.find((entry) => entry.role === "assistant")!.content;
		};
		const sameAccount = await assistantBlocks(specA!.models[0] as Model<"anthropic-messages">);
		expect(sameAccount).toContainEqual(expect.objectContaining({ type: "thinking", signature: "sig-A" }));
		const otherAccount = await assistantBlocks(specB!.models[0] as Model<"anthropic-messages">);
		expect(otherAccount.some((block) => block.type === "thinking")).toBe(false);
		expect(otherAccount[0]).toEqual({ type: "text", text: `${REASONING_SUMMARY_LABEL}\nplan` });
		expect(otherAccount).toContainEqual(
			expect.objectContaining({ type: "text", text: "Earlier answer from account A." }),
		);
	});
});

describe("account add flow", () => {
	const claudeCredits = account({
		id: "claude-api-eeee-work.json",
		provider: "claude-api",
		kind: "api-credits",
		label: "work",
	});
	const claudeLabels = [
		"Subscription (Pro, Max, Team sign-in)",
		"API credits (monthly credits of Max, Ultra, Team plans, Claude Console sign-in)",
		"API key (Anthropic Console key)",
	];
	const addArguments = [
		"claude",
		"claude-subscription",
		"claude-api-credits",
		"claude-api-key",
		"chatgpt",
		"openai-api-key",
		"codex",
	];

	beforeEach(() => {
		vi.mocked(openBrowser).mockClear();
	});

	/** Broker routes for one browser login: it starts, then reports `status` for every status or cancel call. */
	function loginRoutes(status: unknown): FakeBrokerOptions["respond"] {
		return (request) => {
			if (request.method === "POST" && request.path === "/credne/v1/logins") {
				return { status: 200, body: { state: "login-1", url: "https://auth.example/start" } };
			}
			return request.path === "/credne/v1/logins/login-1" ? { status: 200, body: status } : undefined;
		};
	}

	function loadAccountsExtension(agentDir: string) {
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const runtime = createExtensionRuntime();
		// A default provider is configured, so adding an account does not switch the session's model.
		runtime.getSettings = () => ({ defaultProvider: "anthropic" });
		return loadExtensionFromFactory(accountsExtension, process.cwd(), createEventBus(), runtime, "builtin:accounts");
	}

	interface AddScript {
		/** Labels picked at the menus in order; undefined presses Escape. */
		choices?: (string | undefined)[];
		/** Answers to the name and key inputs in order. */
		answers?: string[];
		respond?: FakeBrokerOptions["respond"];
	}

	/** Runs `/accounts <args>` through the registered command against a fake broker and a scripted UI. */
	async function runAccount(args: string, script: AddScript = {}) {
		const agentDir = tempDir();
		const broker = await startFakeBroker({ home: join(agentDir, "accounts"), respond: script.respond });
		const extension = await loadAccountsExtension(agentDir);
		const menus: { title: string; options: string[] }[] = [];
		const inputs: string[] = [];
		const notifications: { message: string; type?: string }[] = [];
		const choices = [...(script.choices ?? [])];
		const answers = [...(script.answers ?? [])];
		const ctx = {
			hasUI: true,
			model: undefined,
			modelRegistry: { find: () => undefined, refresh: async () => {} },
			ui: {
				select: async (title: string, options: string[]) => {
					menus.push({ title, options });
					return choices.shift();
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
		return { menus, inputs, notifications, requests: broker.requests };
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
		expect(requests).toEqual([]);
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
		expect(JSON.parse(added.body)).toEqual({ provider: "claude", name: "work", key: "sk-ant-api03-test" });
		expect(notifications).toEqual([{ message: expect.stringContaining("Added Claude · a (API key)"), type: "info" }]);
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
		expect(loginRequest(requests)?.provider).toBe("codex");
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
		expect(loginRequest(requests)?.provider).toBe("codex");
	});

	it("/accounts add claude opens the Claude menu directly", async () => {
		const { menus, requests } = await runAccount("add claude", { choices: [undefined] });
		expect(menus).toEqual([{ title: "Add Claude account", options: claudeLabels }]);
		expect(requests).toEqual([]);
	});

	it("/accounts add claude-api-credits asks for a name and skips the menus", async () => {
		const { menus, inputs, notifications, requests } = await runAccount("add claude-api-credits", {
			answers: ["work"],
			respond: loginRoutes({ status: "ok", account: claudeCredits }),
		});
		expect(menus).toEqual([]);
		expect(inputs).toEqual(["Name for this API-credit account", "Waiting for the Claude Console sign-in"]);
		expect(loginRequest(requests)).toEqual({ provider: "claude-api-credits", name: "work" });
		expect(notifications.map((entry) => entry.message)).toEqual([
			expect.stringContaining("Sign in to the Claude Console in your browser"),
			expect.stringContaining("Added Claude · work (API credits)"),
		]);
	});

	it("warns with the valid arguments instead of passing an unknown one to the broker", async () => {
		const { menus, notifications, requests } = await runAccount("add gemini");
		expect(menus).toEqual([]);
		expect(requests).toEqual([]);
		expect(notifications).toEqual([
			{ message: `Unknown account type "gemini". Use one of: ${addArguments.join(", ")}.`, type: "warning" },
		]);
	});

	it("completes the add arguments instead of provider ids", async () => {
		const extension = await loadAccountsExtension(tempDir());
		const complete = async (prefix: string) =>
			((await extension.commands.get("accounts")!.getArgumentCompletions!(prefix)) ?? []).map((item) => item.value);
		expect(await complete("add ")).toEqual(addArguments.map((entry) => `add ${entry}`));
		expect(await complete("add claude-api")).toEqual(["add claude-api-credits", "add claude-api-key"]);
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
