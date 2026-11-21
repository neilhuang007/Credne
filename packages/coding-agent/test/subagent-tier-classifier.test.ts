// Covers the tier classifier in subagent and planned dispatch: when it runs, with which backend, what it is sent, which tier and effort it picks, and how every failure falls back.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	ClassifierAnswer,
	ClassifierApi,
	ClassifierModel,
	ClassifierResult,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, type Mock, type MockInstance, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ExtensionToolContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import planningExtension from "../src/extensions/planning/index.ts";
import subagentExtension from "../src/extensions/subagent/index.ts";
import { emptyUsage, type SingleResult } from "../src/extensions/subagent/runner.ts";
import { getWorkerTeam, type WorkerTeam } from "../src/extensions/subagent/team.ts";
import {
	classifyTiers,
	type TierRequest,
	tierClassificationEntryType,
} from "../src/extensions/subagent/tier-classifier.ts";

const parentProvider = "test-provider";
const parentEffort = "low";
const claudePool = ["parent", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"];
// What each tier dispatches on the pool above: model and reasoning effort.
const lightRoute = { model: "test-provider/claude-haiku-5-5", thinkingLevel: "medium" };
const mediumRoute = { model: "test-provider/claude-opus-5-5", thinkingLevel: "xhigh" };
const heavyRoute = { model: "test-provider/claude-fable-5-2", thinkingLevel: "xhigh" };

const usage: Usage = {
	input: 120,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0.000012, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000012 },
};

function chatModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: parentProvider,
		baseUrl: "https://provider.invalid/v1",
		input: ["text"],
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: null },
		cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.2 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function classifierModel(provider: string, id: string): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id,
		name: id,
		api: "typesafe-system-one",
		provider,
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64_000,
	};
}

const luna = classifierModel("openai", "gpt-6-luna");
const jev = classifierModel("typesafe", "jev-latest");
const clef = classifierModel("openrouter", "cloudflare/clef");

function answerOf(
	model: ClassifierModel<ClassifierApi>,
	tier: ClassifierAnswer | undefined,
	extra: Partial<ClassifierResult> = {},
): ClassifierResult {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: tier ? { tier } : {},
		usage,
		stopReason: "stop",
		timestamp: 0,
		...extra,
	};
}

/** A score answer with per-level probabilities, lowest level first. */
function levels(probabilities: number[], score = 1): (model: ClassifierModel<ClassifierApi>) => ClassifierResult {
	return (model) => answerOf(model, { type: "score", score, confidence: Math.max(...probabilities), probabilities });
}

type Classify = (
	model: ClassifierModel<ClassifierApi>,
	context: { state: Record<string, unknown>; questions: Record<string, unknown> },
	options?: { signal?: AbortSignal },
) => Promise<ClassifierResult>;

type GetAvailableOfType = (
	type: string,
	provider: string | undefined,
	options: { signal: AbortSignal },
) => Promise<ClassifierModel<ClassifierApi>[]>;

type StreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => { result(): Promise<AssistantMessage> };

const chatAnswer = '{"model": "heavy", "effort": "xhigh"}';

/** A chat model's reply: one text block, as a provider's final message holds it. */
function chatReply(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: parentProvider,
		model: "claude-haiku-5-5",
		usage,
		stopReason: "stop",
		timestamp: 0,
		...extra,
	};
}

/** A chat stream that answers with the text at once. */
function replying(text: string, extra: Partial<AssistantMessage> = {}): StreamSimple {
	return () => ({ result: async () => chatReply(text, extra) });
}

/** A chat stream that hangs until the call's signal aborts, then ends the way the registry's streams do. */
function streamHangingUntilAborted(): StreamSimple {
	return (_model, _context, options) => ({
		result: () =>
			new Promise((resolve) =>
				options?.signal?.addEventListener(
					"abort",
					() => resolve(chatReply("", { stopReason: "aborted", errorMessage: "aborted" })),
					{ once: true },
				),
			),
	});
}

/** The extension API and context a dispatching tool needs, with a fake registry and classifier behind them. */
interface Fixture {
	directory: string;
	tools: Map<string, ToolDefinition>;
	pi: ExtensionAPI;
	ctx: ExtensionToolContext;
	team: WorkerTeam;
	/** The `subagents.tierClassifier` setting; undefined leaves it unset. */
	mode: unknown;
	/** The classifier models the registry reports as available. */
	available: ClassifierModel<ClassifierApi>[];
	/** The chat models of the current account; a test may edit them. */
	models: Model<Api>[];
	classify: Mock<Classify>;
	getAvailableOfType: Mock<GetAvailableOfType>;
	/** The chat side request the registry streams; answers `chatAnswer` unless a test says otherwise. */
	streamSimple: Mock<StreamSimple>;
	appendEntry: Mock;
	spawn: MockInstance<WorkerTeam["spawn"]>;
}

function completed(task: string): SingleResult {
	return {
		agent: "worker",
		agentSource: "builtin",
		task,
		status: "completed",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
	};
}

function agentFile(name: string, frontmatter: string[]): string {
	return ["---", `name: ${name}`, `description: ${name} test agent`, ...frontmatter, "---", `Body of ${name}`].join(
		"\n",
	);
}

function createFixture(extension: ExtensionFactory): Fixture {
	const directory = mkdtempSync(join(tmpdir(), "pi-tier-classifier-"));
	const agentsDir = join(directory, CONFIG_DIR_NAME, "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "pinned.md"), agentFile("pinned", ["model: sonnet", "tier: light"]));
	writeFileSync(join(agentsDir, "plain.md"), agentFile("plain", []));
	const tools = new Map<string, ToolDefinition>();
	const appendEntry = vi.fn();
	const classify = vi.fn<Classify>(async (model) => levels([0.04, 0.06, 0.9])(model));
	const getAvailableOfType = vi.fn<GetAvailableOfType>(async () => fixture.available);
	const streamSimple = vi.fn<StreamSimple>(replying(chatAnswer));
	const pi = {
		on: vi.fn(),
		registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
		registerCommand: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(),
		getThinkingLevel: () => "off",
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: vi.fn(),
		sendMessage: vi.fn(),
		appendEntry,
		getSettings: () => (fixture.mode === undefined ? {} : { subagents: { tierClassifier: fixture.mode } }),
	} as unknown as ExtensionAPI;
	extension(pi);
	const models = claudePool.map(chatModel);
	const ctx = {
		cwd: directory,
		hasUI: false,
		model: models[0],
		thinkingLevel: parentEffort,
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "tier-classifier-test", getBranch: () => [] },
		modelRegistry: {
			getAvailable: () => models,
			getAll: () => models,
			find: (provider: string, id: string) =>
				models.find((candidate) => candidate.provider === provider && candidate.id === id),
			getAvailableOfType,
			classify,
			streamSimple,
		},
	} as unknown as ExtensionToolContext;
	const team = getWorkerTeam(pi, ctx);
	let spawned = 0;
	const spawn = vi.spyOn(team, "spawn").mockImplementation((input) => ({
		id: `worker-${++spawned}`,
		result: Promise.resolve(completed(input.task)),
	}));
	const fixture: Fixture = {
		directory,
		tools,
		pi,
		ctx,
		team,
		mode: "shadow",
		available: [luna],
		models,
		classify,
		getAvailableOfType,
		streamSimple,
		appendEntry,
		spawn,
	};
	return fixture;
}

async function disposeFixture(fixture: Fixture): Promise<void> {
	await fixture.team.dispose();
	rmSync(fixture.directory, { recursive: true, force: true });
}

/** The classification entries a fixture has recorded. */
function recorded(fixture: Fixture) {
	return fixture.appendEntry.mock.calls.flatMap(([type, entry]) =>
		type === tierClassificationEntryType ? [entry] : [],
	);
}

/** The route each spawned worker was given. */
function routes(fixture: Fixture) {
	return fixture.spawn.mock.calls.map(([input]) => ({
		model: input.defaults.model,
		thinkingLevel: input.defaults.thinkingLevel,
	}));
}

/** Hangs until the call's signal aborts, then answers like an adapter does. */
function hangUntilAborted(): Classify {
	return (model, _context, options) =>
		new Promise((resolve) =>
			options?.signal?.addEventListener(
				"abort",
				() => resolve(answerOf(model, undefined, { stopReason: "aborted", errorMessage: "aborted" })),
				{ once: true },
			),
		);
}

describe("tier classifier in the subagent tool", () => {
	let f: Fixture;

	beforeEach(() => {
		f = createFixture(subagentExtension);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await disposeFixture(f);
	});

	/** Runs the subagent tool in the background against project and bundled agents. */
	async function dispatch(params: Record<string, unknown>, signal?: AbortSignal) {
		await f.tools
			.get("subagent")!
			.execute(
				"call",
				{ agentScope: "project", confirmProjectAgents: false, background: true, ...params },
				signal,
				undefined,
				f.ctx,
			);
		return routes(f);
	}

	describe("modes", () => {
		it("does nothing when off: no lookup, no call, no entry, not even a chat request", async () => {
			f.mode = "off";
			f.available = [];
			expect(await dispatch({ agent: "worker", task: "Fix the parser" })).toEqual([mediumRoute]);

			expect(f.getAvailableOfType).not.toHaveBeenCalled();
			expect(f.classify).not.toHaveBeenCalled();
			expect(f.streamSimple).not.toHaveBeenCalled();
			expect(f.appendEntry).not.toHaveBeenCalled();
		});

		it("applies the rated tier by default, when the setting is unset or invalid", async () => {
			for (const value of [undefined, "banana"]) {
				f.mode = value;
				expect((await dispatch({ agent: "worker", task: "Redesign the cache" })).at(-1)).toEqual(heavyRoute);
			}

			expect(f.classify).toHaveBeenCalledTimes(2);
		});

		it("classifies in shadow mode, records the rating, and dispatches the profile's tier", async () => {
			expect(await dispatch({ agent: "worker", task: "Fix the parser" })).toEqual([mediumRoute]);

			expect(f.classify).toHaveBeenCalledOnce();
			expect(f.appendEntry).toHaveBeenCalledWith(tierClassificationEntryType, {
				backend: "decision",
				mode: "shadow",
				agent: "worker",
				profileTier: "medium",
				classifier: "openai/gpt-6-luna",
				latencyMs: expect.any(Number),
				usage,
				outcome: "classified",
				tier: "heavy",
				probabilities: { light: 0.04, medium: 0.06, heavy: 0.9 },
				score: 1,
				applied: false,
			});
		});

		it("dispatches the classified tier in apply mode when its probability reaches 0.7", async () => {
			f.mode = "apply";
			f.classify.mockImplementation(async (model) => levels([0.04, 0.06, 0.9])(model));
			expect(await dispatch({ agent: "worker", task: "Redesign the cache" })).toEqual([heavyRoute]);

			f.spawn.mockClear();
			f.classify.mockImplementation(async (model) => levels([0.7, 0.2, 0.1])(model));
			expect(await dispatch({ agent: "worker", task: "Rename a variable" })).toEqual([lightRoute]);
			expect(recorded(f).map((entry) => [entry.tier, entry.applied])).toEqual([
				["heavy", true],
				["light", true],
			]);
		});

		it("keeps the profile's tier in apply mode below 0.7, and still records the rating", async () => {
			f.mode = "apply";
			f.classify.mockImplementation(async (model) => levels([0.1, 0.31, 0.59])(model));

			expect(await dispatch({ agent: "worker", task: "Fix the parser" })).toEqual([mediumRoute]);
			expect(recorded(f)[0]).toMatchObject({ outcome: "classified", tier: "heavy", applied: false });
		});

		it("takes the level with the highest probability, not the averaged score or the confidence", async () => {
			f.mode = "apply";
			// The score and confidence point at medium, the probabilities at heavy.
			f.classify.mockImplementation(async (model) =>
				answerOf(model, { type: "score", score: 1, confidence: 0.99, probabilities: [0.1, 0.1, 0.8] }),
			);

			expect(await dispatch({ agent: "worker", task: "Fix the parser" })).toEqual([heavyRoute]);
		});

		it("replaces the profile's tier, so a profile without a tier is classified too", async () => {
			f.mode = "apply";

			expect(await dispatch({ agent: "plain", task: "Redesign the cache" })).toEqual([heavyRoute]);
			expect(recorded(f)[0]).toMatchObject({ agent: "plain", applied: true });
			expect(recorded(f)[0].profileTier).toBeUndefined();
		});

		it("rates the critic, whose default tier is heavy, like any other profile", async () => {
			f.mode = "apply";
			f.classify.mockImplementation(async (model) => levels([0.9, 0.05, 0.05])(model));

			expect(await dispatch({ agent: "critic", task: "Review the diff" })).toEqual([lightRoute]);
			expect(recorded(f)[0]).toMatchObject({ agent: "critic", profileTier: "heavy", tier: "light" });
		});
	});

	describe("when it does not run", () => {
		it.each([
			["an explicit model", { model: "haiku" }],
			["an explicit tier", { tier: "light" }],
		])("skips a task with %s, on the item and at the top level", async (_name, choice) => {
			f.mode = "apply";
			f.available = [];
			await dispatch({ agent: "worker", task: "Fix the parser", ...choice });
			await dispatch({ ...choice, tasks: [{ agent: "worker", task: "Fix the parser" }] });
			await dispatch({ tasks: [{ agent: "worker", task: "Fix the parser", ...choice }] });

			expect(f.classify).not.toHaveBeenCalled();
			expect(f.streamSimple).not.toHaveBeenCalled();
			expect(f.getAvailableOfType).not.toHaveBeenCalled();
			expect(f.appendEntry).not.toHaveBeenCalled();
		});

		it("skips a profile that pins a model, even when it also has a tier", async () => {
			f.mode = "apply";
			f.available = [];
			const dispatched = await dispatch({ agent: "pinned", task: "Redesign the cache" });

			expect(f.classify).not.toHaveBeenCalled();
			expect(f.streamSimple).not.toHaveBeenCalled();
			expect(dispatched[0].model).toBe("test-provider/claude-sonnet-5-5");
		});

		it("still classifies when only the reasoning effort is chosen", async () => {
			f.mode = "apply";
			const dispatched = await dispatch({ agent: "worker", task: "Fix the parser", reasoningEffort: "high" });

			expect(f.classify).toHaveBeenCalledOnce();
			expect(dispatched).toEqual([{ model: heavyRoute.model, thinkingLevel: "high" }]);
		});
	});

	describe("fallbacks", () => {
		async function expectFallback(reason: string, message?: string) {
			expect(await dispatch({ agent: "worker", task: "Fix the parser" })).toEqual([mediumRoute]);
			expect(recorded(f)).toHaveLength(1);
			expect(recorded(f)[0]).toMatchObject({
				mode: "apply",
				outcome: "failed",
				reason,
				...(message === undefined ? {} : { message }),
			});
		}

		beforeEach(() => {
			f.mode = "apply";
		});

		it("falls back when the classifier returns an error result", async () => {
			f.classify.mockImplementation(async (model) =>
				answerOf(model, undefined, { stopReason: "error", errorMessage: "OpenAI Decisions returned 500" }),
			);

			await expectFallback("error", "OpenAI Decisions returned 500");
			// The usage the classifier reported is recorded even for a failure.
			expect(recorded(f)[0].usage).toEqual(usage);
		});

		it("falls back when the classifier rejects", async () => {
			f.classify.mockRejectedValue(new Error("socket closed"));

			await expectFallback("error", "socket closed");
		});

		it("falls back when the answer is missing, not a score, or has unusable level probabilities", async () => {
			const answers: (ClassifierAnswer | undefined)[] = [
				undefined,
				{ type: "bool", probability: 0.9 },
				{ type: "score", score: Number.NaN, confidence: 1, probabilities: [0, 0, 1] },
				{ type: "score", score: 1, confidence: 1, probabilities: [0.5, 0.5] },
				{ type: "score", score: 1, confidence: 1, probabilities: [0, 0.2, Number.NaN] },
			];
			for (const answer of answers) {
				f.appendEntry.mockClear();
				f.spawn.mockClear();
				f.classify.mockImplementation(async (model) => answerOf(model, answer));

				await expectFallback("malformed");
			}
		});

		it("falls back, recording the score, when the answer has no per-level probabilities", async () => {
			f.classify.mockImplementation(async (model) =>
				answerOf(model, { type: "score", score: 1.9, confidence: 0.95 }),
			);

			await expectFallback("no-level-probabilities");
			expect(recorded(f)[0].score).toBe(1.9);
		});

		it("gives up after three seconds and records a timeout", async () => {
			vi.useFakeTimers();
			f.classify.mockImplementation(hangUntilAborted());

			const pending = dispatch({ agent: "worker", task: "Fix the parser" });
			await vi.advanceTimersByTimeAsync(2_999);
			expect(f.spawn).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);

			expect(await pending).toEqual([mediumRoute]);
			expect(recorded(f)[0]).toMatchObject({ outcome: "failed", reason: "timeout", latencyMs: 3_000 });
		});

		it("gives up on a hanging lookup of classifiers after three seconds, then asks the chat model", async () => {
			vi.useFakeTimers();
			f.getAvailableOfType.mockImplementation(
				(_type, _provider, options) =>
					new Promise((_resolve, reject) =>
						options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
					),
			);

			const pending = dispatch({ agent: "worker", task: "Fix the parser" });
			await vi.advanceTimersByTimeAsync(2_999);
			expect(f.streamSimple).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);

			expect(await pending).toEqual([heavyRoute]);
			expect(f.classify).not.toHaveBeenCalled();
			expect(recorded(f).map((entry) => entry.backend)).toEqual(["chat"]);
		});

		it("stops waiting when the tool call is aborted", async () => {
			const controller = new AbortController();
			f.classify.mockImplementation(hangUntilAborted());

			const pending = dispatch({ agent: "worker", task: "Fix the parser" }, controller.signal);
			await vi.waitFor(() => expect(f.classify).toHaveBeenCalled());
			controller.abort();

			await pending;
			expect(recorded(f)[0]).toMatchObject({ outcome: "failed", reason: "aborted" });
		});
	});

	describe("choice of classifier", () => {
		const calledWith = () => f.classify.mock.calls.map(([model]) => `${model.provider}/${model.id}`);

		it("prefers gpt-6-luna over a Jev model, and a Jev model over any other", async () => {
			f.available = [clef, jev, luna];
			await dispatch({ agent: "worker", task: "Fix the parser" });
			f.available = [clef, jev];
			await dispatch({ agent: "worker", task: "Fix the parser" });
			f.available = [clef];
			await dispatch({ agent: "worker", task: "Fix the parser" });

			expect(calledWith()).toEqual(["openai/gpt-6-luna", "typesafe/jev-latest", "openrouter/cloudflare/clef"]);
			expect(recorded(f).map((entry) => entry.classifier)).toEqual(calledWith());
		});

		it("takes the first of equally ranked models", async () => {
			f.available = [classifierModel("local", "kev"), clef];
			await dispatch({ agent: "worker", task: "Fix the parser" });

			expect(calledWith()).toEqual(["local/kev"]);
		});
	});

	describe("chat backend", () => {
		const lightText =
			"Repeatable, well-defined tasks: exploring a codebase or database; searching files and the web; making small edits and extracting fields when the expected result is clear; classification and routing.";
		const mediumText =
			"Everyday coding: fixing bugs and adding features; working through multistep tasks that need testing and revision along the way.";
		const heavyText =
			"Long-horizon agentic work: solving open-ended problems that require weighing trade-offs; planning and carrying out complex projects, adjusting the approach as new information comes in; reviewing written code to give strategic guidance or course correction.";
		const systemPrompt = `You rate a task that a coding agent is about to delegate to a subagent. Reply with one JSON object and nothing else, in this form: {"model": "heavy", "effort": "xhigh"}.

model is one of light, medium, heavy or default.
- light: ${lightText}
- medium: ${mediumText}
- heavy: ${heavyText}

effort is one of low, medium, high, xhigh or default.
- low: Simple tasks.
- medium: Most workflows.
- high: Intelligence-sensitive work.
- xhigh: Complex or long-running tasks.

Answer default for a field when the task does not clearly fit one value.`;
		const lightModelId = "claude-haiku-5-5";
		const lightModel = (): Model<Api> => f.models.find((model) => model.id === lightModelId)!;
		const task = { agent: "worker", task: "Redesign the cache" };

		beforeEach(() => {
			f.mode = "apply";
			f.available = [];
		});

		/** Rates the task with the chat model, which answers with the text. */
		async function dispatchRated(answer: string, params: Record<string, unknown> = task) {
			f.streamSimple.mockImplementation(replying(answer));
			return await dispatch(params);
		}

		describe("when it runs", () => {
			it("is not used while a classifier model is available", async () => {
				f.available = [luna];

				await dispatch(task);

				expect(f.classify).toHaveBeenCalledOnce();
				expect(f.streamSimple).not.toHaveBeenCalled();
				expect(recorded(f).map((entry) => entry.backend)).toEqual(["decision"]);
			});

			it("takes over when no classifier model is available, or looking up classifiers fails", async () => {
				await dispatch(task);
				f.getAvailableOfType.mockRejectedValue(new Error("credential store unreadable"));
				await dispatch(task);

				expect(f.streamSimple).toHaveBeenCalledTimes(2);
				expect(f.classify).not.toHaveBeenCalled();
				expect(recorded(f).map((entry) => entry.backend)).toEqual(["chat", "chat"]);
			});

			it("asks the light-tier model of the account, whatever the profile's tier is", async () => {
				await dispatch({ agent: "critic", task: "Review the diff" });

				expect(f.streamSimple).toHaveBeenCalledOnce();
				expect(f.streamSimple.mock.calls[0][0]).toBe(lightModel());
				expect(recorded(f)[0]).toMatchObject({ agent: "critic", classifier: `test-provider/${lightModelId}` });
			});

			it("rates nothing, and records nothing, when the account has no light-tier model", async () => {
				f.models.splice(f.models.indexOf(lightModel()), 1);

				expect(await dispatch(task)).toEqual([mediumRoute]);

				expect(f.streamSimple).not.toHaveBeenCalled();
				expect(f.appendEntry).not.toHaveBeenCalled();
			});

			it("rates nothing, and records nothing, when the serving account is unknown", async () => {
				const unknownAccount = {
					models: () => {
						throw new Error("The parent pool's serving account is unknown.");
					},
				};
				const request: TierRequest = {
					agent: { name: "worker", tier: "medium" },
					work: { kind: "task", task: "Fix the parser" },
				};

				expect(await classifyTiers(f.pi, unknownAccount, [request], f.ctx, undefined)).toEqual([undefined]);

				expect(f.streamSimple).not.toHaveBeenCalled();
				expect(f.appendEntry).not.toHaveBeenCalled();
			});

			it("is off when the mode is off, and skips the tasks the classifier skips", async () => {
				f.mode = "off";
				await dispatch(task);
				f.mode = "apply";
				await dispatch({ ...task, tier: "light" });
				await dispatch({ ...task, model: "haiku" });
				await dispatch({ agent: "pinned", task: task.task });

				expect(f.streamSimple).not.toHaveBeenCalled();
				expect(f.appendEntry).not.toHaveBeenCalled();
			});
		});

		describe("request", () => {
			it("sends the system prompt, and the state as JSON in one user message, and nothing else", async () => {
				await dispatch({ agent: "worker", task: "Fix the parser" });

				const [, context] = f.streamSimple.mock.calls[0];
				expect(context.systemPrompt).toBe(systemPrompt);
				expect(context.messages).toEqual([
					{ role: "user", content: '{"task":"Fix the parser"}', timestamp: expect.any(Number) },
				]);
				expect(context.tools).toBeUndefined();
			});

			it("puts the three level descriptions of the classifier's question into the system prompt", async () => {
				f.available = [luna];
				await dispatch(task);
				f.available = [];
				await dispatch(task);

				const { criteria } = f.classify.mock.calls[0][1].questions.tier as { criteria: string[] };
				const prompt = f.streamSimple.mock.calls[0][1].systemPrompt;
				expect(criteria).toEqual([lightText, mediumText, heavyText]);
				for (const description of criteria) expect(prompt).toContain(description);
			});

			it("caps the reply, skips the cache, and ends with the call's deadline", async () => {
				await dispatch(task);

				const options = f.streamSimple.mock.calls[0][2];
				expect(options).toMatchObject({ maxTokens: 100, cacheRetention: "none" });
				expect(options?.signal).toBeInstanceOf(AbortSignal);
			});

			it.each<[string, Partial<Model<Api>>, string | undefined]>([
				["can switch reasoning off", {}, undefined],
				["cannot switch reasoning off", { thinkingLevelMap: { off: null } }, "minimal"],
				["has no reasoning", { reasoning: false }, undefined],
			])("asks for the lowest reasoning level when the model %s", async (_name, change, expected) => {
				Object.assign(lightModel(), change);

				await dispatch(task);

				expect(f.streamSimple.mock.calls[0][2]?.reasoning).toBe(expected);
			});

			it("sends one request for each task it rates, all at once", async () => {
				const releases: (() => void)[] = [];
				f.streamSimple.mockImplementation((_model, context) => ({
					result: () =>
						new Promise((resolve) =>
							releases.push(() =>
								resolve(
									chatReply(
										String(context.messages[0].content).includes("Redesign")
											? '{"model": "heavy", "effort": "xhigh"}'
											: '{"model": "light", "effort": "medium"}',
									),
								),
							),
						),
				}));

				const pending = dispatch({
					tasks: [
						{ agent: "worker", task: "Redesign the cache" },
						{ agent: "worker", task: "Rename a variable" },
						{ agent: "worker", task: "Pinned by the caller", tier: "medium" },
					],
				});
				await vi.waitFor(() => expect(releases).toHaveLength(2));
				for (const release of releases) release();

				expect(await pending).toEqual([heavyRoute, lightRoute, mediumRoute]);
				expect(f.spawn).toHaveBeenCalledTimes(3);
			});

			it("keeps the task text out of the recorded entry", async () => {
				await dispatch({ agent: "worker", task: "Rotate the production signing key" });

				expect(JSON.stringify(recorded(f))).not.toContain("signing key");
			});
		});

		describe("what it rates", () => {
			it("changes the tier and the effort in apply mode, and records what it did", async () => {
				expect(await dispatchRated('{"model": "heavy", "effort": "low"}')).toEqual([
					{ model: heavyRoute.model, thinkingLevel: "low" },
				]);

				expect(f.spawn).toHaveBeenCalledOnce();
				expect(f.classify).not.toHaveBeenCalled();
				expect(recorded(f)).toEqual([
					{
						backend: "chat",
						mode: "apply",
						agent: "worker",
						profileTier: "medium",
						classifier: `test-provider/${lightModelId}`,
						latencyMs: expect.any(Number),
						usage,
						outcome: "classified",
						tier: "heavy",
						effort: "low",
						applied: { tier: true, effort: true },
					},
				]);
			});

			it("records and changes nothing in shadow mode", async () => {
				f.mode = "shadow";

				expect(await dispatchRated('{"model": "heavy", "effort": "low"}')).toEqual([mediumRoute]);

				expect(recorded(f)).toEqual([
					expect.objectContaining({
						backend: "chat",
						mode: "shadow",
						outcome: "classified",
						tier: "heavy",
						effort: "low",
						applied: { tier: false, effort: false },
					}),
				]);
			});

			it("uses the answer as given, with no probability to reach", async () => {
				expect(await dispatchRated('{"model": "light", "effort": "high"}')).toEqual([
					{ model: lightRoute.model, thinkingLevel: "high" },
				]);
			});

			it("keeps the profile's tier when the answer for the tier is default, and takes the effort", async () => {
				expect(await dispatchRated('{"model": "default", "effort": "low"}')).toEqual([
					{ model: mediumRoute.model, thinkingLevel: "low" },
				]);
				expect(recorded(f)[0]).toMatchObject({
					tier: "default",
					effort: "low",
					applied: { tier: false, effort: true },
				});
			});

			it("keeps the tier row's effort when the answer for the effort is default, and takes the tier", async () => {
				expect(await dispatchRated('{"model": "heavy", "effort": "default"}')).toEqual([heavyRoute]);
				expect(recorded(f)[0]).toMatchObject({
					tier: "heavy",
					effort: "default",
					applied: { tier: true, effort: false },
				});
			});

			it("changes nothing when both answers are default, and still records the rating", async () => {
				expect(await dispatchRated('{"model": "default", "effort": "default"}')).toEqual([mediumRoute]);
				expect(recorded(f)[0]).toMatchObject({ outcome: "classified", applied: { tier: false, effort: false } });
			});

			it("lets the caller's reasoningEffort beat the rated effort, and still takes the rated tier", async () => {
				expect(
					await dispatchRated('{"model": "heavy", "effort": "low"}', { ...task, reasoningEffort: "high" }),
				).toEqual([{ model: heavyRoute.model, thinkingLevel: "high" }]);
			});

			it("clamps a rated effort the model does not support, and does not reject it", async () => {
				Object.assign(lightModel(), { thinkingLevelMap: { max: null } });

				expect(await dispatchRated('{"model": "light", "effort": "xhigh"}')).toEqual([
					{ model: lightRoute.model, thinkingLevel: "high" },
				]);
			});

			it("applies the effort only when a tier row selects the model", async () => {
				// The plain profile has no tier, so without a rated tier the main agent's model and effort are inherited.
				expect(
					await dispatchRated('{"model": "default", "effort": "high"}', { agent: "plain", task: task.task }),
				).toEqual([{ model: "test-provider/parent", thinkingLevel: parentEffort }]);

				f.spawn.mockClear();
				expect(
					await dispatchRated('{"model": "heavy", "effort": "high"}', { agent: "plain", task: task.task }),
				).toEqual([{ model: heavyRoute.model, thinkingLevel: "high" }]);
			});

			it.each([
				["a code fence", 'Here is my rating:\n```json\n{"model": "light", "effort": "high"}\n```'],
				["prose", 'I rate it {"model": "light", "effort": "high"}. Hope that helps.'],
				["braces that are not JSON", 'Use {braces}: {"model": "light", "effort": "high"}'],
			])("takes the first JSON object out of %s", async (_name, answer) => {
				expect(await dispatchRated(answer)).toEqual([{ model: lightRoute.model, thinkingLevel: "high" }]);
			});

			it("reads the reply's text, not its reasoning", async () => {
				f.streamSimple.mockImplementation(
					replying("", {
						content: [
							{ type: "thinking", thinking: '{"model": "light", "effort": "low"}' },
							{ type: "text", text: '{"model": "heavy", ' },
							{ type: "text", text: '"effort": "high"}' },
						],
					}),
				);

				expect(await dispatch(task)).toEqual([{ model: heavyRoute.model, thinkingLevel: "high" }]);
			});

			it("uses a reply the token cap cut off after the object", async () => {
				f.streamSimple.mockImplementation(
					replying('{"model": "heavy", "effort": "high"} The task', { stopReason: "length" }),
				);

				expect(await dispatch(task)).toEqual([{ model: heavyRoute.model, thinkingLevel: "high" }]);
			});
		});

		describe("fallbacks", () => {
			async function expectFallback(reason: string, message?: string) {
				expect(await dispatch(task)).toEqual([mediumRoute]);
				expect(recorded(f)).toHaveLength(1);
				expect(recorded(f)[0]).toMatchObject({
					backend: "chat",
					mode: "apply",
					outcome: "failed",
					reason,
					...(message === undefined ? {} : { message }),
				});
			}

			it.each([
				["prose", "I would say heavy."],
				["an empty reply", ""],
				["an array", '["heavy", "xhigh"]'],
				["an unknown tier", '{"model": "huge", "effort": "low"}'],
				["an unknown effort", '{"model": "heavy", "effort": "max"}'],
				["a missing field", '{"model": "heavy"}'],
				["a value of the wrong type", '{"model": 1, "effort": "low"}'],
				["a different case", '{"model": "Heavy", "effort": "low"}'],
				["a nested object", '{"model": "heavy", "effort": {"level": "low"}}'],
				["JSON with unquoted keys", "{model: heavy, effort: low}"],
			])("keeps the defaults for a malformed reply: %s", async (_name, answer) => {
				f.streamSimple.mockImplementation(replying(answer));

				await expectFallback("malformed");
				expect(recorded(f)[0].applied).toBeUndefined();
			});

			it("keeps the defaults for an error result, and records the usage it reported", async () => {
				f.streamSimple.mockImplementation(
					replying("", { stopReason: "error", errorMessage: "Provider returned 500" }),
				);

				await expectFallback("error", "Provider returned 500");
				expect(recorded(f)[0].usage).toEqual(usage);
			});

			it("keeps the defaults when the stream rejects or the request cannot be prepared", async () => {
				f.streamSimple.mockImplementation(() => ({
					result: async () => {
						throw new Error("socket closed");
					},
				}));
				await expectFallback("error", "socket closed");

				f.appendEntry.mockClear();
				f.spawn.mockClear();
				f.streamSimple.mockImplementation(() => {
					throw new Error("no credentials");
				});
				await expectFallback("error", "no credentials");
			});

			it("gives up after five seconds and records a timeout", async () => {
				vi.useFakeTimers();
				f.streamSimple.mockImplementation(streamHangingUntilAborted());

				const pending = dispatch(task);
				await vi.advanceTimersByTimeAsync(4_999);
				expect(f.spawn).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(1);

				expect(await pending).toEqual([mediumRoute]);
				expect(recorded(f)[0]).toMatchObject({
					backend: "chat",
					outcome: "failed",
					reason: "timeout",
					latencyMs: 5_000,
				});
			});

			it("stops waiting when the tool call is aborted", async () => {
				const controller = new AbortController();
				f.streamSimple.mockImplementation(streamHangingUntilAborted());

				const pending = dispatch(task, controller.signal);
				await vi.waitFor(() => expect(f.streamSimple).toHaveBeenCalled());
				controller.abort();

				await pending;
				expect(recorded(f)[0]).toMatchObject({ backend: "chat", outcome: "failed", reason: "aborted" });
			});

			it("sends no request for a call that was aborted before the chat model was reached", async () => {
				const controller = new AbortController();
				controller.abort();

				await dispatch(task, controller.signal);

				expect(f.streamSimple).not.toHaveBeenCalled();
				expect(f.appendEntry).not.toHaveBeenCalled();
			});
		});
	});

	describe("request", () => {
		it("sends the task alone as state, and one score question with the three levels, lowest first", async () => {
			await dispatch({ agent: "worker", task: "Fix the parser" });

			expect(f.classify).toHaveBeenCalledOnce();
			const [, context, options] = f.classify.mock.calls[0];
			expect(context).toEqual({
				state: { task: "Fix the parser" },
				questions: {
					tier: {
						type: "score",
						instructions: "How demanding is `task`?",
						criteria: [
							"Repeatable, well-defined tasks: exploring a codebase or database; searching files and the web; making small edits and extracting fields when the expected result is clear; classification and routing.",
							"Everyday coding: fixing bugs and adding features; working through multistep tasks that need testing and revision along the way.",
							"Long-horizon agentic work: solving open-ended problems that require weighing trade-offs; planning and carrying out complex projects, adjusting the approach as new information comes in; reviewing written code to give strategic guidance or course correction.",
						],
					},
				},
			});
			expect(options?.signal).toBeInstanceOf(AbortSignal);
		});

		it("sends no conversation, even when the subagent would inherit it", async () => {
			await dispatch({ agent: "worker", task: "Fix the parser", turn: -1 });

			expect(f.classify.mock.calls[0][1].state).toEqual({ task: "Fix the parser" });
		});

		it("cuts the task to 16,000 characters without splitting a surrogate pair", async () => {
			await dispatch({ agent: "worker", task: `${"a".repeat(15_999)}\u{1F600}tail` });

			const { task } = f.classify.mock.calls[0][1].state as { task: string };
			expect(task).toHaveLength(16_000);
			expect(task.isWellFormed()).toBe(true);
			expect(task.startsWith("a".repeat(15_999))).toBe(true);
		});

		it("keeps the task text out of the recorded entry", async () => {
			await dispatch({ agent: "worker", task: "Rotate the production signing key" });

			expect(JSON.stringify(recorded(f))).not.toContain("signing key");
		});
	});

	describe("several items", () => {
		it("rates the items of a tasks array concurrently and dispatches each at its own tier", async () => {
			f.mode = "apply";
			const releases: (() => void)[] = [];
			f.classify.mockImplementation(
				(model, context) =>
					new Promise((resolve) =>
						releases.push(() =>
							resolve(
								levels(
									(context.state.task as string).startsWith("Redesign")
										? [0.05, 0.05, 0.9]
										: [0.9, 0.05, 0.05],
								)(model),
							),
						),
					),
			);

			const pending = dispatch({
				tasks: [
					{ agent: "worker", task: "Redesign the cache" },
					{ agent: "worker", task: "Rename a variable" },
					{ agent: "worker", task: "Pinned by the caller", tier: "medium" },
				],
			});
			// Both rated items are in flight before either has answered.
			await vi.waitFor(() => expect(releases).toHaveLength(2));
			for (const release of releases) release();

			expect(await pending).toEqual([heavyRoute, lightRoute, mediumRoute]);
			expect(f.appendEntry).toHaveBeenCalledTimes(2);
		});

		it("rates every step of a chain before the first one starts", async () => {
			f.mode = "apply";
			const order: string[] = [];
			f.classify.mockImplementation(async (model, context) => {
				order.push(`classify ${context.state.task}`);
				return levels([0.05, 0.05, 0.9])(model);
			});
			f.spawn.mockImplementationOnce((input) => {
				order.push(`spawn ${input.task}`);
				return { id: "worker-1", result: Promise.resolve(completed(input.task)) };
			});

			await f.tools.get("subagent")!.execute(
				"call",
				{
					agentScope: "project",
					chain: [
						{ agent: "explorer", task: "Find the parser" },
						{ agent: "worker", task: "Fix {previous}" },
					],
				},
				undefined,
				undefined,
				f.ctx,
			);

			expect(order.slice(0, 2).sort()).toEqual(["classify Find the parser", "classify Fix {previous}"]);
			expect(order[2]).toBe("spawn Find the parser");
			expect(routes(f).map((route) => route.model)).toEqual([heavyRoute.model, heavyRoute.model]);
		});
	});
});

describe("tier classifier in assign_tasks", () => {
	let f: Fixture;
	const objective = "Searchable product catalog";
	const steps = [
		{
			name: "Search schema",
			order: 1,
			description: "Define the search result",
			acceptance: ["Schema is typed"],
			paths: ["src/schema.ts"],
		},
		{ name: "Search API", order: 1, description: "Implement product search over the schema" },
		{ name: "Search box", order: 2, description: "Build the search box with debounce and keyboard handling" },
	];

	beforeEach(async () => {
		f = createFixture(planningExtension);
		f.mode = "apply";
		await f.tools.get("create_plan")!.execute("plan", { objective, tasks: steps }, undefined, undefined, f.ctx);
	});

	afterEach(async () => {
		await disposeFixture(f);
	});

	/** Assigns tasks of the plan created in `beforeEach`, as the main agent does. */
	async function assign(taskIds: string[], extra: Record<string, unknown> = {}) {
		return await f.tools
			.get("assign_tasks")!
			.execute("assign", { revision: 1, taskIds, ...extra }, undefined, undefined, f.ctx);
	}

	it("sends the objective, the step names and the task's own details, and no other step's details", async () => {
		await assign(["1"]);

		expect(f.classify).toHaveBeenCalledOnce();
		expect(f.classify.mock.calls[0][1].state).toEqual({
			objective,
			plan: ["Search schema", "Search API", "Search box"],
			task: {
				name: "Search schema",
				description: "Define the search result",
				acceptance: ["Schema is typed"],
				paths: ["src/schema.ts"],
			},
		});
		const sent = JSON.stringify(f.classify.mock.calls[0][1]);
		expect(sent).not.toContain("Implement product search");
		expect(sent).not.toContain("debounce");
		// The question is the same one the subagent tool asks.
		expect(f.classify.mock.calls[0][1].questions).toMatchObject({
			tier: { type: "score", instructions: "How demanding is `task`?" },
		});
	});

	it("leaves out acceptance and paths when the task has none, and cuts a long objective", async () => {
		const long = "o".repeat(3_000);
		const fresh = createFixture(planningExtension);
		try {
			fresh.mode = "apply";
			await fresh.tools
				.get("create_plan")!
				.execute(
					"plan",
					{ objective: long, tasks: [{ name: "Only step", order: 1, description: "Do it" }] },
					undefined,
					undefined,
					fresh.ctx,
				);
			await fresh.tools
				.get("assign_tasks")!
				.execute("assign", { revision: 1, taskIds: ["1"] }, undefined, undefined, fresh.ctx);

			expect(fresh.classify.mock.calls[0][1].state).toEqual({
				objective: "o".repeat(2_000),
				plan: ["Only step"],
				task: { name: "Only step", description: "Do it" },
			});
		} finally {
			await disposeFixture(fresh);
		}
	});

	it("rates each task on its own, so two tasks of one call get different tiers", async () => {
		f.classify.mockImplementation(async (model, context) => {
			const { name } = context.state.task as { name: string };
			return levels(name === "Search schema" ? [0.9, 0.05, 0.05] : [0.05, 0.05, 0.9])(model);
		});

		const result = await assign(["1", "2"]);

		expect(f.classify).toHaveBeenCalledTimes(2);
		expect(routes(f)).toEqual([lightRoute, heavyRoute]);
		const { workers } = (result.details as { assignment: { workers: unknown[] } }).assignment;
		expect(workers).toEqual([
			{ taskId: "1", workerId: "worker-1", ...lightRoute },
			{ taskId: "2", workerId: "worker-2", ...heavyRoute },
		]);
		expect(recorded(f).map((entry) => [entry.agent, entry.profileTier, entry.tier, entry.applied])).toEqual([
			["worker", "medium", "light", true],
			["worker", "medium", "heavy", true],
		]);
	});

	it("rates each task with the chat model when no classifier is available, sending the same state", async () => {
		f.available = [];
		f.streamSimple.mockImplementation((_model, context) => {
			const { task } = JSON.parse(String(context.messages[0].content)) as { task: { name: string } };
			const answer =
				task.name === "Search schema"
					? '{"model": "light", "effort": "high"}'
					: '{"model": "heavy", "effort": "low"}';
			return { result: async () => chatReply(answer) };
		});

		const result = await assign(["1", "2"]);

		expect(f.classify).not.toHaveBeenCalled();
		expect(f.streamSimple).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(f.streamSimple.mock.calls[0][1].messages[0].content))).toEqual({
			objective,
			plan: ["Search schema", "Search API", "Search box"],
			task: {
				name: "Search schema",
				description: "Define the search result",
				acceptance: ["Schema is typed"],
				paths: ["src/schema.ts"],
			},
		});
		const lightHigh = { model: lightRoute.model, thinkingLevel: "high" };
		const heavyLow = { model: heavyRoute.model, thinkingLevel: "low" };
		expect(routes(f)).toEqual([lightHigh, heavyLow]);
		const { workers } = (result.details as { assignment: { workers: unknown[] } }).assignment;
		expect(workers).toEqual([
			{ taskId: "1", workerId: "worker-1", ...lightHigh },
			{ taskId: "2", workerId: "worker-2", ...heavyLow },
		]);
		expect(recorded(f).map((entry) => [entry.backend, entry.tier, entry.effort, entry.applied])).toEqual([
			["chat", "light", "high", { tier: true, effort: true }],
			["chat", "heavy", "low", { tier: true, effort: true }],
		]);
	});

	it("keeps the worker profile's tier for a task the classifier is unsure about", async () => {
		f.classify.mockImplementation(async (model, context) => {
			const { name } = context.state.task as { name: string };
			return levels(name === "Search schema" ? [0.9, 0.05, 0.05] : [0.3, 0.3, 0.4])(model);
		});

		await assign(["1", "2"]);

		expect(routes(f)).toEqual([lightRoute, mediumRoute]);
	});

	it("records but applies nothing in shadow mode", async () => {
		f.mode = "shadow";

		await assign(["1", "2"]);

		expect(routes(f)).toEqual([mediumRoute, mediumRoute]);
		expect(recorded(f).map((entry) => [entry.mode, entry.applied])).toEqual([
			["shadow", false],
			["shadow", false],
		]);
	});

	it.each([
		["a model", { model: "haiku" }],
		["a tier", { tier: "light" }],
	])("applies %s chosen for the call to every task and skips the rating", async (_name, choice) => {
		await assign(["1", "2"], choice);

		expect(f.classify).not.toHaveBeenCalled();
		expect(f.appendEntry.mock.calls.filter(([type]) => type === tierClassificationEntryType)).toEqual([]);
		expect(new Set(routes(f).map((route) => route.model)).size).toBe(1);
	});

	it("falls back to the profile's tier for every task when the classifier fails", async () => {
		f.classify.mockImplementation(async (model) =>
			answerOf(model, undefined, { stopReason: "error", errorMessage: "down" }),
		);

		await assign(["1", "2"]);

		expect(routes(f)).toEqual([mediumRoute, mediumRoute]);
		expect(recorded(f).map((entry) => entry.reason)).toEqual(["error", "error"]);
	});

	it("starts nothing when the call is aborted while the classifier runs", async () => {
		const controller = new AbortController();
		f.classify.mockImplementation(hangUntilAborted());

		const pending = f.tools
			.get("assign_tasks")!
			.execute("assign", { revision: 1, taskIds: ["1"] }, controller.signal, undefined, f.ctx);
		await vi.waitFor(() => expect(f.classify).toHaveBeenCalled());
		controller.abort();

		await expect(pending).rejects.toThrow("Task assignment aborted before starting");
		expect(f.spawn).not.toHaveBeenCalled();
	});
});
