// Server-sent event decoding of Anthropic Messages responses: the SSE framing of a response body, and the typed
// message events inside it. The Anthropic Messages stream (anthropic-messages.ts) does not use the SDK to read a
// response; it reads the events strictly through `iterateAnthropicEvents`.

import type { BetaRawMessageStreamEvent as RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { parseJsonWithRepair } from "../utils/json-parse.ts";

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const anthropicMessageEvents: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

/**
 * The first line of `text` and what follows it. A carriage return that ends the text may be the first half of a
 * CR LF whose second half is in the next chunk, so it waits, unless the stream has ended (`isFinal`).
 */
function consumeLine(text: string, isFinal: boolean): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}
	if (!isFinal && lineBreakIndex === text.length - 1 && text[lineBreakIndex] === "\r") {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer, false);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer, false);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer, true);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer, true);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * The message events of a response, parsed. Keepalive `ping` frames and unknown events
 * are skipped; `onPing` hears each ping, which is the only sign of life of a quiet stream. A frame that does not parse
 * and an `error` frame throw, so the caller can classify the failure. The envelope is not checked: that is up to
 * {@link iterateAnthropicEvents}.
 */
export async function* decodeAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
	onPing?: () => void,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!anthropicMessageEvents.has(sse.event ?? "")) {
			if (sse.event === "ping") onPing?.();
			continue;
		}

		let event: RawMessageStreamEvent;
		try {
			event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
		yield event;
	}
}

/**
 * The message events of a response, strictly: those of {@link decodeAnthropicEvents}, and a stream that ends after
 * `message_start` without `message_stop` throws, so the caller can classify the failure.
 */
export async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
	onPing?: () => void,
): AsyncGenerator<RawMessageStreamEvent> {
	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const event of decodeAnthropicEvents(response, signal, onPing)) {
		if (event.type === "message_start") {
			sawMessageStart = true;
		} else if (event.type === "message_stop") {
			sawMessageEnd = true;
		}
		yield event;
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}
