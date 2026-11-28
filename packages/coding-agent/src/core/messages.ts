/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/** Transcript label for messages omitted from model context. */
export const HIDDEN_CONTEXT_LABEL = "(hidden to the agent)";

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	/** Estimated context tokens right after the compaction; absent for compactions stored without it. */
	tokensAfter?: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	tokensAfter?: number,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		...(tokensAfter !== undefined ? { tokensAfter } : {}),
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Exclude failed provider attempts while preserving tool and command diagnostics. */
export function filterFailedMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.flatMap(createFailureFilter(messages));
}

/** Pair omitted provider attempts with their tool results across the complete context. */
export function createFailureFilter(messages: AgentMessage[]): (message: AgentMessage) => AgentMessage[] {
	const omittedCalls = new Set<string>();
	for (const message of messages) {
		// Worker result details are extension metadata, so validate this boundary before classifying the failure.
		if (message.role === "toolResult" && message.toolName === "subagent") {
			if (isProviderFailureReport(message.details)) omittedCalls.add(message.toolCallId);
		}
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			for (const part of message.content) {
				if (part.type === "toolCall") omittedCalls.add(part.id);
			}
		}
	}
	return (message): AgentMessage[] => {
		if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") return [];
			const content = message.content.filter((part) => part.type !== "toolCall" || !omittedCalls.has(part.id));
			if (content.length === message.content.length) return [message];
			return content.some((part) => part.type !== "thinking") ? [{ ...message, content }] : [];
		}
		if (message.role === "toolResult" && omittedCalls.has(message.toolCallId)) return [];
		if (
			message.role === "custom" &&
			(message.customType === "subagent-result" || message.customType === "planning-result")
		) {
			if (isProviderFailureReport(message.details)) return [];
		}
		return [message];
	};
}

/** Identify worker reports containing only failed provider attempts. */
export function isProviderFailureReport(details: unknown): boolean {
	// Worker details are untyped extension metadata, including reports loaded from saved sessions.
	if (!details || typeof details !== "object") return false;
	if ("result" in details) return isFailedProviderResult(details.result);
	return (
		"results" in details &&
		Array.isArray(details.results) &&
		details.results.length > 0 &&
		details.results.every(isFailedProviderResult)
	);
}

function isFailedProviderResult(result: unknown): boolean {
	// Worker reports arrive as untyped extension metadata, including reports loaded from saved sessions.
	return (
		result !== null &&
		typeof result === "object" &&
		"status" in result &&
		result.status === "failed" &&
		"stopReason" in result &&
		result.stopReason === "error"
	);
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return filterFailedMessages(messages)
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "system":
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
