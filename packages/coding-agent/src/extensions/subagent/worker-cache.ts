// Places a worker's provider cache entries where its siblings can read them.
import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { OMP_NATIVE_API } from "../accounts/omp-native.ts";
import { brokerPromptCacheKind } from "../accounts/provider.ts";
import { PARENT_CONVERSATION_TAG } from "./parent-conversation.ts";
import type { RequestParent } from "./worker-channel.ts";

interface CacheIdentity {
	key: string;
	sharedKey: string;
}

/** Marks reusable prefixes and admits siblings after the leader's provider starts its reply. */
export function registerWorkerCache(pi: ExtensionAPI, requestParent?: RequestParent): void {
	if (!process.env.PI_SUBAGENT_WORKER_ID) return;
	let identity: CacheIdentity | undefined;
	let isReady = false;
	const resetPrefix = () => {
		identity = undefined;
		isReady = false;
	};
	pi.on("model_select", resetPrefix);
	pi.on("thinking_level_select", resetPrefix);
	pi.on("before_provider_request", async (event, ctx) => {
		// Provider payloads are a wire boundary: each adapter owns its request shape.
		const next = preparePayload(event.payload, ctx, isReady ? identity : undefined);
		if (!next) return;
		identity = next.identity;
		if (!isReady) await requestParent?.({ type: "cache_wait", ...identity }, undefined);
		return next.payload;
	});
	pi.on("provider_stream_event", async (event, ctx) => {
		if (!identity || isReady || event.provider !== ctx.model?.provider || event.model !== ctx.model.id) return;
		if (!hasStartedReply(event.api, event.data)) return;
		isReady = true;
		await requestParent?.({ type: "cache_ready", key: identity.key }, undefined);
	});
}

const blockSchema = Type.Object({
	type: Type.String(),
	text: Type.Optional(Type.String()),
	cache_control: Type.Optional(Type.Unknown()),
});

const messageSchema = Type.Object({
	role: Type.Optional(Type.String()),
	content: Type.Optional(Type.Union([Type.String(), Type.Array(blockSchema)])),
});

const prefixFields = {
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.Unknown())),
	thinking: Type.Optional(Type.Unknown()),
	output_config: Type.Optional(Type.Unknown()),
	reasoning: Type.Optional(Type.Unknown()),
	tool_choice: Type.Optional(Type.Unknown()),
	betas: Type.Optional(Type.Unknown()),
	cache_control: Type.Optional(Type.Unknown()),
};

const anthropicPayloadSchema = Type.Object({
	...prefixFields,
	system: Type.Array(blockSchema),
	tools: Type.Optional(Type.Array(Type.Object({ cache_control: Type.Optional(Type.Unknown()) }))),
	messages: Type.Array(messageSchema),
});

const ompPayloadSchema = Type.Object({
	modelId: Type.String(),
	context: Type.Object({
		systemPrompt: Type.Optional(Type.Array(Type.String())),
		tools: Type.Optional(Type.Array(Type.Unknown())),
		inactiveTools: Type.Optional(Type.Array(Type.Unknown())),
		messages: Type.Array(messageSchema),
	}),
	options: Type.Object({
		sessionId: Type.String(),
		cacheRetention: Type.Optional(Type.String()),
		reasoning: Type.Optional(Type.String()),
		toolChoice: Type.Optional(Type.Unknown()),
	}),
});
const responsesPayloadSchema = Type.Object({
	...prefixFields,
	prompt_cache_key: Type.String(),
	instructions: Type.Optional(Type.String()),
	input: Type.Array(messageSchema),
});
const chatPayloadSchema = Type.Object({
	...prefixFields,
	prompt_cache_key: Type.String(),
	messages: Type.Array(messageSchema),
});

type AnthropicPayload = Static<typeof anthropicPayloadSchema>;
type PrefixFields = Static<typeof responsesPayloadSchema>;
type WireMessage = Static<typeof messageSchema>;

function preparePayload(
	payload: unknown,
	ctx: ExtensionContext,
	identity: CacheIdentity | undefined,
): { payload: unknown; identity: CacheIdentity } | undefined {
	if (ctx.model?.api === OMP_NATIVE_API) {
		if (!Value.Check(ompPayloadSchema, payload) || payload.options.cacheRetention === "none") return undefined;
		const kind = brokerPromptCacheKind(ctx.modelRegistry.getProvider(ctx.model.provider), payload.modelId);
		if (kind === undefined) return undefined;
		const { context, options } = payload;
		if (kind === "anthropic" && options.cacheRetention === undefined && process.env.PI_CACHE_RETENTION === "none")
			return undefined;
		const prefix =
			identity ??
			identifyPrefix(
				{
					model: payload.modelId,
					tools: kind === "anthropic" ? [context.tools, context.inactiveTools] : context.tools,
					reasoning: options.reasoning,
					tool_choice: options.toolChoice,
				},
				context.systemPrompt,
				context.messages,
				ctx,
			);
		if (kind === "anthropic") {
			// OMP marks its request head, not the block before the task. Don't gate a reference it cannot warm.
			return {
				identity: { key: prefix.sharedKey, sharedKey: prefix.sharedKey },
				payload: { ...payload, cacheAffinity: "anthropic-shared-prefix", cacheAffinityKey: routingKey(prefix) },
			};
		}
		return {
			identity: prefix,
			payload: {
				...payload,
				cacheAffinity: "shared-prefix",
				options: { ...options, promptCacheKey: routingKey(prefix) },
			},
		};
	}
	if (Value.Check(anthropicPayloadSchema, payload)) {
		const marked = markConversationEnd(payload);
		if (!marked) return undefined;
		return { payload: marked, identity: identity ?? identifyPrefix(marked, marked.system, marked.messages, ctx) };
	}
	if (Value.Check(responsesPayloadSchema, payload)) {
		const prefix = identity ?? identifyPrefix(payload, payload.instructions, payload.input, ctx);
		return { identity: prefix, payload: { ...payload, prompt_cache_key: routingKey(prefix) } };
	}
	if (Value.Check(chatPayloadSchema, payload)) {
		const prefix = identity ?? identifyPrefix(payload, undefined, payload.messages, ctx);
		return { identity: prefix, payload: { ...payload, prompt_cache_key: routingKey(prefix) } };
	}
	return undefined;
}

function routingKey(identity: CacheIdentity): string {
	return `subagent-${identity.sharedKey.slice(0, 48)}`;
}

function identifyPrefix(
	payload: Omit<PrefixFields, "input" | "prompt_cache_key">,
	system: unknown,
	messages: WireMessage[],
	ctx: ExtensionContext,
): CacheIdentity {
	const firstUser = messages.findIndex((message) => message.role === "user");
	const content = messages[firstUser]?.content;
	const conversation = typeof content === "string" ? undefined : content?.[0]?.text;
	const sharedKey = createHash("sha256")
		.update(
			JSON.stringify([
				ctx.cwd,
				ctx.model?.provider,
				ctx.model?.api,
				ctx.model?.baseUrl,
				ctx.model?.id,
				payload.model,
				ctx.thinkingLevel,
				payload.tools,
				system,
				messages.slice(0, Math.max(0, firstUser)),
				payload.thinking,
				payload.output_config,
				payload.reasoning,
				payload.tool_choice,
				payload.betas,
			]),
		)
		.digest("hex");
	const key = createHash("sha256")
		.update(JSON.stringify([sharedKey, conversation?.startsWith(PARENT_CONVERSATION_TAG) ? conversation : undefined]))
		.digest("hex");
	return { key, sharedKey };
}

/** Keeps the system, reference and growing tail within four slots, including automatic caching. */
function markConversationEnd(payload: AnthropicPayload): AnthropicPayload | undefined {
	const marker = payload.system.at(-1)?.cache_control;
	if (marker === undefined) return undefined;
	const system = payload.system.map((block, index) =>
		index === payload.system.length - 1 ? block : withoutMarker(block),
	);
	const firstUser = payload.messages.findIndex((message) => message.role === "user");
	const firstContent = payload.messages[firstUser]?.content;
	const reference =
		typeof firstContent !== "string" && firstContent?.[0]?.text?.startsWith(PARENT_CONVERSATION_TAG)
			? firstContent[0]
			: undefined;
	const tail = payload.messages
		.flatMap((message) => (typeof message.content === "string" ? [] : (message.content ?? [])))
		.findLast((block) => block.cache_control !== undefined);
	// The tool-only checkpoint can hit after a system change. Give it the remaining slot, if any.
	const used =
		1 +
		Number(reference !== undefined) +
		Number(tail !== undefined && tail !== reference) +
		Number(payload.cache_control !== undefined);
	const toolCheckpoint = used < 4 ? payload.tools?.findLast((tool) => tool.cache_control !== undefined) : undefined;
	const tools = payload.tools?.map((tool) => (tool === toolCheckpoint ? tool : withoutMarker(tool)));
	const messages = payload.messages.map((message) => {
		if (typeof message.content === "string" || !message.content) return message;
		return {
			...message,
			content: message.content.map((block) => {
				if (block === reference) return { ...block, cache_control: marker };
				return block === tail ? block : withoutMarker(block);
			}),
		};
	});
	return { ...payload, system, ...(tools ? { tools } : {}), messages };
}

function withoutMarker<T extends { cache_control?: unknown }>(block: T): Omit<T, "cache_control"> {
	const { cache_control: _marker, ...rest } = block;
	return rest;
}

const providerEventSchema = Type.Object({ type: Type.String() });
const completedEventSchema = Type.Object({ response: Type.Object({ status: Type.String() }) });
const completionsEventSchema = Type.Object({
	choices: Type.Array(
		Type.Object({
			delta: Type.Object({
				content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				reasoning_content: Type.Optional(Type.String()),
				reasoning: Type.Optional(Type.String()),
				tool_calls: Type.Optional(Type.Array(Type.Unknown())),
			}),
			finish_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		}),
	),
});
const replyEvents = new Set([
	"response.output_text.delta",
	"response.reasoning_text.delta",
	"response.reasoning_summary_text.delta",
	"response.function_call_arguments.delta",
	"response.custom_tool_call_input.delta",
	"response.output_item.done",
]);

function hasStartedReply(api: string, data: unknown): boolean {
	// Raw provider events are a wire boundary. Headers and response.created can precede prefill.
	if (api === "openai-completions" && Value.Check(completionsEventSchema, data)) {
		return data.choices.some(
			({ delta, finish_reason: reason }) =>
				!!(delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls?.length || reason),
		);
	}
	if (!Value.Check(providerEventSchema, data)) return false;
	if (api === OMP_NATIVE_API) {
		return (
			data.type === "text_delta" ||
			data.type === "thinking_delta" ||
			data.type === "toolcall_delta" ||
			data.type === "done"
		);
	}
	if (api === "anthropic-messages") return data.type === "message_start";
	if (data.type === "response.completed" || data.type === "response.incomplete") {
		return (
			Value.Check(completedEventSchema, data) &&
			(data.response.status === "completed" || data.response.status === "incomplete")
		);
	}
	return replyEvents.has(data.type);
}
