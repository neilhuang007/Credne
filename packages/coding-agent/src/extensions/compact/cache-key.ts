// Gives the cached requests of one compaction step one prompt cache key, in the field each provider routes its prompt
// cache by, so that each request reaches the cache the step's first request wrote. Compaction requests carry no session
// ID, which would also turn on Anthropic message threads. A request through the account broker then gets a new session
// ID of its own, which oh-my-pi sends to OpenAI and Codex as its cache key, so without a shared key no two requests
// meet in one cache; OpenAI's own API also routes requests that share a key to the same cache.
import { randomBytes } from "node:crypto";
import type { Api, Model, ProviderRequestOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { OMP_NATIVE_API } from "../accounts/omp-native.ts";
import { brokerPromptCacheKind } from "../accounts/provider.ts";

/** Replaces a request's payload before it is sent, or keeps it when it returns undefined. */
type PayloadHook = NonNullable<ProviderRequestOptions["onPayload"]>;

// The hook receives each adapter's payload untyped; the adapter of the model's API owns its shape.
const payloadSchema = Type.Object({});
const brokerPayloadSchema = Type.Object({ options: Type.Object({}) });

/**
 * A payload hook that puts one new prompt cache key into every request of `model` it sees, or undefined for the other
 * APIs, among them Anthropic's own, which caches by the breakpoints its adapter marks.
 */
export function oneCacheKey(model: Model<Api>, ctx: ExtensionContext): PayloadHook | undefined {
	// 48 hex digits, the length of the account broker's Anthropic affinity keys.
	const id = randomBytes(24).toString("hex");
	switch (model.api) {
		case OMP_NATIVE_API:
			return brokerCacheKey(model, id, ctx);
		case "openai-responses":
		case "openai-codex-responses": {
			// An OpenAI-compatible endpoint that rejects the field says so in its compat. Codex also sends the key as its
			// `session-id` header.
			const { compat } = model;
			if (compat && "promptCacheKeyMode" in compat && compat.promptCacheKeyMode === "disabled") return undefined;
			return (payload) =>
				Value.Check(payloadSchema, payload) ? { ...payload, prompt_cache_key: `compaction-${id}` } : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * The hook for a request through the account broker, by the prompt cache of the provider behind it. The broker keeps
 * requests that share a key on the account that answered the first, as it does for subagent workers.
 */
function brokerCacheKey(model: Model<Api>, id: string, ctx: ExtensionContext): PayloadHook | undefined {
	switch (brokerPromptCacheKind(ctx.modelRegistry.getProvider(model.provider), model.id)) {
		case "openai":
			// oh-my-pi sends `promptCacheKey` as OpenAI's `prompt_cache_key`, and the broker also puts it in Codex's
			// `session_id` header, in place of the request's own session ID.
			return (payload) =>
				Value.Check(brokerPayloadSchema, payload)
					? {
							...payload,
							cacheAffinity: "shared-prefix",
							options: { ...payload.options, promptCacheKey: `compaction-${id}` },
						}
					: undefined;
		case "anthropic":
			// oh-my-pi marks Claude's cache breakpoints itself, so the key only keeps the requests on one account of a pool.
			// The broker accepts it only in the form subagent workers send.
			return (payload) =>
				Value.Check(payloadSchema, payload)
					? { ...payload, cacheAffinity: "anthropic-shared-prefix", cacheAffinityKey: `subagent-${id}` }
					: undefined;
		case undefined:
			return undefined;
	}
}
