import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClassifierApi,
	type ClassifierModel,
	createProvider,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
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
import { OMP_NATIVE_API, ompNativeStreams } from "../src/extensions/accounts/omp-native.ts";
import { createAccountProvider } from "../src/extensions/accounts/provider.ts";
import { createLlamaProvider } from "../src/extensions/llama/provider.ts";
import { migrateAuthToAuthJson } from "../src/migrations.ts";
import { ompTurn, sseResponse } from "./omp-native-test-utils.ts";

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
const model: Model<typeof OMP_NATIVE_API> = {
	id: "chat-test",
	name: "Chat test",
	provider: "acct:openai-test",
	api: OMP_NATIVE_API,
	baseUrl: "https://ignored.invalid/v1",
	contextWindow: 10_000,
	maxTokens: 100,
	reasoning: false,
	input: ["text"],
	cost,
};
const classifier: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: "gpt-6-luna",
	name: "Luna",
	provider: model.provider,
	api: "typesafe-system-one",
	baseUrl: model.baseUrl,
	input: ["text"],
	cost,
	contextWindow: 10_000,
};
const jevClassifier: ClassifierModel<"typesafe-system-one"> = {
	...classifier,
	id: "jev-latest",
	name: "Jev",
	api: "typesafe-system-one",
	input: ["text", "image"],
	compat: { imageInput: "assets", sendImageOptInHeader: true },
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

function brokerProvider(classifiers: ClassifierModel<ClassifierApi>[] = [classifier]) {
	const client = new BrokerClient({ home: agentDir, locateBinary: () => undefined });
	vi.spyOn(client, "connect").mockResolvedValue({ url: brokerUrl, token: "broker-token", pid: 1 });
	return createAccountProvider(
		{
			id: model.provider,
			name: "OpenAI test",
			target: { type: "account", key: "QWNjb3VudA" },
			disabled: false,
			models: [model],
			classifiers,
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
		fetchBroker.mockResolvedValue(Response.json({ answers: { approved: { type: "noul", noul: 0.9 } } }));
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
		expect(String(url)).toBe(`${route}/systemone`);
		expect(headers.get("authorization")).toBe("Bearer broker-token");
		expect(headers.has("x-api-key")).toBe(false);
		expect(headers.get("x-test")).toBe("ok");
		expect(JSON.parse(await new Response(init?.body).text())).toMatchObject({ model: "gpt-6-luna" });
	});

	it("streams chat through the trusted account adapter to the broker route, ignoring caller-supplied credentials and routes", async () => {
		const runtime = await ModelRuntime.create({ modelsPath: null });
		runtime.registerNativeProvider(brokerProvider(), "builtin:accounts");
		await runtime.refresh();
		fetchBroker.mockImplementation(async () =>
			sseResponse(ompTurn({ model: model.id }).start().text("hello").done("stop", { input: 3, output: 1 }).sse(), {
				headers: { "x-credne-account": "QWNjb3VudA" },
			}),
		);
		const fetch = captureFetch(() => Response.json({}));
		const onResponse = vi.fn();
		const message = await runtime.completeSimple(
			{ ...model, baseUrl: "https://caller.invalid" },
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				fetch,
				apiKey: "caller-key",
				headers: { Authorization: "Bearer caller-key", "x-api-key": "caller-key", "x-test": "ok" },
				transformHeaders: (headers) => ({ ...headers, authorization: "Bearer transform-key" }),
				onResponse,
			},
		);

		expect(message).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "hello" }] });
		expect(fetch).not.toHaveBeenCalled();
		expect(fetchBroker).toHaveBeenCalledOnce();
		const [url, init] = fetchBroker.mock.calls[0]!;
		const headers = new Headers(init?.headers);
		expect(String(url)).toBe(`${route}/pi/stream`);
		expect(headers.get("authorization")).toBe("Bearer broker-token");
		expect(headers.has("x-api-key")).toBe(false);
		// Caller headers are provider-request headers, which oh-my-pi sends; the hop to the broker carries none.
		expect(headers.has("x-test")).toBe(false);
		const body = JSON.parse(await new Response(init?.body).text()) as {
			modelId: string;
			options: { headers?: Record<string, string> };
		};
		expect(body.modelId).toBe("chat-test");
		expect(body.options.headers).toEqual({ "x-test": "ok" });
		expect(onResponse).toHaveBeenCalledWith(
			{ status: 200, headers: expect.objectContaining({ "x-credne-account": "QWNjb3VudA" }) },
			expect.objectContaining({ provider: model.provider, id: model.id }),
		);
	});

	it("routes a Jev classifier to the broker's systemone path and keeps the image opt-in header", async () => {
		const runtime = await ModelRuntime.create({ modelsPath: null });
		runtime.registerNativeProvider(brokerProvider([jevClassifier]), "builtin:accounts");
		await runtime.refresh();
		expect(await runtime.getAvailableOfType("classifier")).toEqual([jevClassifier]);
		fetchBroker.mockResolvedValue(Response.json({ answers: { approved: { type: "noul", noul: 0.9 } } }));
		const fetch = captureFetch(() => Response.json({}));
		const context = {
			...classifierContext,
			images: [{ type: "image" as const, data: "aGk=", mimeType: "image/png" }],
		};
		const result = await runtime.classify({ ...jevClassifier, baseUrl: "https://caller.invalid" }, context, {
			fetch,
			apiKey: "caller-key",
			headers: { Authorization: "Bearer caller-key" },
		});

		expect(result.stopReason).toBe("stop");
		expect(fetch).not.toHaveBeenCalled();
		expect(fetchBroker).toHaveBeenCalledOnce();
		const [url, init] = fetchBroker.mock.calls[0]!;
		const headers = new Headers(init?.headers);
		expect(String(url)).toBe(`${route}/systemone`);
		expect(headers.get("authorization")).toBe("Bearer broker-token");
		expect(headers.get("typesafe-danger-zone-images")).toBe("true");
		expect(JSON.parse(await new Response(init?.body).text())).toMatchObject({ model: "jev-latest" });
	});

	it("fails closed if an account provider resolves no loopback route", async () => {
		const runtime = await ModelRuntime.create({ modelsPath: null });
		runtime.registerNativeProvider(
			createProvider({
				id: model.provider,
				models: [model],
				api: ompNativeStreams(() => undefined),
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
					version: 3,
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

describe("local llama.cpp catalog refresh", () => {
	const refreshLlama = (provider: ReturnType<typeof createLlamaProvider>["provider"]) =>
		provider.refreshModels!({
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

	it("treats no server at the default URL as no local models instead of a refresh error", async () => {
		vi.stubEnv("LLAMA_BASE_URL", "");
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
		try {
			const llama = createLlamaProvider();
			await expect(refreshLlama(llama.provider)).resolves.toBeUndefined();
			expect(fetch).toHaveBeenCalledOnce();
			expect(String(fetch.mock.calls[0]![0])).toBe("http://127.0.0.1:9931/models");
			expect(llama.provider.getModels()).toEqual([]);
		} finally {
			fetch.mockRestore();
		}
	});

	it("reports an unreachable server that LLAMA_BASE_URL names", async () => {
		vi.stubEnv("LLAMA_BASE_URL", "http://127.0.0.1:9310");
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
		try {
			await expect(refreshLlama(createLlamaProvider().provider)).rejects.toThrow(
				"Could not reach llama.cpp server at http://127.0.0.1:9310",
			);
		} finally {
			fetch.mockRestore();
		}
	});
});
