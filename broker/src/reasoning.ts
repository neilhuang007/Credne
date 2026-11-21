export const REASONING_SUMMARY_LABEL = "[Reasoning summary from an earlier turn, not shown to the user]";
const SUMMARY_LIMIT = 1500;

type Message = {
	role?: unknown;
	content?: unknown;
	reasoning_content?: unknown;
	reasoning?: unknown;
	reasoning_details?: unknown;
	[key: string]: unknown;
};

type Block = {
	type?: unknown;
	thinking?: unknown;
	text?: unknown;
	summary?: unknown;
	[key: string]: unknown;
};

/** Replace replayed account-bound reasoning without mutating the request or its visible/tool content. */
export function rewriteReasoning(
	body: Record<string, unknown>,
	protocol: "anthropic" | "responses" | "chat",
): Record<string, unknown> {
	if (protocol === "anthropic") return rewriteAnthropic(body);
	if (protocol === "responses") return rewriteResponses(body);
	return rewriteChat(body);
}

function summaryText(reasoning: string): string {
	let text = reasoning.trim();
	// Count Unicode code points, not UTF-16 units, so truncation never splits an emoji.
	let end = 0;
	let count = 0;
	for (const point of text) {
		if (count === SUMMARY_LIMIT) break;
		end += point.length;
		count++;
	}
	if (end < text.length) text = `${text.slice(0, end).trimEnd()} …`;
	return `${REASONING_SUMMARY_LABEL}\n${text}`;
}

function rewriteAnthropic(body: Record<string, unknown>): Record<string, unknown> {
	if (!Array.isArray(body.messages)) return body;
	let changed = false;
	let strippedInFlightTools = false;
	const originalMessages: unknown[] = body.messages;
	const messages = originalMessages.map((raw, index) => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
		const message = raw as Message;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return raw;
		const content: unknown[] = [];
		let removed = false;
		let hasToolUse = false;
		for (const rawBlock of message.content as unknown[]) {
			if (rawBlock === null || typeof rawBlock !== "object" || Array.isArray(rawBlock)) {
				content.push(rawBlock);
				continue;
			}
			const block = rawBlock as Block;
			if (block.type === "thinking") {
				removed = true;
				if (typeof block.thinking === "string" && block.thinking.trim()) {
					content.push({ type: "text", text: summaryText(block.thinking) });
				}
			} else if (block.type === "redacted_thinking") {
				removed = true;
			} else {
				if (block.type === "tool_use") hasToolUse = true;
				content.push(rawBlock);
			}
		}
		if (!removed) return raw;
		changed = true;
		if (hasToolUse && index + 2 === originalMessages.length) {
			const next = originalMessages[index + 1];
			if (next !== null && typeof next === "object" && "content" in next && Array.isArray(next.content)) {
				strippedInFlightTools = next.content.some(
					(block: unknown) =>
						block !== null && typeof block === "object" && "type" in block && block.type === "tool_result",
				);
			}
		}
		return { ...message, content };
	});
	if (!changed) return body;
	const output: Record<string, unknown> = { ...body, messages };
	const thinking = body.thinking;
	if (
		strippedInFlightTools &&
		thinking !== null &&
		typeof thinking === "object" &&
		"type" in thinking &&
		thinking.type !== "disabled"
	) {
		output.thinking = { type: "disabled" };
	}
	return output;
}

function rewriteResponses(body: Record<string, unknown>): Record<string, unknown> {
	if (!Array.isArray(body.input)) return body;
	let changed = false;
	const input: unknown[] = [];
	for (const raw of body.input as unknown[]) {
		if (raw === null || typeof raw !== "object" || !("type" in raw) || raw.type !== "reasoning") {
			input.push(raw);
			continue;
		}
		changed = true;
		const item = raw as Block;
		const parts: string[] = [];
		if (Array.isArray(item.summary)) {
			for (const part of item.summary as unknown[]) {
				if (
					part !== null &&
					typeof part === "object" &&
					"text" in part &&
					typeof part.text === "string" &&
					part.text.trim()
				) {
					parts.push(part.text.trim());
				}
			}
		}
		if (parts.length) {
			input.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: summaryText(parts.join("\n\n")) }],
			});
		}
	}
	return changed ? { ...body, input } : body;
}

function rewriteChat(body: Record<string, unknown>): Record<string, unknown> {
	if (!Array.isArray(body.messages)) return body;
	let changed = false;
	const messages = (body.messages as unknown[]).map((raw) => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
		const message = raw as Message;
		if (
			message.role !== "assistant" ||
			!["reasoning_content", "reasoning", "reasoning_details"].some((key) => key in message)
		)
			return raw;
		const parts: string[] = [];
		for (const text of [message.reasoning_content, message.reasoning]) {
			if (typeof text === "string" && text.trim()) parts.push(text.trim());
		}
		if (Array.isArray(message.reasoning_details)) {
			for (const rawDetail of message.reasoning_details as unknown[]) {
				if (rawDetail === null || typeof rawDetail !== "object" || Array.isArray(rawDetail)) continue;
				const detail = rawDetail as Block;
				// Encrypted and unrecognized detail variants must never become readable summaries.
				const text =
					detail.type === "reasoning.summary"
						? detail.summary
						: detail.type === "reasoning.text"
							? detail.text
							: undefined;
				if (typeof text === "string" && text.trim()) parts.push(text.trim());
			}
		}
		const { reasoning_content: _content, reasoning: _reasoning, reasoning_details: _details, ...output } = message;
		if (parts.length) {
			const summary = summaryText(parts.join("\n\n"));
			if (typeof message.content === "string")
				output.content = message.content ? `${summary}\n\n${message.content}` : summary;
			else if (Array.isArray(message.content))
				output.content = [{ type: "text", text: summary }, ...message.content];
			else if (message.content == null) output.content = summary;
		}
		changed = true;
		return output;
	});
	return changed ? { ...body, messages } : body;
}

/** Recognize only HTTP 400 rejections of replayed signatures or encrypted reasoning. */
export function hasReasoningError(status: number, text: string): boolean {
	if (status !== 400) return false;
	const lower = text.toLowerCase();
	return (
		lower.includes("invalid_encrypted_content") ||
		lower.includes("encrypted content") ||
		lower.includes("thinking_signature_invalid") ||
		(lower.includes("signature") && lower.includes("thinking"))
	);
}
