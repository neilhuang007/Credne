import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClassifierModel, createProvider, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as configSource from "../src/config.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { readStoredCredential } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type * as brokerSource from "../src/extensions/accounts/client.ts";
import { BrokerClient } from "../src/extensions/accounts/client.ts";
import { createAccountProvider } from "../src/extensions/accounts/provider.ts";
import { createLlamaProvider } from "../src/extensions/llama/provider.ts";
import { migrateAuthToAuthJson } from "../src/migrations.ts";

vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof configSource>()),
	USES_BROKER_AUTH: true,
}));
const fetchBroker = vi.hoisted(() => vi.fn());
vi.mock("../src/extensions/accounts/client.ts", async (importOriginal) => ({
	...(await importOriginal<typeof brokerSource>()),
	fetchBroker,
}));

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const model: Model<"openai-completions"> = {
	id: "chat-test",
	name: "Chat test",
	provider: "acct:openai-test",
	api: "openai-completions",
	baseUrl: "https://ignored.invalid/v1",
	contextWindow: 10_000,
	maxTokens: 100,
	reasoning: false,
	input: ["text"],
	cost,
};
const classifier: ClassifierModel<"openai-decisions"> = {
	type: "classifier",
	id: "gpt-6-luna",
	name: "Luna",
	provider: model.provider,
	api: "openai-decisions",
	baseUrl: model.baseUrl,
	input: ["text"],
	cost,
	contextWindow: 10_000,
};
const brokerUrl = "http://127.0.0.1:12345";
const route = `${brokerUrl}/credne/v1/route/a.QWNjb3VudA`;
const jsonAuth = JSON.stringify({ openai: { type: "api_key", key: "disk-key" } });

let agentDir: string;

beforeEach(() => {
	fetchBroker.mockReset();
	agentDir = mkdtempSync(join(tmpdir(), "credne-auth-test-"));
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("OPENAI_API_KEY", "ambient-openai");
	vi.stubEnv("COPILOT_GITHUB_TOKEN", "ambient-copilot");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

function brokerProvider() {
	const client = new BrokerClient({ home: agentDir, locateBinary: () => undefined });
	vi.spyOn(client, "connect").mockResolvedValue({ url: brokerUrl, token: "broker-token", pid: 1 });
	return createAccountProvider(
		{
			id: model.provider,
			name: "OpenAI test",
			target: { type: "account", key: "QWNjb3VudA" },
			disabled: false,
			models: [model],
			classifiers: [classifier],
		},
		client,
	);
}

const classifierContext = {
	state: { text: "ok" },
	questions: {
		approved: { type: "bool" as const, instructions: "Approved?", criteria: { true: "Yes", false: "No" } },
	},
};

function captureFetch(response: () => Response) {
	return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response());
}

describe("Credne broker authentication", () => {
	it("does not read or migrate native credentials, expose native models, or accept static provider registration", async () => {
		writeFileSync(join(agentDir, "auth.json"), jsonAuth);
		writeFileSync(join(agentDir, "oauth.json"), '{"openai-codex":{"access":"legacy"}}');
		writeFileSync(join(agentDir, "models.json"), '{"providers":{"openai":{"apiKey":"inline-key"}}}');
		const injected = new InMemoryCredentialStore();
		const read = vi.spyOn(injected, "read");
		const list = vi.spyOn(injected, "list");
		const runtime = await ModelRuntime.create({ credentials: injected, allowModelNetwork: true });

		expect(runtime.getProviders()).toEqual([]);
		expect(runtime.getAllModels()).toEqual([]);
		expect(await runtime.getAuth("openai", { apiKey: "override" })).toBeUndefined();
		expect(await runtime.checkAuth("github-copilot")).toBeUndefined();
		expect(read).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
		expect(() => runtime.registerProvider("openai", { apiKey: "extension-key" })).toThrow("/accounts");
		expect(() => runtime.registerNativeProvider(brokerProvider(), "/tmp/extension.ts")).toThrow("/accounts");
		await expect(runtime.setRuntimeApiKey("openai", "runtime-key")).rejects.toThrow("/accounts");
		const prompt = vi.fn(async () => "native-token");
		await expect(runtime.login("openai", "oauth", { prompt, notify: vi.fn() })).rejects.toThrow("/accounts");
		expect(prompt).not.toHaveBeenCalled();
		await expect(runtime.logout("openai")).rejects.toThrow("/accounts");
		expect(readStoredCredential("openai")).toBeUndefined();
		expect(migrateAuthToAuthJson()).toEqual([]);
		expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toBe(jsonAuth);
		expect(readFileSync(join(agentDir, "oauth.json"), "utf8")).toContain("legacy");
	});

	it("warns about unsupported extension provider registration without hiding malformed registrations", async () => {
		const modelRuntime = await ModelRuntime.create({ modelsPath: null });
		const trusted = brokerProvider();
		modelRuntime.registerNativeProvider(trusted, "builtin:accounts");
		const { diagnostics } = await createAgentSessionServices({
			cwd: agentDir,
			agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.registerProvider({ ...trusted, id: "third-party" });
						pi.registerProvider({ ...trusted, id: "" });
					},
				],
			},
		});
		expect(diagnostics).toEqual([
			{ type: "warning", message: expect.stringContaining("Provider third-party cannot register") },
			{ type: "error", message: expect.stringContaining("Provider id must not be empty") },
		]);
		expect(modelRuntime.getAvailableSnapshot()).toEqual([model]);
		expect(modelRuntime.getProvider("third-party")).toBeUndefined();
	});

	it("uses the trusted account adapter for classifiers and ignores caller-supplied credentials and routes", async () => {
		const runtime = await ModelRuntime.create({ modelsPath: null });
		runtime.registerNativeProvider(brokerProvider(), "builtin:accounts");
		await runtime.refresh();
		expect(await runtime.getAvailableOfType("classifier")).toEqual([classifier]);
		fetchBroker.mockResolvedValue(
			Response.json({ answers: [{ type: "predicate", name: "approved", probability: 0.9 }] }),
		);
		const fetch = captureFetch(() => Response.json({}));
		const result = await runtime.classify({ ...classifier, baseUrl: "https://caller.invalid" }, classifierContext, {
			fetch,
			apiKey: "caller-key",
			headers: { Authorization: "Bearer caller-key", "x-api-key": "caller-key" },
			transformHeaders: (headers) => ({ ...headers, authorization: "Bearer transform-key", "x-test": "ok" }),
		});

		expect(result.stopReason).toBe("stop");
		expect(fetch).not.toHaveBeenCalled();
		expect(fetchBroker).toHaveBeenCalledOnce();
		const [url, init] = fetchBroker.mock.calls[0]!;
		const headers = new Headers(init?.headers);
		expect(String(url)).toBe(`${route}/decisions`);
		expect(headers.get("authorization")).toBe("Bearer broker-token");
		expect(headers.has("x-api-key")).toBe(false);
		expect(headers.get("x-test")).toBe("ok");
	});

	it("fails closed if an account provider resolves no loopback route", async () => {
		const runtime = await ModelRuntime.create({ modelsPath: null });
		runtime.registerNativeProvider(
			createProvider({
				id: model.provider,
				models: [model],
				api: openAICompletionsApi(),
				auth: {
					apiKey: { name: "Invalid", resolve: async () => ({ auth: { apiKey: "bad", baseUrl: model.baseUrl } }) },
				},
			}),
			"builtin:accounts",
		);
		const fetch = captureFetch(() => Response.json({}));
		const result = await runtime.completeSimple(model, { messages: [] }, { fetch });
		expect(result.errorMessage).toContain("Missing broker credentials or route");
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		{ selection: undefined, final: undefined, expected: undefined },
		{ selection: "pool:all", final: undefined, expected: "pool:all" },
		{ selection: "pool:all", final: model.provider, expected: model.provider },
	])(
		"restores the headless SDK's cached provider from its explicit agent dir ($expected)",
		async ({ selection, final, expected }) => {
			const explicitDir = join(agentDir, "sdk-agent");
			mkdirSync(join(explicitDir, "accounts"), { recursive: true });
			writeFileSync(
				join(explicitDir, "accounts", "catalog.json"),
				JSON.stringify({
					version: 2,
					accounts: [
						{
							id: "openai-test",
							key: "QWNjb3VudA",
							provider: "openai-api",
							disabled: false,
							models: [model],
						},
					],
					pools: [],
				}),
			);
			const sessionManager = SessionManager.inMemory();
			if (selection) {
				sessionManager.appendModelChange(selection, model.id);
				sessionManager.appendMessage({
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					timestamp: 1,
					content: [{ type: "text", text: "Old virtual pool response served by the API-key account" }],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } },
				});
			}
			if (final) sessionManager.appendModelChange(final, model.id);
			const { session } = await createAgentSession({ cwd: agentDir, agentDir: explicitDir, sessionManager });
			expect(session.model?.id).toBe(model.id);
			if (expected) expect(session.model?.provider).toBe(expected);
			expect(session.modelRuntime.getProviders().map(({ id }) => id)).toContain(model.provider);
			expect(await session.modelRuntime.getAuth("openai")).toBeUndefined();
		},
	);

	it("keeps local llama available without using LLAMA_API_KEY and does not authorize remote llama", async () => {
		vi.stubEnv("LLAMA_API_KEY", "ambient-llama");
		vi.stubEnv("LLAMA_BASE_URL", "http://127.0.0.1:9310");
		const runtime = await ModelRuntime.create({ modelsPath: null });
		const local = createLlamaProvider();
		local.setCatalog([{ id: "local-model", status: { value: "loaded" } }], "http://127.0.0.1:9310");
		runtime.registerNativeProvider(local.provider, "builtin:llama.cpp");
		const chatModel = runtime.getModel("llama.cpp", "local-model")!;
		const fetch = captureFetch(
			() => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }),
		);
		await runtime.completeSimple(chatModel, { messages: [] }, { apiKey: "ignored-caller-key", fetch });
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0]!;
		expect(String(url)).toBe("http://127.0.0.1:9310/v1/chat/completions");
		expect(new Headers(init?.headers).has("authorization")).toBe(false);
		vi.stubEnv("LLAMA_BASE_URL", "https://remote.invalid:9310");
		runtime.registerNativeProvider(createLlamaProvider().provider, "builtin:llama.cpp");
		expect(await runtime.getAuth("llama.cpp")).toBeUndefined();
	});
});
