// Rates how demanding a delegated task is, with a classifier model or else a chat model, so the harness rather than the main agent picks its tier.
import {
	type Api,
	type AssistantMessage,
	type ClassifierApi,
	type ClassifierModel,
	type ClassifierResult,
	type ClassifierScoreQuestion,
	type Context,
	getSupportedThinkingLevels,
	type JsonObject,
	type Model,
	type ThinkingLevel,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { TierClassifierMode } from "../../core/settings-schema.ts";
import type { TaskInput } from "../planning/graph.ts";
import type { AgentConfig } from "./agents.ts";
import type { ProfileDefaults, SubagentDispatch } from "./dispatch.ts";
import { type ModelTier, resolveModelTier } from "./model-tiers.ts";

// What the classifier is asked, and how sure it must be before apply mode acts on its answer.
// The wording follows Anthropic's and OpenAI's published descriptions of their small, everyday and flagship models
// and is meant to be reviewed and edited by a person. The phrases are taken from OpenAI's model selection guide and
// model pages, Anthropic's models overview and Haiku page, Anthropic's advisor tool page (the review clause), and
// Claude Code's Explore agent prompt, the text of agents/explorer.md (the exploring and searching clause).
// The owner asked for code audits and directional feedback on written code to count as heavy.
// The classifier judges each level on its own, without seeing its number or its neighbours, so every description
// stands alone and adjacent levels share no defining phrase.
// The chat backend, used when no classifier model is available, sends the same three level texts in one system prompt
// together with the effort texts below. The effort wording follows Anthropic's effort guidance and OpenAI's model
// selection guide, and is likewise meant to be reviewed and edited by a person.
const tierInstructions = "How demanding is `task`?";
// Lowest first: the position of a level in this list is its position in the question and in the answer.
const tierLevels: readonly { tier: ModelTier; description: string }[] = [
	{
		tier: "light",
		description:
			"Repeatable, well-defined tasks: exploring a codebase or database; searching files and the web; making small edits and extracting fields when the expected result is clear; classification and routing.",
	},
	{
		tier: "medium",
		description:
			"Everyday coding: fixing bugs and adding features; working through multistep tasks that need testing and revision along the way.",
	},
	{
		tier: "heavy",
		description:
			"Long-horizon agentic work: solving open-ended problems that require weighing trade-offs; planning and carrying out complex projects, adjusting the approach as new information comes in; reviewing written code to give strategic guidance or course correction.",
	},
];
// Both reference harnesses tell the model to change the default only when highly confident, so apply mode
// replaces the profile's tier only when the most likely level has at least this probability.
const minTierProbability = 0.7;

const tierQuestion: ClassifierScoreQuestion = {
	type: "score",
	instructions: tierInstructions,
	criteria: tierLevels.map((level) => level.description),
};
// The reasoning efforts a chat model can rate, lowest first.
const effortLevels: readonly { effort: RatedEffort; description: string }[] = [
	{ effort: "low", description: "Simple tasks." },
	{ effort: "medium", description: "Most workflows." },
	{ effort: "high", description: "Intelligence-sensitive work." },
	{ effort: "xhigh", description: "Complex or long-running tasks." },
];
const chatSystemPrompt = [
	'You rate a task that a coding agent is about to delegate to a subagent. Reply with one JSON object and nothing else, in this form: {"model": "heavy", "effort": "xhigh"}.',
	"",
	`model is one of ${withDefault(tierLevels.map((level) => level.tier))}.`,
	...tierLevels.map((level) => `- ${level.tier}: ${level.description}`),
	"",
	`effort is one of ${withDefault(effortLevels.map((level) => level.effort))}.`,
	...effortLevels.map((level) => `- ${level.effort}: ${level.description}`),
	"",
	"Answer default for a field when the task does not clearly fit one value.",
].join("\n");
const tierAnswers: ReadonlySet<unknown> = new Set<TierAnswer>([...tierLevels.map((level) => level.tier), "default"]);
const effortAnswers: ReadonlySet<unknown> = new Set<EffortAnswer>([
	...effortLevels.map((level) => level.effort),
	"default",
]);
// A dispatch waits at most this long for a classifier model, or for a chat model; past it the profile's tier applies.
const classifierTimeoutMs = 3_000;
const chatTimeoutMs = 5_000;
// The answer is a short JSON object, so the output is capped well below the model's own limit.
const chatMaxTokens = 100;
const maxTaskChars = 16_000;
const maxObjectiveChars = 2_000;
const maxMessageChars = 200;
const preferredClassifierId = "gpt-6-luna";
// The first flat object of a reply: the expected answer has no nested braces.
const flatObjectPattern = /\{[^{}]*\}/g;

/** Session entry type under which every classification is recorded. */
export const tierClassificationEntryType = "subagent-tier-classification";

/**
 * What the classifier judges. A `subagent` call carries its task text, which must stand on its own. A step of a plan
 * also carries the plan's objective and its step names as background, but no other step's details.
 */
export type TierWork =
	| { kind: "task"; task: string }
	| {
			kind: "planned";
			objective: string;
			/** The names of the plan's active steps, in order. */
			plan: readonly string[];
			task: Pick<TaskInput, "name" | "description" | "acceptance" | "paths">;
	  };

/** A task about to be dispatched, with what decides whether the classifier may rate it. */
export interface TierRequest {
	agent: Pick<AgentConfig, "name" | "model" | "tier">;
	work: TierWork;
	/** The model the caller chose for this task, if any. */
	model?: string;
	/** The tier the caller chose for this task, if any. */
	tier?: ModelTier;
}

/** What a rating changes for one request. Each field that is absent keeps the profile's own value. */
export interface TierOverride {
	/** Replaces the profile's tier. */
	tier?: ModelTier;
	/** Replaces the effort of the tier row that selects the model. */
	effort?: RatedEffort;
}

type RatedEffort = "low" | "medium" | "high" | "xhigh";
/** What a chat model answers for the tier: `default` is no opinion. */
type TierAnswer = ModelTier | "default";
type EffortAnswer = RatedEffort | "default";

type TierFailureReason = "timeout" | "aborted" | "error" | "malformed" | "no-level-probabilities";

interface TierClassified {
	outcome: "classified";
	/** The level with the highest probability. */
	tier: ModelTier;
	probabilities: Record<ModelTier, number>;
	/** The score the classifier averaged over the levels, from 0 (light) to 2 (heavy). */
	score: number;
}

interface ChatClassified {
	outcome: "classified";
	tier: TierAnswer;
	effort: EffortAnswer;
}

interface TierFailed {
	outcome: "failed";
	reason: TierFailureReason;
	message?: string;
	/** Present when the answer arrived without per-level probabilities. */
	score?: number;
}

type DecisionRating = TierClassified | TierFailed;
type ChatRating = ChatClassified | TierFailed;

type RatingMode = Exclude<TierClassifierMode, "off">;

interface TierEntryHeader {
	mode: RatingMode;
	agent: string;
	profileTier?: ModelTier;
	/** `provider/id` of the model that rated: a classifier model for `decision`, a chat model for `chat`. */
	classifier: string;
	latencyMs: number;
	usage?: Usage;
}

/** A rating by a classifier model. */
type DecisionEntryBody = { backend: "decision" } & (TierFailed | (TierClassified & { applied: boolean }));
/** A rating by a chat model. `applied` says which of its fields were handed to the dispatch: `default` is never one. */
type ChatEntryBody = { backend: "chat" } & (
	| TierFailed
	| (ChatClassified & { applied: { tier: boolean; effort: boolean } })
);

/** The record of one classification: the task text is left out, the tool call already holds it. */
export type TierClassificationEntry = TierEntryHeader & (DecisionEntryBody | ChatEntryBody);

type ClassifierRef = ClassifierModel<ClassifierApi>;

interface Deadline {
	signal: AbortSignal;
	hasTimedOut(): boolean;
	clear(): void;
}

interface RatingSetup {
	pi: ExtensionAPI;
	mode: RatingMode;
	registry: ModelRegistry;
}

interface ClassifierCall extends RatingSetup {
	classifier: ClassifierRef;
	deadline: Deadline;
}

interface ChatCall extends RatingSetup {
	model: Model<Api>;
	deadline: Deadline;
}

/**
 * Rates each request, all at once, and returns per request what to dispatch with in place of the agent profile's
 * tier and tier effort, or undefined to keep both. Only `apply` mode returns anything. A classifier model rates when
 * one is available; otherwise the light-tier chat model of the current account does. Never throws and waits at most
 * three seconds for a classifier model or five for a chat model; every rating or failure is recorded as a session entry.
 */
export async function classifyTiers(
	pi: ExtensionAPI,
	dispatch: Pick<SubagentDispatch, "models">,
	requests: readonly (TierRequest | undefined)[],
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<(TierOverride | undefined)[]> {
	const mode = readMode(pi);
	const eligible = requests.map((request) => (isEligible(request) ? request : undefined));
	if (mode === "off" || !eligible.some((request) => request !== undefined)) return requests.map(() => undefined);
	const setup: RatingSetup = { pi, mode, registry: ctx.modelRegistry };
	return (
		(await rateWithClassifier(eligible, setup, signal)) ??
		(await rateWithChat(eligible, setup, dispatch, ctx, signal))
	);
}

/** The profile as dispatch should see it: the rated tier replaces its tier, and the rated effort rides along. */
export function withRating(
	profile: ProfileDefaults | undefined,
	rating: TierOverride | undefined,
): ProfileDefaults | undefined {
	if (!rating) return profile;
	return { ...profile, tier: rating.tier ?? profile?.tier, ratedEffort: rating.effort };
}

function readMode(pi: ExtensionAPI): TierClassifierMode {
	// Settings files are not validated and hold no defaults, so an unset or unknown value means the default mode.
	const mode = pi.getSettings().subagents?.tierClassifier;
	return mode === "off" || mode === "shadow" || mode === "apply" ? mode : SETTINGS_DEFAULTS.subagents.tierClassifier;
}

/** Only a task whose model and tier nobody chose is rated: a pinned profile model or a caller's choice wins. */
function isEligible(request: TierRequest | undefined): request is TierRequest {
	return (
		request !== undefined &&
		request.model === undefined &&
		request.tier === undefined &&
		request.agent.model === undefined
	);
}

function createDeadline(parent: AbortSignal | undefined, timeoutMs: number): Deadline {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), timeoutMs);
	return {
		signal: parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal,
		hasTimedOut: () => timeout.signal.aborted,
		clear: () => clearTimeout(timer),
	};
}

/** The ratings by the preferred classifier model, or undefined when none is available. One deadline covers the lookup and the ratings. */
async function rateWithClassifier(
	eligible: readonly (TierRequest | undefined)[],
	setup: RatingSetup,
	signal: AbortSignal | undefined,
): Promise<(TierOverride | undefined)[] | undefined> {
	const deadline = createDeadline(signal, classifierTimeoutMs);
	try {
		const classifier = await selectClassifier(setup.registry, deadline.signal);
		if (!classifier) return undefined;
		const call: ClassifierCall = { ...setup, classifier, deadline };
		return await Promise.all(eligible.map((request) => (request ? classifyRequest(request, call) : undefined)));
	} finally {
		deadline.clear();
	}
}

/** The available classifier model to use: `gpt-6-luna`, then a Jev model, then any other. */
async function selectClassifier(registry: ModelRegistry, signal: AbortSignal): Promise<ClassifierRef | undefined> {
	try {
		const available = await registry.getAvailableOfType("classifier", undefined, { signal });
		return available.toSorted((a, b) => classifierRank(a) - classifierRank(b))[0];
	} catch {
		// A credential lookup that fails or runs into the deadline means no classifier for this dispatch.
		return undefined;
	}
}

function classifierRank(model: ClassifierRef): number {
	const id = model.id.toLowerCase();
	if (id === preferredClassifierId) return 0;
	return id.includes("jev") ? 1 : 2;
}

async function classifyRequest(request: TierRequest, call: ClassifierCall): Promise<TierOverride | undefined> {
	const startedAt = Date.now();
	const { rating, usage } = await rateTask(request, call);
	const tier = actedOnTier(call.mode, rating);
	const body: DecisionEntryBody = {
		backend: "decision",
		...(rating.outcome === "classified" ? { ...rating, applied: tier !== undefined } : rating),
	};
	record(call, request, `${call.classifier.provider}/${call.classifier.id}`, startedAt, body, usage);
	return tier ? { tier } : undefined;
}

/** The tier apply mode uses: the likeliest level, when its probability reaches the minimum. */
function actedOnTier(mode: RatingMode, rating: DecisionRating): ModelTier | undefined {
	if (mode !== "apply" || rating.outcome !== "classified") return undefined;
	return rating.probabilities[rating.tier] >= minTierProbability ? rating.tier : undefined;
}

async function rateTask(
	request: TierRequest,
	call: ClassifierCall,
): Promise<{ rating: DecisionRating; usage?: Usage }> {
	const context = { state: tierState(request.work), questions: { tier: tierQuestion } };
	try {
		const result = await call.registry.classify(call.classifier, context, { signal: call.deadline.signal });
		return { rating: readRating(result, call.deadline), usage: result.usage };
	} catch (error) {
		// Classifier adapters resolve with an error result, but an extension's own adapter may reject.
		return { rating: failed(failureReason(call.deadline), errorText(error)) };
	}
}

/** The state the classifier sees, as named fields: `task` is what is judged, the rest is background. */
function tierState(work: TierWork): JsonObject {
	if (work.kind === "task") return { task: clip(work.task, maxTaskChars) };
	const { name, description, acceptance, paths } = work.task;
	return {
		objective: clip(work.objective, maxObjectiveChars),
		plan: work.plan,
		task: {
			name,
			description: clip(description, maxTaskChars),
			...(acceptance && { acceptance }),
			...(paths && { paths }),
		},
	};
}

function readRating(result: ClassifierResult, deadline: Deadline): DecisionRating {
	if (result.stopReason !== "stop") return failed(failureReason(deadline), result.errorMessage);
	const answer = result.answers.tier;
	// The answer is a provider's wire response, so its shape is checked before it decides a dispatch.
	if (answer?.type !== "score" || !Number.isFinite(answer.score)) return failed("malformed");
	const levels = answer.probabilities;
	// A service that reports no per-level probabilities cannot say how sure it is of one level.
	if (levels === undefined) return { ...failed("no-level-probabilities"), score: answer.score };
	if (levels.length !== tierLevels.length || !levels.every(Number.isFinite)) return failed("malformed");
	const [light, medium, heavy] = levels;
	return {
		outcome: "classified",
		tier: tierLevels[levels.indexOf(Math.max(...levels))].tier,
		probabilities: { light, medium, heavy },
		score: answer.score,
	};
}

/** The ratings by the light-tier chat model of the current account. Nothing is rated when the account has none. */
async function rateWithChat(
	eligible: readonly (TierRequest | undefined)[],
	setup: RatingSetup,
	dispatch: Pick<SubagentDispatch, "models">,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<(TierOverride | undefined)[]> {
	const model = findChatModel(dispatch, ctx);
	// A call aborted while the classifiers were looked up is not rated.
	if (!model || signal?.aborted) return eligible.map(() => undefined);
	const deadline = createDeadline(signal, chatTimeoutMs);
	try {
		const call: ChatCall = { ...setup, model, deadline };
		return await Promise.all(eligible.map((request) => (request ? chatRequest(request, call) : undefined)));
	} finally {
		deadline.clear();
	}
}

function findChatModel(dispatch: Pick<SubagentDispatch, "models">, ctx: ExtensionContext): Model<Api> | undefined {
	try {
		return resolveModelTier("light", dispatch.models(ctx).models)?.model;
	} catch {
		// Dispatch throws while a pool's serving account is still unknown, and nothing is rated until it is known.
		return undefined;
	}
}

async function chatRequest(request: TierRequest, call: ChatCall): Promise<TierOverride | undefined> {
	const startedAt = Date.now();
	const { rating, usage } = await askChatModel(request, call);
	const override = actedOnChatRating(call.mode, rating);
	const applied = { tier: override?.tier !== undefined, effort: override?.effort !== undefined };
	const body: ChatEntryBody = {
		backend: "chat",
		...(rating.outcome === "classified" ? { ...rating, applied } : rating),
	};
	record(call, request, `${call.model.provider}/${call.model.id}`, startedAt, body, usage);
	return override;
}

/** What apply mode uses of a chat rating: each field it answered, but not `default`. */
function actedOnChatRating(mode: RatingMode, rating: ChatRating): TierOverride | undefined {
	if (mode !== "apply" || rating.outcome !== "classified") return undefined;
	const tier = rating.tier === "default" ? undefined : rating.tier;
	const effort = rating.effort === "default" ? undefined : rating.effort;
	return tier || effort ? { tier, effort } : undefined;
}

/** One side request to the chat model: the state as JSON, a short reply, the least reasoning. It starts no subagent. */
async function askChatModel(request: TierRequest, call: ChatCall): Promise<{ rating: ChatRating; usage?: Usage }> {
	const context: Context = {
		systemPrompt: chatSystemPrompt,
		messages: [{ role: "user", content: JSON.stringify(tierState(request.work)), timestamp: Date.now() }],
	};
	try {
		const stream = call.registry.streamSimple(call.model, context, {
			signal: call.deadline.signal,
			maxTokens: chatMaxTokens,
			reasoning: lowestReasoning(call.model),
			// Nothing reads the cache of a one-off request, so no write is paid for.
			cacheRetention: "none",
		});
		const reply = await stream.result();
		return { rating: readChatRating(reply, call.deadline), usage: reply.usage };
	} catch (error) {
		// The stream encodes its failures in its result, but a registry may still throw while preparing the request.
		return { rating: failed(failureReason(call.deadline), errorText(error)) };
	}
}

/** The lowest level the model supports: no reasoning when it can be turned off, else its smallest effort. */
function lowestReasoning(model: Model<Api>): ThinkingLevel | undefined {
	const [lowest] = getSupportedThinkingLevels(model);
	return lowest === "off" ? undefined : lowest;
}

function readChatRating(reply: AssistantMessage, deadline: Deadline): ChatRating {
	// A reply cut off by the token cap may still hold the whole object, so only an error or an abort is a failure.
	if (reply.stopReason === "error" || reply.stopReason === "aborted") {
		return failed(failureReason(deadline), reply.errorMessage);
	}
	const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
	const answer = firstJsonObject(text);
	// The reply is a model's wire output, so only the listed values may decide a dispatch.
	const model = answer?.model;
	const effort = answer?.effort;
	if (!isTierAnswer(model) || !isEffortAnswer(effort)) return failed("malformed");
	return { outcome: "classified", tier: model, effort };
}

function isTierAnswer(value: unknown): value is TierAnswer {
	return tierAnswers.has(value);
}

function isEffortAnswer(value: unknown): value is EffortAnswer {
	return effortAnswers.has(value);
}

/** The first JSON object in the text, which the model may have wrapped in prose or a code fence. */
function firstJsonObject(text: string): Record<string, unknown> | undefined {
	for (const [candidate] of text.matchAll(flatObjectPattern)) {
		const parsed = parseJsonObject(candidate);
		if (parsed) return parsed;
	}
	return undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Appends the entry of one rating to the session. */
function record(
	call: RatingSetup,
	request: TierRequest,
	rater: string,
	startedAt: number,
	body: DecisionEntryBody | ChatEntryBody,
	usage: Usage | undefined,
): void {
	const entry: TierClassificationEntry = {
		mode: call.mode,
		agent: request.agent.name,
		profileTier: request.agent.tier,
		classifier: rater,
		latencyMs: Date.now() - startedAt,
		usage,
		...body,
	};
	call.pi.appendEntry(tierClassificationEntryType, entry);
}

function failed(reason: TierFailureReason, message?: string): TierFailed {
	return { outcome: "failed", reason, ...(message && { message: clip(message, maxMessageChars) }) };
}

function failureReason(deadline: Deadline): "timeout" | "aborted" | "error" {
	if (deadline.hasTimedOut()) return "timeout";
	return deadline.signal.aborted ? "aborted" : "error";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The values joined as a list that also offers `default`, as in "light, medium, heavy or default". */
function withDefault(values: readonly string[]): string {
	return `${values.join(", ")} or default`;
}

/** The first `max` characters, with a split surrogate pair replaced rather than sent as invalid text. */
function clip(text: string, max: number): string {
	return text.slice(0, max).toWellFormed();
}
