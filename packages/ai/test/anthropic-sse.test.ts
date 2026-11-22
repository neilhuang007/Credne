import { describe, expect, it, vi } from "vitest";
import { decodeAnthropicEvents, iterateAnthropicEvents } from "../src/api/anthropic-sse.ts";

const messageStart = { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } } };
const textStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
const messageStop = { type: "message_stop" };

function frame(event: { type: string }): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function responseOf(chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
	);
}

async function readAll(response: Response, signal?: AbortSignal, onPing?: () => void) {
	const events: Array<{ type: string }> = [];
	for await (const event of iterateAnthropicEvents(response, signal, onPing)) events.push(event);
	return events;
}

describe("Anthropic SSE decoding", () => {
	it("decodes message events, however the bytes are chunked and whichever the line endings", async () => {
		const text = [messageStart, textStart, messageStop].map(frame).join("").replaceAll("\n", "\r\n");
		const chunks = text.match(/[\s\S]{1,7}/g) ?? [];

		const events = await readAll(responseOf(chunks));

		expect(events.map((event) => event.type)).toEqual(["message_start", "content_block_start", "message_stop"]);
	});

	it("joins the data lines of one event and ignores comments", async () => {
		const dataLines = JSON.stringify(messageStart, null, 1)
			.split("\n")
			.map((line) => `data: ${line}`)
			.join("\n");
		const text = `: keepalive comment\nevent: message_start\n${dataLines}\n\n${frame(messageStop)}`;

		const events = await readAll(responseOf([text]));

		expect(events[0]).toMatchObject({ type: "message_start", message: { id: "msg_1" } });
	});

	it("skips unknown events and reports each ping", async () => {
		const onPing = vi.fn();
		const text = `${frame(messageStart)}event: ping\ndata: {"type":"ping"}\n\nevent: vendor_extension\ndata: {}\n\n${frame(messageStop)}`;

		const events = await readAll(responseOf([text]), undefined, onPing);

		expect(events.map((event) => event.type)).toEqual(["message_start", "message_stop"]);
		expect(onPing).toHaveBeenCalledTimes(1);
	});

	it("throws the data of an error event", async () => {
		const error = `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`;

		await expect(readAll(responseOf([frame(messageStart), error]))).rejects.toThrow('"type":"overloaded_error"');
	});

	it("throws for a frame that does not parse, naming the frame", async () => {
		const text = `${frame(messageStart)}event: content_block_delta\ndata: {not json\n\n`;

		await expect(readAll(responseOf([text]))).rejects.toThrow(
			"Could not parse Anthropic SSE event content_block_delta",
		);
	});

	it("throws when the stream ends after message_start without message_stop", async () => {
		await expect(readAll(responseOf([frame(messageStart), frame(textStart)]))).rejects.toThrow(
			"Anthropic stream ended before message_stop",
		);
	});

	it("ends quietly on a stream with no message at all", async () => {
		expect(await readAll(responseOf([""]))).toEqual([]);
	});

	it("throws for a response with no body", async () => {
		await expect(readAll(new Response(null))).rejects.toThrow("no body");
	});

	it("stops reading once the signal aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(readAll(responseOf([frame(messageStart)]), controller.signal)).rejects.toThrow(
			"Request was aborted",
		);
	});
});

describe("the strict reader", () => {
	const messageDelta = (stopReason: string | null = "end_turn", outputTokens = 1) => ({
		type: "message_delta",
		delta: { stop_reason: stopReason },
		usage: { output_tokens: outputTokens },
	});
	const blockStart = (index: number) => ({
		type: "content_block_start",
		index,
		content_block: { type: "text", text: "" },
	});
	const blockStop = (index: number) => ({ type: "content_block_stop", index });
	const secondStart = {
		type: "message_start",
		message: { id: "msg_2", usage: { input_tokens: 9, output_tokens: 0 } },
	};

	function textOf(...events: Array<{ type: string }>): Response {
		return responseOf(events.map(frame));
	}

	it("decodes the events and leaves the envelope to the reader built on it", async () => {
		const events: Array<{ type: string }> = [];
		for await (const event of decodeAnthropicEvents(responseOf([frame(messageStart), frame(textStart)]))) {
			events.push(event);
		}

		expect(events.map((event) => event.type)).toEqual(["message_start", "content_block_start"]);
	});

	it("passes a second message_start and a replayed block through", async () => {
		const types: string[] = [];
		const spliced = textOf(
			messageStart,
			blockStart(0),
			blockStop(0),
			secondStart,
			blockStart(0),
			messageDelta(),
			messageStop,
		);
		for await (const event of iterateAnthropicEvents(spliced)) types.push(event.type);

		expect(types.filter((type) => type === "message_start")).toHaveLength(2);
		expect(types.filter((type) => type === "content_block_start")).toHaveLength(2);
	});

	it("does not take a stop reason for the end of the turn", async () => {
		const unfinished = textOf(messageStart, blockStart(0), blockStop(0), messageDelta());

		await expect(readAll(unfinished)).rejects.toThrow("Anthropic stream ended before message_stop");
	});
});
