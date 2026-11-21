import { describe, expect, test } from "bun:test";
import { hasReasoningError, REASONING_SUMMARY_LABEL, rewriteReasoning } from "../src/reasoning.ts";

const signature = "private-account-bound-signature";
const encrypted = "private-encrypted-reasoning";

type RewrittenMessage = Record<string, unknown> & { content?: unknown; tool_calls?: unknown };

function messageAt(body: Record<string, unknown>, key: "messages" | "input", index: number): RewrittenMessage {
	const items = body[key];
	if (!Array.isArray(items)) throw new Error(`Expected ${key} to be an array`);
	const item: unknown = items[index];
	if (item === null || typeof item !== "object" || Array.isArray(item)) {
		throw new Error(`Expected ${key}[${index}] to be a message object`);
	}
	return item as RewrittenMessage;
}

function contentAt(message: RewrittenMessage, index: number): unknown {
	if (!Array.isArray(message.content)) throw new Error("Expected message content to be an array");
	return message.content[index];
}

describe("reasoning continuity", () => {
	test("Anthropic replaces signed thinking with a labeled summary and drops redacted content", () => {
		const visible = { type: "text", text: "Visible answer" };
		const body = {
			model: "claude",
			max_tokens: 1024,
			thinking: { type: "enabled", budget_tokens: 512 },
			messages: [
				{ role: "user", content: "Question" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "  Check the logs  ", signature },
						{ type: "redacted_thinking", data: encrypted },
						visible,
					],
				},
				{ role: "user", content: "Next question" },
			],
		};
		const before = structuredClone(body);
		const output = rewriteReasoning(body, "anthropic");
		expect(output).not.toBe(body);
		const assistant = messageAt(output, "messages", 1);
		expect(assistant.content).toEqual([
			{ type: "text", text: `${REASONING_SUMMARY_LABEL}\nCheck the logs` },
			visible,
		]);
		expect(contentAt(assistant, 1)).toBe(visible);
		expect(output.thinking).toBe(body.thinking);
		expect(output.max_tokens).toBe(1024);
		expect(body).toEqual(before);
		expect(JSON.stringify(output)).not.toContain(signature);
		expect(JSON.stringify(output)).not.toContain(encrypted);
		expect(rewriteReasoning(output, "anthropic")).toBe(output);
	});

	test.each(["enabled", "adaptive"])(
		"in-flight Anthropic tools disable %s thinking while preserving calls and results",
		(type) => {
			const call = { type: "tool_use", id: "call-1", name: "read", input: { path: "file" } };
			const result = {
				type: "tool_result",
				tool_use_id: "call-1",
				content: [{ type: "text", text: "File contents" }],
			};
			const body = {
				thinking: { type, budget_tokens: 512 },
				messages: [
					{ role: "assistant", content: [{ type: "thinking", thinking: "Read the file", signature }, call] },
					{ role: "user", content: [result] },
				],
			};
			const output = rewriteReasoning(body, "anthropic");
			expect(output.thinking).toEqual({ type: "disabled" });
			expect(contentAt(messageAt(output, "messages", 0), 1)).toBe(call);
			expect(messageAt(output, "messages", 1)).toBe(body.messages[1]);
			expect(contentAt(messageAt(output, "messages", 1), 0)).toBe(result);
			expect(body.thinking.type).toBe(type);
		},
	);

	test("redacted-only in-flight thinking is removed and disables thinking", () => {
		const call = { type: "tool_use", id: "t", name: "read", input: {} };
		const output = rewriteReasoning(
			{
				thinking: { type: "adaptive" },
				messages: [
					{ role: "assistant", content: [{ type: "redacted_thinking", data: encrypted }, call] },
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
				],
			},
			"anthropic",
		);
		expect(output.thinking).toEqual({ type: "disabled" });
		expect(messageAt(output, "messages", 0).content).toEqual([call]);
	});

	test("completed Anthropic tool turns do not disable thinking on a later turn", () => {
		const body = {
			thinking: { type: "adaptive" },
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "plan", signature },
						{ type: "tool_use", id: "t" },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
				{ role: "assistant", content: "Done" },
				{ role: "user", content: "Next" },
			],
		};
		expect(rewriteReasoning(body, "anthropic").thinking).toBe(body.thinking);
	});

	test("empty Anthropic reasoning disappears without inventing a summary or thinking setting", () => {
		const output = rewriteReasoning(
			{
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: " \n ", signature },
							{ type: "thinking", signature },
							{ type: "redacted_thinking", data: encrypted },
						],
					},
				],
			},
			"anthropic",
		);
		expect(messageAt(output, "messages", 0).content).toEqual([]);
		expect(output).not.toHaveProperty("thinking");
	});

	test("Responses summaries replace opaque reasoning while preserving visible messages and tool exchanges", () => {
		const visible = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Visible" }] };
		const call = { type: "function_call", call_id: "c1", name: "read", arguments: "{}" };
		const result = { type: "function_call_output", call_id: "c1", output: "Tool result" };
		const body = {
			reasoning: { effort: "high" },
			input: [
				{ role: "user", content: "Question" },
				{
					type: "reasoning",
					id: "r1",
					encrypted_content: encrypted,
					summary: [
						{ type: "summary_text", text: " First step " },
						{ type: "summary_text", text: "Second step" },
					],
				},
				{ type: "reasoning", id: "r2", encrypted_content: encrypted, summary: [] },
				{ type: "reasoning", id: "r3", encrypted_content: encrypted },
				visible,
				call,
				result,
			],
		};
		const before = structuredClone(body);
		const output = rewriteReasoning(body, "responses");
		expect(output.input).toEqual([
			body.input[0],
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: `${REASONING_SUMMARY_LABEL}\nFirst step\n\nSecond step` }],
			},
			visible,
			call,
			result,
		]);
		expect(messageAt(output, "input", 2)).toBe(visible);
		expect(messageAt(output, "input", 3)).toBe(call);
		expect(messageAt(output, "input", 4)).toBe(result);
		expect(output.reasoning).toBe(body.reasoning);
		expect(JSON.stringify(output)).not.toContain(encrypted);
		expect(JSON.stringify(output)).not.toContain("encrypted_content");
		expect(body).toEqual(before);
		expect(rewriteReasoning(output, "responses")).toBe(output);
	});

	test("chat reasoning fields become text while tool calls and results stay intact", () => {
		const calls = [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }];
		const result = { role: "tool", tool_call_id: "c1", content: "Tool result" };
		const body = {
			messages: [
				{
					role: "assistant",
					content: "Visible answer",
					reasoning_content: " Check logs ",
					reasoning: "Then read",
					reasoning_details: [
						{ type: "reasoning.summary", summary: "Find the issue", signature },
						{ type: "reasoning.text", text: "Check the stack", signature },
						{ type: "reasoning.encrypted", data: encrypted, text: encrypted },
					],
					tool_calls: calls,
				},
				result,
			],
		};
		const before = structuredClone(body);
		const output = rewriteReasoning(body, "chat");
		const assistant = messageAt(output, "messages", 0);
		expect(assistant.content).toBe(
			`${REASONING_SUMMARY_LABEL}\nCheck logs\n\nThen read\n\nFind the issue\n\nCheck the stack\n\nVisible answer`,
		);
		expect(assistant.tool_calls).toBe(calls);
		expect(messageAt(output, "messages", 1)).toBe(result);
		expect(assistant).not.toHaveProperty("reasoning_content");
		expect(assistant).not.toHaveProperty("reasoning");
		expect(assistant).not.toHaveProperty("reasoning_details");
		expect(JSON.stringify(output)).not.toContain(signature);
		expect(JSON.stringify(output)).not.toContain(encrypted);
		expect(body).toEqual(before);
		expect(rewriteReasoning(output, "chat")).toBe(output);
	});

	test("chat supports null and block content without losing visible content", () => {
		const visible = { type: "text", text: "Visible" };
		const output = rewriteReasoning(
			{
				messages: [
					{ role: "assistant", content: null, reasoning_content: "plan", tool_calls: [{ id: "c" }] },
					{ role: "assistant", content: [visible], reasoning_content: "plan" },
					{
						role: "assistant",
						content: null,
						reasoning_details: [{ type: "reasoning.encrypted", data: encrypted }],
					},
				],
			},
			"chat",
		);
		expect(messageAt(output, "messages", 0).content).toBe(`${REASONING_SUMMARY_LABEL}\nplan`);
		const assistant = messageAt(output, "messages", 1);
		expect(assistant.content).toEqual([{ type: "text", text: `${REASONING_SUMMARY_LABEL}\nplan` }, visible]);
		expect(contentAt(assistant, 1)).toBe(visible);
		expect(messageAt(output, "messages", 2)).toEqual({ role: "assistant", content: null });
	});

	test.each(["anthropic", "responses", "chat"] as const)(
		"%s summaries cap reasoning at 1500 Unicode code points",
		(protocol) => {
			const text = "😀".repeat(1501);
			const body =
				protocol === "anthropic"
					? { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: text, signature }] }] }
					: protocol === "responses"
						? { input: [{ type: "reasoning", summary: [{ text }], encrypted_content: encrypted }] }
						: { messages: [{ role: "assistant", content: null, reasoning_content: text }] };
			const output = rewriteReasoning(body, protocol);
			const message = messageAt(output, protocol === "responses" ? "input" : "messages", 0);
			let summary = message.content;
			if (protocol !== "chat") {
				const block = contentAt(message, 0);
				if (block === null || typeof block !== "object" || !("text" in block)) {
					throw new Error("Expected a summary text block");
				}
				summary = block.text;
			}
			expect(summary).toBe(`${REASONING_SUMMARY_LABEL}\n${"😀".repeat(1500)} …`);
		},
	);

	test("visible-only requests and tool payloads are not interpreted as reasoning", () => {
		const body = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "Question" }] },
				{ role: "assistant", content: [{ type: "tool_use", input: { reasoning: "visible tool argument" } }] },
				{ role: "tool", content: "Result", reasoning: "tool-owned field" },
			],
			input: "Simple input",
		};
		for (const protocol of ["anthropic", "responses", "chat"] as const) {
			expect(rewriteReasoning(body, protocol)).toBe(body);
		}
	});

	test.each(["anthropic", "responses", "chat"] as const)("%s tolerates absent or malformed content", (protocol) => {
		for (const body of [
			{},
			{ messages: "text", input: "text" },
			{ messages: [null, 3, {}, { role: "assistant", content: "Visible" }], input: [null, 3, {}] },
		]) {
			expect(rewriteReasoning(body, protocol)).toBe(body);
		}
	});
});

describe("reasoning rejection detection", () => {
	test.each([
		'{"error":{"message":"Invalid `signature` in `thinking` block"}}',
		'{"error":{"code":"invalid_encrypted_content","message":"Could not verify"}}',
		"The ENCRYPTED CONTENT could not be verified",
		"thinking_signature_invalid",
	])("recognizes HTTP 400 reasoning rejection: %s", (text) => {
		expect(hasReasoningError(400, text)).toBe(true);
		for (const status of [200, 401, 403, 429, 500]) expect(hasReasoningError(status, text)).toBe(false);
	});

	test.each(["", "max_tokens too large", "Invalid request signature", "thinking budget too high"])(
		"does not retry unrelated HTTP 400 errors: %s",
		(text) => {
			expect(hasReasoningError(400, text)).toBe(false);
		},
	);
});
