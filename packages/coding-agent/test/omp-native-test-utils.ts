// Builds the event stream oh-my-pi's auth gateway sends for `POST /v1/pi/stream`, in the shape of its
// `encodeStream` (providers/pi-native-server.ts): a `: keepalive` comment first, one `data: <event JSON>` frame per
// `AssistantMessageEvent` with the whole turn so far in `partial`, and `data: [DONE]` last. The events and blocks
// are the ones oh-my-pi's Anthropic provider emits (providers/anthropic.ts).

export interface OmpUsageInput {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	reasoningTokens?: number;
	cttl?: { ephemeral5m?: number; ephemeral1h?: number };
}

type Block = Record<string, unknown>;

interface OmpPartial {
	role: "assistant";
	content: Block[];
	api: string;
	provider: string;
	model: string;
	responseId?: string;
	upstreamModel?: string;
	usage: Record<string, unknown>;
	stopReason: string;
	errorMessage?: string;
	timestamp: number;
	requestControls?: Record<string, unknown>;
	providerPayload?: Record<string, unknown>;
}

export interface OmpTurnOptions {
	model?: string;
	/** The identity oh-my-pi resolved for the model, which is not Pi's. */
	api?: string;
	provider?: string;
	/**
	 * Every frame carries the turn as it is when the stream is encoded, not as it was at the event. oh-my-pi
	 * serializes its live `partial`, so a slow reader sees frames whose `partial` is ahead.
	 */
	live?: boolean;
}

function usageOf(input: OmpUsageInput = {}): Record<string, unknown> {
	const { input: inputTokens = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = input;
	return {
		input: inputTokens,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input.totalTokens ?? inputTokens + output + cacheRead + cacheWrite,
		...(input.reasoningTokens === undefined ? {} : { reasoningTokens: input.reasoningTokens }),
		...(input.cttl === undefined ? {} : { cttl: input.cttl }),
		// oh-my-pi prices its own catalog entry; Pi prices from its own and ignores this.
		cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, total: 36 },
	};
}

/** Records the events oh-my-pi emits for one turn. Each method adds the events its block produces. */
export function ompTurn(options: OmpTurnOptions = {}) {
	const partial: OmpPartial = {
		role: "assistant",
		content: [],
		api: options.api ?? "anthropic-messages",
		provider: options.provider ?? "anthropic",
		model: options.model ?? "claude-test-1",
		usage: usageOf(),
		stopReason: "stop",
		timestamp: 1,
	};
	const frames: unknown[] = [];
	const emit = (event: Record<string, unknown>) => {
		frames.push({ ...event, partial: options.live ? partial : structuredClone(partial) });
	};
	const open = (block: Block, kind: string) => {
		partial.content.push(block);
		const contentIndex = partial.content.length - 1;
		emit({ type: `${kind}_start`, contentIndex });
		return contentIndex;
	};

	const turn = {
		frames,
		partial,
		start() {
			emit({ type: "start" });
			return turn;
		},
		text(text: string, parts: string[] = [text], textSignature?: string) {
			const block: Block = { type: "text", text: "" };
			const contentIndex = open(block, "text");
			for (const delta of parts) {
				block.text = `${block.text as string}${delta}`;
				emit({ type: "text_delta", contentIndex, delta });
			}
			if (textSignature !== undefined) block.textSignature = textSignature;
			emit({ type: "text_end", contentIndex, content: text });
			return turn;
		},
		thinking(thinking: string, signature: string, parts: string[] = [thinking]) {
			const block: Block = { type: "thinking", thinking: "", thinkingSignature: "" };
			const contentIndex = open(block, "thinking");
			for (const delta of parts) {
				block.thinking = `${block.thinking as string}${delta}`;
				emit({ type: "thinking_delta", contentIndex, delta });
			}
			block.thinkingSignature = signature;
			emit({ type: "thinking_end", contentIndex, content: thinking });
			return turn;
		},
		/** oh-my-pi opens redacted reasoning without any event. */
		redacted(data: string) {
			partial.content.push({ type: "redactedThinking", data });
			return turn;
		},
		/** A block Pi has no counterpart for: oh-my-pi opens it without an event Pi could show. */
		foreign(block: Block) {
			partial.content.push(block);
			return turn;
		},
		toolCall(id: string, name: string, args: Record<string, unknown>, parts: string[] = [JSON.stringify(args)]) {
			const block: Block = { type: "toolCall", id, name, arguments: {} };
			const contentIndex = open(block, "toolcall");
			for (const delta of parts) emit({ type: "toolcall_delta", contentIndex, delta });
			block.arguments = args;
			emit({ type: "toolcall_end", contentIndex, toolCall: structuredClone(block) });
			return turn;
		},
		/** oh-my-pi corrects a turn after streaming it, so the finished message can differ from the deltas. */
		correct(index: number, fields: Block) {
			Object.assign(partial.content[index]!, fields);
			return turn;
		},
		done(reason: "stop" | "length" | "toolUse", usage?: OmpUsageInput, extra: Partial<OmpPartial> = {}) {
			Object.assign(partial, { stopReason: reason, usage: usageOf(usage), ...extra });
			emit({ type: "done", reason, message: partial });
			return turn;
		},
		error(reason: "error" | "aborted", errorMessage: string, usage?: OmpUsageInput) {
			Object.assign(partial, { stopReason: reason, errorMessage, usage: usageOf(usage) });
			emit({ type: "error", reason, error: partial });
			return turn;
		},
		/** The gateway's envelope for a transport failure: an error frame with no turn. */
		failure(errorMessage: string) {
			frames.push({ type: "error", reason: "error", errorMessage });
			return turn;
		},
		sse() {
			return sseText(frames);
		},
	};
	return turn;
}

/** The SSE body of a gateway response: keepalive first, one data frame per event, then `[DONE]`. */
export function sseText(frames: unknown[], options: { terminator?: boolean } = {}): string {
	const data = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
	return `: keepalive\n\n${data}${options.terminator === false ? "" : "data: [DONE]\n\n"}`;
}

export function sseResponse(body: BodyInit, init: ResponseInit = {}): Response {
	return new Response(body, { ...init, headers: { "content-type": "text/event-stream", ...init.headers } });
}

/** A response body that delivers `text` in pieces of `size` bytes, to exercise frames split across reads. */
export function chunkedBody(text: string, size: number): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		},
	});
}
