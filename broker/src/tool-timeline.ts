// Projects an opted-in, append-only tool timeline onto first-party OpenAI Responses history.
import { isDeepStrictEqual } from "node:util";
import type { Api, DeveloperMessage, Model, Tool } from "@oh-my-pi/pi-ai";
import {
	convertOpenAICodexResponsesTools,
	resolveCodexResponsesUrl,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { responsesToolCallKind } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { findStrictToolSchemaViolation, isValidJsonSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { object, text, type WireObject } from "./wire.ts";

type ResponsesModel = Model<"openai-responses"> | Model<"openai-codex-responses">;
type ToolAddition = { at: number; tools: Tool[] };

/** Builds a provider-specific pi-native body, or leaves the original bytes authoritative. */
export function projectToolTimeline(body: WireObject, candidate: Model<Api>): string | undefined {
	const model = getResponsesModel(candidate);
	if (!model) return;
	const timeline = object(body.toolTimeline);
	const apis: unknown = timeline.apis;
	if (
		!Array.isArray(apis) ||
		!apis.includes(model.api) ||
		!apis.every((api) => api === "openai-codex-responses" || api === "openai-responses") ||
		new Set(apis).size !== apis.length ||
		object(body.options).toolChoice !== undefined
	)
		return;
	const context = object(body.context);
	const { messages, tools, ...rest } = context;
	if (!Array.isArray(messages) || !Array.isArray(tools)) return;
	const toolsByName = new Map<string, WireObject>();
	for (const rawTool of tools) {
		const tool = object(rawTool);
		const name = text(tool.name);
		if (!name || toolsByName.has(name)) return;
		toolsByName.set(name, tool);
	}
	const addedAt = new Map<string, number>();
	const additions = readAdditions(timeline.additions, messages.length, toolsByName, addedAt);
	if (!additions || !canInsert(messages, additions, addedAt, model)) return;
	for (const tool of toolsByName.values()) {
		const wireName = text(tool.customWireName);
		if (wireName && addedAt.has(wireName)) return;
	}

	const projected = [];
	let previous = 0;
	try {
		for (const { at, tools: added } of additions) {
			const timestamp = object(messages[at - 1]).timestamp;
			const converted = convertAdditions(model, added);
			if (typeof timestamp !== "number" || !converted) return;
			for (; previous < at; previous++) projected.push(messages[previous]);
			projected.push({
				role: "developer",
				content: "",
				timestamp,
				providerPayload: createOpenAIResponsesHistoryPayload(model.provider, [
					{ type: "additional_tools", role: "developer", tools: converted },
				]),
			} satisfies DeveloperMessage);
		}
		for (; previous < messages.length; previous++) projected.push(messages[previous]);
		const head = [...toolsByName].filter(([name]) => !addedAt.has(name)).map(([, tool]) => tool);
		return JSON.stringify({
			...body,
			context: { ...rest, messages: projected, ...(head.length > 0 && { tools: head }) },
		});
	} catch {
		// Untrusted schemas or unsupported OMP conversion must leave the unmodified request in charge.
		return;
	}
}

function getResponsesModel(model: Model<Api>): ResponsesModel | undefined {
	if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {
		if (resolveCodexResponsesUrl(model.baseUrl) !== "https://chatgpt.com/backend-api/codex/responses") return;
		return model as Model<"openai-codex-responses">; // The API discriminates Model's compatibility fields.
	}
	if (model.provider === "openai" && model.api === "openai-responses") {
		const responses = model as Model<"openai-responses">; // The API discriminates Model's compatibility fields.
		if (
			model.baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1" &&
			!responses.compat.connectionBoundNativeHistory &&
			!responses.compat.toolNamePrefix
		)
			return responses;
	}
}

function readAdditions(
	value: unknown,
	length: number,
	toolsByName: ReadonlyMap<string, WireObject>,
	addedAt: Map<string, number>,
): ToolAddition[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return;
	const additions: ToolAddition[] = [];
	let previous = 0;
	for (const raw of value) {
		const { at, names } = object(raw);
		if (typeof at !== "number" || !Number.isInteger(at) || at <= previous || at > length) return;
		if (!Array.isArray(names) || names.length === 0) return;
		const tools: Tool[] = [];
		for (const name of names) {
			if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(name) || addedAt.has(name)) return;
			const tool = toolsByName.get(name);
			if (
				!tool ||
				typeof tool.description !== "string" ||
				!isValidJsonSchema(tool.parameters) ||
				(tool.strict !== undefined && typeof tool.strict !== "boolean") ||
				tool.native !== undefined ||
				tool.customFormat !== undefined ||
				tool.customWireName !== undefined ||
				tool.deferLoading !== undefined
			)
				return;
			// pi-native parameters are serialized JSON Schemas; the normal OMP converters accept this shape.
			tools.push(tool as unknown as Tool);
			addedAt.set(name, at);
		}
		additions.push({ at, tools });
		previous = at;
	}
	return additions;
}

function canInsert(
	messages: readonly unknown[],
	additions: readonly ToolAddition[],
	addedAt: ReadonlyMap<string, number>,
	model: ResponsesModel,
): boolean {
	const pending = new Set<string>();
	let next = 0;
	for (let index = 0; index <= messages.length; index++) {
		const message = object(messages[index]);
		if (additions[next]?.at === index) {
			// Changing the native input within a parallel call/result group can invalidate Responses pairing.
			if (pending.size || message.role === "toolResult") return false;
			next++;
		}
		if (index === messages.length) break;
		if (message.role === "toolResult") {
			const name = text(message.toolName);
			const id = text(message.toolCallId);
			if (!name || !id || (addedAt.get(name) ?? 0) > index) return false;
			pending.delete(callId(id));
		} else if (message.role === "assistant") {
			if (!Array.isArray(message.content)) return false;
			for (const rawBlock of message.content) {
				const block = object(rawBlock);
				if (block.type !== "toolCall") continue;
				const name = text(block.name);
				const id = text(block.id);
				if (!name || !id || (addedAt.get(name) ?? 0) > index) return false;
				pending.add(callId(id));
			}
		}
		const payload = object(message.providerPayload);
		if (payload.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) continue;
		if ((payload.provider ?? message.provider ?? model.provider) !== model.provider) continue;
		// A legacy full-history assistant snapshot replaces earlier items instead of appending them.
		if (message.role === "assistant" && payload.dt !== true && index >= additions[0].at) return false;
		for (const rawItem of payload.items) {
			const item = object(rawItem);
			if (item.type === "additional_tools") return false;
			if (!responsesToolCallKind(item.type)) continue;
			const name = text(item.name);
			const id = text(item.call_id);
			if (!id || (name && (addedAt.get(name) ?? 0) > index)) return false;
			pending.add(id);
		}
	}
	return true;
}

function callId(id: string): string {
	// OMP's transcript IDs may carry a native call ID and an item ID separated by a bar or newline.
	return id.split(/[|\n]/u, 1)[0];
}

function convertAdditions(model: ResponsesModel, tools: Tool[]) {
	const converted =
		model.api === "openai-codex-responses"
			? convertOpenAICodexResponsesTools(tools, model)
			: convertTools(tools, model.compat.supportsStrictMode !== false, model);
	if (
		converted.length !== tools.length ||
		!converted.every(
			(tool, index) =>
				tool.type === "function" &&
				tool.name === tools[index].name &&
				!findStrictToolSchemaViolation(tool.parameters),
		)
	)
		return;
	// Responses can learn to retry without strict mode inside OMP's session. Native history bypasses that step.
	if (
		model.api === "openai-responses" &&
		model.compat.supportsStrictMode !== false &&
		!isDeepStrictEqual(converted, convertTools(tools, false, model))
	)
		return;
	return converted;
}
