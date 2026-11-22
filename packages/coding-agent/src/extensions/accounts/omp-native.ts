// Chat transport of broker accounts: oh-my-pi's pi-native protocol. Pi posts its transcript to a broker route the way
// oh-my-pi's own client posts one to its auth gateway, and the broker's oh-my-pi runtime reshapes the request for the
// provider, sends it and streams its own events back. The wire is JSON, so oh-my-pi is not a dependency.
import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type CacheRetention,
	calculateCost,
	contentText,
	createAssistantMessageEventStream,
	formatThrownValue,
	getCurrentSystemMessage,
	getCurrentTools,
	type ImageContent,
	type JsonObject,
	type Message,
	type Model,
	type ProviderStreams,
	type SamplingParams,
	type SimpleStreamOptions,
	type StopReason,
	type SystemMessage,
	type TextContent,
	type ThinkingBudgets,
	type ThinkingContent,
	type ThinkingLevel,
	type Tool,
	type ToolCall,
	ToolCallArgumentsStream,
	type ToolChoice,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { headersToRecord, providerHeadersToRecord } from "@earendil-works/pi-ai/utils/headers";
import { APP_NAME } from "../../config.ts";

/** Pi API id of broker chat models: the broker's oh-my-pi runtime builds the provider request. */
export const OMP_NATIVE_API = "omp-native";

/** The provider and API oh-my-pi resolved for a model, as the broker reports them (`anthropic`, `anthropic-messages`). */
export interface OmpIdentity {
	provider: string;
	api: string;
}

/** Finds the oh-my-pi identity of a model served through a Pi provider, when the account catalog knows one. */
export type OmpIdentityLookup = (piProvider: string, modelId: string) => OmpIdentity | undefined;

/** Route of oh-my-pi's pi-native protocol below a broker route base. */
const PI_STREAM_PATH = "/pi/stream";
/** Text of a redacted reasoning block, as in Pi's Anthropic adapter. */
const REDACTED_THINKING_TEXT = "[Reasoning redacted]";
const MAX_ERROR_BODY_CHARS = 4000;

// The wire types below name only the fields this client writes or reads. Fields of oh-my-pi's types that Pi has
// no counterpart for are left out.

type OmpStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

interface OmpToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string;
	namespace?: string;
}

type OmpBlock =
	| TextContent
	| { type: "thinking"; thinking: string; thinkingSignature?: string }
	| { type: "redactedThinking"; data: string }
	| OmpToolCall
	// Blocks oh-my-pi can produce that Pi has no block for: generated images, fallback boundaries, server tool results.
	| { type: "image" | "fallback" | "anthropicServerTool" };

interface OmpUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoningTokens?: number;
	/** Cache-write split by lifetime, when the provider reports one. */
	cttl?: { ephemeral5m?: number; ephemeral1h?: number };
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface OmpAssistantMessage {
	role: "assistant";
	content: OmpBlock[];
	api: string;
	provider: string;
	model: string;
	responseId?: string;
	/** The model that produced the turn, when it is not the requested one. */
	upstreamModel?: string;
	usage: OmpUsage;
	stopReason: OmpStopReason;
	errorMessage?: string;
	timestamp: number;
}

type OmpMessage =
	| { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number }
	| OmpAssistantMessage
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: (TextContent | ImageContent)[];
			isError: boolean;
			timestamp: number;
	  };

interface OmpTool {
	name: string;
	description: string;
	parameters: object;
	strict?: true;
	customFormat?: { syntax: "lark" | "regex"; definition: string };
}

interface OmpSampling {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	repetitionPenalty?: number;
}

interface OmpOptions extends OmpSampling {
	maxTokens?: number;
	reasoning?: ThinkingLevel;
	thinkingBudgets?: ThinkingBudgets;
	toolChoice?: ToolChoice;
	sessionId?: string;
	cacheRetention?: CacheRetention;
	/** `false` sends every request in full instead of continuing a provider-side thread. */
	statefulResponses?: false;
	maxRetryDelayMs?: number;
	headers?: Record<string, string>;
	metadata?: Record<string, unknown>;
}

interface OmpRequest {
	modelId: string;
	context: { systemPrompt?: string[]; messages: OmpMessage[]; tools?: OmpTool[] };
	options: OmpOptions;
	stream: true;
}

/** Frames about one content block. `partial` is the whole turn so far, and may be ahead of the frame. */
type OmpBlockFrame = { contentIndex: number; partial: OmpAssistantMessage } & (
	| { type: "text_start" | "thinking_start" | "toolcall_start" }
	| { type: "text_delta" | "thinking_delta" | "toolcall_delta"; delta: string }
	| { type: "text_end" | "thinking_end"; content: string }
	| { type: "toolcall_end"; toolCall: OmpToolCall }
);

type OmpDoneFrame = { type: "done"; reason: "stop" | "length" | "toolUse"; message: OmpAssistantMessage };

/** A broker failure that carries no turn has only `errorMessage`. */
type OmpErrorFrame = {
	type: "error";
	reason: "aborted" | "error";
	error?: OmpAssistantMessage;
	errorMessage?: string;
};

type OmpFrame = { type: "start" } | OmpBlockFrame | OmpDoneFrame | OmpErrorFrame;

/**
 * Streams of the `omp-native` API; the request model's base URL is the broker route the provider resolved.
 * `identify` tells oh-my-pi's provider and API for the models of earlier turns (see `encodeAssistant`).
 */
export function ompNativeStreams(identify: OmpIdentityLookup): ProviderStreams {
	const stream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
		streamOmpNative(model, context, options, identify);
	return { stream, streamSimple: stream };
}

function streamOmpNative(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	identify: OmpIdentityLookup,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void relay(stream, createDecoder(model), context, options, identify);
	return stream;
}

/** Posts the request and pushes every decoded event; any failure ends the stream with an error event. */
async function relay(
	stream: AssistantMessageEventStream,
	decoder: DecoderState,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	identify: OmpIdentityLookup,
): Promise<void> {
	const { model } = decoder;
	try {
		const response = await post(model, context, options, identify);
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		if (!response.ok) throw await responseError(response);
		if (!response.body) throw new Error("The account broker sent an empty response.");
		for await (const data of readSseData(response.body)) {
			const frame = parseFrame(data);
			await options?.onProviderStreamEvent?.(frame, model);
			for (const event of decodeFrame(decoder, frame)) stream.push(event);
			if (frame.type === "done" || frame.type === "error") return;
		}
		throw new Error("The account broker's stream ended before a terminal event.");
	} catch (error) {
		stream.push(failTurn(decoder, error, options?.signal?.aborted ?? false));
	}
}

async function post(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	identify: OmpIdentityLookup,
): Promise<Response> {
	// The bearer is the broker's per-run token, which the account provider resolved.
	const { apiKey } = options ?? {};
	if (!apiKey) throw new Error(`No broker token for provider "${model.provider}".`);
	let payload: unknown = encodeRequest(model, context, options, identify);
	const replaced = await options?.onPayload?.(payload, model);
	if (replaced !== undefined) payload = replaced;
	return (options?.fetch ?? globalThis.fetch)(`${model.baseUrl.replace(/\/+$/u, "")}${PI_STREAM_PATH}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			"x-omp-app": APP_NAME,
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(payload),
		signal: options?.signal,
	});
}

/** The broker answers a refused request with HTTP and a JSON body, either `{ error: { message } }` or `{ error }`. */
async function responseError(response: Response): Promise<Error> {
	const body = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
	const detail = errorBodyMessage(body) ?? body;
	return new Error(
		detail ? `${response.status} ${response.statusText}: ${detail}` : `${response.status} ${response.statusText}`,
	);
}

function errorBodyMessage(body: string): string | undefined {
	try {
		const { error } = JSON.parse(body) as { error?: string | { message?: string } };
		return typeof error === "string" ? error : error?.message;
	} catch {
		return undefined;
	}
}

// Request: Pi's transcript and options as oh-my-pi's `SimpleStreamOptions` and `Context`.

function encodeRequest(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	identify: OmpIdentityLookup,
): OmpRequest {
	// oh-my-pi's context has one prompt and one tool set, not system messages in the transcript. Later system
	// messages are replayed into them, as Pi does for every API without mid-conversation system messages.
	const system = getCurrentSystemMessage(context.messages);
	const prompt = system ? systemPromptBlocks(system) : [];
	const tools = getCurrentTools(context.messages);
	return {
		// The broker resolves the bare model ID on the account or pool of the route.
		modelId: model.id,
		context: {
			...(prompt.length > 0 ? { systemPrompt: prompt } : {}),
			messages: context.messages.flatMap((message) => encodeMessage(message, identify)),
			...(tools.length > 0 ? { tools: tools.map(encodeTool) } : {}),
		},
		options: encodeOptions(model, context, options),
		stream: true,
	};
}

/** The base prompt, then each named section, as separate blocks. They read as `getSystemMessageText` joined. */
function systemPromptBlocks(system: SystemMessage): string[] {
	const sections = Object.values(system.sections ?? {}).filter((text): text is string => text !== null);
	return [contentText(system.content), ...sections].filter((text) => text.length > 0);
}

function encodeMessage(message: Message, identify: OmpIdentityLookup): OmpMessage[] {
	switch (message.role) {
		case "system":
			return [];
		case "user":
			return [{ role: "user", content: message.content, timestamp: message.timestamp }];
		case "assistant":
			return [encodeAssistant(message, identify)];
		case "toolResult":
			// `details`, `usage`, `nestedCalls` and `durationMs` are for Pi's own records, not for the model.
			return [
				{
					role: "toolResult",
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					content: message.content,
					isError: message.isError,
					timestamp: message.timestamp,
				},
			];
	}
}

/**
 * oh-my-pi replays reasoning signatures only for turns of the model it resolved: the turn's provider, API and
 * model must equal that model's. A turn of an `omp-native` model therefore carries the provider and API the broker
 * reported for that model, as oh-my-pi's own client would send it. `model` is already the bare model ID. Without
 * a known identity (the account is gone, a pool serves the ID through different providers, or the catalog is
 * from an older version) the turn keeps Pi's own, and oh-my-pi replays its reasoning as plain text.
 */
function encodeAssistant(message: AssistantMessage, identify: OmpIdentityLookup): OmpAssistantMessage {
	const upstream = message.api === OMP_NATIVE_API ? identify(message.provider, message.model) : undefined;
	return {
		role: "assistant",
		content: message.content.flatMap(encodeBlock),
		api: upstream?.api ?? message.api,
		provider: upstream?.provider ?? message.provider,
		model: message.model,
		responseId: message.responseId,
		upstreamModel: message.responseModel,
		usage: encodeUsage(message.usage),
		stopReason: encodeStopReason(message.stopReason),
		errorMessage: message.errorMessage,
		timestamp: message.timestamp,
	};
}

function encodeBlock(block: AssistantMessage["content"][number]): OmpBlock[] {
	switch (block.type) {
		case "text":
			return [block];
		case "thinking":
			// Pi keeps the opaque payload of redacted reasoning in `thinkingSignature`.
			if (block.redacted) {
				return block.thinkingSignature === undefined
					? []
					: [{ type: "redactedThinking", data: block.thinkingSignature }];
			}
			return [{ type: "thinking", thinking: block.thinking, thinkingSignature: block.thinkingSignature }];
		case "toolCall":
			// `argumentsError` is Pi's note on malformed arguments; the call itself carries `{}`.
			return [
				{
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: block.arguments,
					thoughtSignature: block.thoughtSignature,
					namespace: block.namespace,
				},
			];
	}
}

function encodeUsage(usage: Usage): OmpUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		reasoningTokens: usage.reasoning,
		cttl:
			usage.cacheWrite1h === undefined
				? undefined
				: { ephemeral5m: usage.cacheWrite - usage.cacheWrite1h, ephemeral1h: usage.cacheWrite1h },
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
	};
}

/** A turn that is still pending or only deferred has no result yet; it replays as an empty finished turn. */
function encodeStopReason(stopReason: StopReason): OmpStopReason {
	return stopReason === "pending" || stopReason === "deferred" ? "stop" : stopReason;
}

function encodeTool(tool: Tool): OmpTool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...constrainedSamplingFields(tool.constrainedSampling),
	};
}

/** Pi's strict JSON schema is oh-my-pi's `strict`, and Pi's grammar variants are its `customFormat`. */
function constrainedSamplingFields(sampling: Tool["constrainedSampling"]): Pick<OmpTool, "strict" | "customFormat"> {
	if (!sampling) return {};
	if (sampling.type === "json_schema") return { strict: true };
	const { openai_lark: lark, openai_regex: regex } = sampling.variants;
	if (lark !== undefined) return { customFormat: { syntax: "lark", definition: lark } };
	if (regex !== undefined) return { customFormat: { syntax: "regex", definition: regex } };
	return {};
}

/**
 * Options that cross the wire. `signal`, `fetch`, `onPayload`, `onResponse` and `onProviderStreamEvent` stay here.
 * Not sent because oh-my-pi owns the hop to the provider: `transport`, `timeoutMs`, `maxRetries`,
 * `websocketConnectTimeoutMs`, `env`, `identity` and `telemetry`.
 */
function encodeOptions(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
): OmpOptions {
	// The same base options Pi's own adapters use: the output cap fitted to the context window, and the model's,
	// the thinking level's and the request's sampling parameters merged.
	const base = buildBaseOptions(model, context, options);
	return {
		temperature: base.temperature,
		...encodeSampling(base.samplingParams),
		maxTokens: base.maxTokens,
		reasoning: options?.reasoning,
		thinkingBudgets: options?.thinkingBudgets,
		toolChoice: options?.toolChoice,
		// The broker locks the account credential to the exact session ID oh-my-pi will use, so every request needs one.
		sessionId: base.sessionId?.trim() ? base.sessionId : randomUUID(),
		cacheRetention: base.cacheRetention,
		statefulResponses: base.disableContinuation ? false : undefined,
		maxRetryDelayMs: base.maxRetryDelayMs,
		// A null header suppresses a default of the provider adapter, which oh-my-pi's adapter does not share.
		headers: providerHeadersToRecord(base.headers),
		metadata: base.metadata,
	};
}

/** Wire names of the sampling parameters oh-my-pi has options for. Other keys of `samplingParams` are dropped. */
const SAMPLING_OPTION_NAMES = new Map<string, keyof OmpSampling>([
	["temperature", "temperature"],
	["top_p", "topP"],
	["top_k", "topK"],
	["min_p", "minP"],
	["presence_penalty", "presencePenalty"],
	["frequency_penalty", "frequencyPenalty"],
	["repetition_penalty", "repetitionPenalty"],
]);

function encodeSampling(params: SamplingParams | undefined): OmpSampling {
	const sampling: OmpSampling = {};
	for (const [name, value] of Object.entries(params ?? {})) {
		const option = SAMPLING_OPTION_NAMES.get(name);
		// `samplingParams` come from models.json and extensions, where values are not typed.
		if (option !== undefined && typeof value === "number") sampling[option] = value;
	}
	return sampling;
}

// Response: SSE frames, one `AssistantMessageEvent` of oh-my-pi each, as Pi events.

/** Data of each SSE frame up to `[DONE]`. Comment frames, such as the broker's keepalives, have none. */
async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/gu, "\n");
			let end = buffer.indexOf("\n\n");
			while (end !== -1) {
				const data = frameData(buffer.slice(0, end));
				buffer = buffer.slice(end + 2);
				if (data === "[DONE]") return;
				if (data !== undefined) yield data;
				end = buffer.indexOf("\n\n");
			}
			if (done) break;
		}
		const data = frameData(buffer);
		if (data !== undefined && data !== "[DONE]") yield data;
	} finally {
		// Closing early (after a terminal event or an abort) releases the connection.
		await reader.cancel().catch(() => undefined);
	}
}

function frameData(frame: string): string | undefined {
	const lines = frame
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^ /u, ""));
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function parseFrame(data: string): OmpFrame {
	try {
		// Wire input: the decoder reads only the fields it needs and ignores frame types it does not know.
		return JSON.parse(data) as OmpFrame;
	} catch (error) {
		throw new Error("The account broker sent an event that is not JSON.", { cause: error });
	}
}

interface DecoderState {
	model: Model<Api>;
	/** The turn so far. Every event shares this object, as Pi's own adapters do. */
	message: AssistantMessage;
	/** Pi content index of each oh-my-pi content index; undefined where Pi has no block for it. */
	slots: (number | undefined)[];
	/** Parsers of the arguments of open tool calls, by Pi content index. */
	toolArguments: Map<number, ToolCallArgumentsStream>;
}

function createDecoder(model: Model<Api>): DecoderState {
	return {
		model,
		message: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: emptyCost() },
			stopReason: "pending",
			timestamp: Date.now(),
		},
		slots: [],
		toolArguments: new Map(),
	};
}

function emptyCost(): Usage["cost"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function decodeFrame(state: DecoderState, frame: OmpFrame): AssistantMessageEvent[] {
	switch (frame.type) {
		case "start":
			return [{ type: "start", partial: state.message }];
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
		case "text_end":
		case "thinking_end":
		case "toolcall_end":
			return decodeBlockFrame(state, frame);
		case "done": {
			const events = adoptBlocks(state, frame.message.content);
			finishTurn(state, frame.message, frame.reason);
			return [...events, { type: "done", reason: frame.reason, message: state.message }];
		}
		case "error": {
			if (!frame.error) {
				const error = new Error(frame.errorMessage ?? "The account broker's stream failed.");
				return [failTurn(state, error, frame.reason === "aborted")];
			}
			const events = adoptBlocks(state, frame.error.content);
			finishTurn(state, frame.error, frame.reason);
			return [...events, { type: "error", reason: frame.reason, error: state.message }];
		}
		default:
			// Frames of generated images, and of newer protocol versions, have no Pi event.
			return [];
	}
}

/** Pi's content index for a block of the turn, or undefined when Pi shows no block for it. */
function piIndex(state: DecoderState, ompIndex: number): number | undefined {
	return Number.isInteger(ompIndex) ? state.slots[ompIndex] : undefined;
}

/**
 * Gives the first `count` blocks of `blocks` that have no Pi block yet one. The turn in a frame can be ahead of
 * its event, so a frame adopts only up to its own block: later blocks wait for their events, which keeps events
 * in block order. oh-my-pi opens redacted reasoning without any event, so those blocks get their events here.
 */
function adoptBlocks(state: DecoderState, blocks: readonly OmpBlock[], count = blocks.length): AssistantMessageEvent[] {
	const events: AssistantMessageEvent[] = [];
	for (let index = state.slots.length; index < Math.min(blocks.length, count); index++) {
		const block = openBlock(blocks[index]!);
		if (!block) {
			state.slots.push(undefined);
			continue;
		}
		const contentIndex = state.message.content.push(block) - 1;
		state.slots.push(contentIndex);
		if (block.type === "thinking" && block.redacted) {
			const partial = state.message;
			events.push({ type: "thinking_start", contentIndex, partial });
			events.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
		}
	}
	return events;
}

/** The Pi block for a new oh-my-pi block: text and arguments start empty and fill from their deltas. */
function openBlock(block: OmpBlock): AssistantMessage["content"][number] | undefined {
	switch (block.type) {
		case "text":
			return { type: "text", text: "" };
		case "thinking":
			return { type: "thinking", thinking: "" };
		case "redactedThinking":
			return redactedBlock(block.data);
		case "toolCall":
			return { type: "toolCall", id: block.id, name: block.name, arguments: {} };
		default:
			return undefined;
	}
}

function decodeBlockFrame(state: DecoderState, frame: OmpBlockFrame): AssistantMessageEvent[] {
	// The index comes from the wire and keys an array.
	const events = adoptBlocks(
		state,
		frame.partial.content,
		Number.isInteger(frame.contentIndex) ? frame.contentIndex + 1 : 0,
	);
	const contentIndex = piIndex(state, frame.contentIndex);
	const block = contentIndex === undefined ? undefined : state.message.content[contentIndex];
	if (contentIndex === undefined || block === undefined) return events;
	const partial = state.message;
	const source = frame.partial.content[frame.contentIndex];
	switch (frame.type) {
		case "text_start":
		case "thinking_start":
			events.push({ type: frame.type, contentIndex, partial });
			break;
		case "toolcall_start":
			state.toolArguments.set(contentIndex, new ToolCallArgumentsStream());
			events.push({ type: "toolcall_start", contentIndex, partial });
			break;
		case "text_delta":
			if (block.type !== "text") break;
			block.text += frame.delta;
			events.push({ type: "text_delta", contentIndex, delta: frame.delta, partial });
			break;
		case "thinking_delta":
			if (block.type !== "thinking") break;
			block.thinking += frame.delta;
			events.push({ type: "thinking_delta", contentIndex, delta: frame.delta, partial });
			break;
		case "toolcall_delta": {
			const args = state.toolArguments.get(contentIndex);
			if (block.type !== "toolCall" || !args) break;
			block.arguments = args.append(frame.delta);
			events.push({ type: "toolcall_delta", contentIndex, delta: frame.delta, partial });
			break;
		}
		case "text_end":
			if (block.type !== "text") break;
			block.text = frame.content;
			if (source?.type === "text" && source.textSignature !== undefined) block.textSignature = source.textSignature;
			events.push({ type: "text_end", contentIndex, content: frame.content, partial });
			break;
		case "thinking_end":
			if (block.type !== "thinking") break;
			block.thinking = frame.content;
			if (source?.type === "thinking" && source.thinkingSignature !== undefined) {
				block.thinkingSignature = source.thinkingSignature;
			}
			events.push({ type: "thinking_end", contentIndex, content: frame.content, partial });
			break;
		case "toolcall_end":
			if (block.type !== "toolCall") break;
			state.toolArguments.delete(contentIndex);
			Object.assign(block, decodeToolCall(frame.toolCall));
			events.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
			break;
	}
	return events;
}

/** Pi keeps the opaque payload of redacted reasoning in `thinkingSignature`, with a placeholder as the text. */
function redactedBlock(data: string): ThinkingContent {
	return { type: "thinking", thinking: REDACTED_THINKING_TEXT, thinkingSignature: data, redacted: true };
}

function decodeToolCall(call: OmpToolCall): ToolCall {
	return {
		type: "toolCall",
		id: call.id,
		name: call.name,
		arguments: call.arguments,
		...(call.thoughtSignature === undefined ? {} : { thoughtSignature: call.thoughtSignature }),
		...(call.namespace === undefined ? {} : { namespace: call.namespace }),
	};
}

/**
 * Takes the finished turn of oh-my-pi as the record. Its message, not the deltas, is the record: oh-my-pi corrects
 * a turn after streaming it, for example by healing markup, so the content is rebuilt from it.
 */
function finishTurn(state: DecoderState, final: OmpAssistantMessage, reason: OmpStopReason): void {
	const { message, model } = state;
	message.content = final.content.flatMap(decodeBlock);
	message.usage = decodeUsage(model, final.usage);
	message.stopReason = reason;
	message.responseId = final.responseId;
	if (final.upstreamModel !== undefined && final.upstreamModel !== model.id) {
		message.responseModel = final.upstreamModel;
	}
	message.errorMessage = final.errorMessage;
}

function decodeBlock(block: OmpBlock): AssistantMessage["content"] {
	switch (block.type) {
		case "text":
			return [block];
		case "thinking":
			return [{ type: "thinking", thinking: block.thinking, thinkingSignature: block.thinkingSignature }];
		case "redactedThinking":
			return [redactedBlock(block.data)];
		case "toolCall":
			return [decodeToolCall(block)];
		default:
			return [];
	}
}

/** Token counts are oh-my-pi's; the cost is priced from Pi's catalog entry, as for every other Pi adapter. */
function decodeUsage(model: Model<Api>, usage: OmpUsage): Usage {
	const decoded: Usage = {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: emptyCost(),
	};
	if (usage.cttl?.ephemeral1h !== undefined) decoded.cacheWrite1h = usage.cttl.ephemeral1h;
	if (usage.reasoningTokens !== undefined) decoded.reasoning = usage.reasoningTokens;
	calculateCost(model, decoded);
	return decoded;
}

/** Ends the turn with what arrived so far: aborted when the caller's signal fired, an error otherwise. */
function failTurn(state: DecoderState, error: unknown, isAborted: boolean): AssistantMessageEvent {
	const reason = isAborted ? "aborted" : "error";
	state.message.stopReason = reason;
	state.message.errorMessage = formatThrownValue(error);
	return { type: "error", reason, error: state.message };
}
