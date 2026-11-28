// Gives a subagent worker its own request layout: its agent prompt as the system prompt, and the
// parent conversation, when it has one, as the first block of its first message.
import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Provider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { buildSystemPromptSections } from "../../core/system-prompt.ts";
import { upstreamIdentity } from "../accounts/catalog.ts";
import { OMP_NATIVE_API } from "../accounts/omp-native.ts";
import type { AccountProviderSpec } from "../accounts/provider.ts";

/** Flag that marks a Pi process as a subagent worker. */
export const WORKER_FLAG = "subagent-worker";

/** Environment variable through which the runner passes the file holding the stripped parent conversation. */
export const WORKER_CONVERSATION_ENV = "PI_SUBAGENT_CONVERSATION";

const ompSystemSchema = Type.Object({ context: Type.Object({ systemPrompt: Type.Array(Type.String()) }) });

/**
 * Registers the worker flag and, in a worker, the request layout.
 *
 * The runner starts the worker with `--system-prompt <agent prompt file>` and `--tools <agent tools>`.
 * Here the sent system prompt is pinned to that agent prompt, the project instruction files and the
 * working directory, in that order. Skills, appended prompt files and extension sections such as the
 * MCP server list stay out, so every worker of one agent type sends the same system prompt.
 */
export function registerWorkerPrompt(pi: ExtensionAPI): void {
	pi.registerFlag(WORKER_FLAG, { description: "Internal isolated subagent worker", type: "boolean", default: false });
	let layout: { prompt: string; claudeBlocks: string[] } | undefined;
	pi.on("before_agent_start", (event) => {
		if (!pi.getFlag(WORKER_FLAG)) return;
		const { customPrompt, contextFiles, cwd } = event.systemPromptOptions;
		const sections = buildSystemPromptSections({ customPrompt, contextFiles, cwd });
		const workspace = [sections.project_context, sections.cwd].filter(Boolean).join("\n\n");
		const prompt = [customPrompt, workspace].filter(Boolean).join("\n\n");
		layout = {
			prompt,
			claudeBlocks: [...(customPrompt ? [customPrompt] : []), `<project-context>\n${workspace}\n</project-context>`],
		};
		return { systemPrompt: prompt };
	});
	pi.on("before_provider_request", ({ payload }, ctx) => {
		if (!layout || ctx.model?.api !== OMP_NATIVE_API) return;
		const provider: (Provider & Pick<AccountProviderSpec, "upstream">) | undefined = ctx.modelRegistry.getProvider(
			ctx.model.provider,
		);
		if (upstreamIdentity(provider?.upstream, ctx.model.id)?.api !== "anthropic-messages") return;
		if (!Value.Check(ompSystemSchema, payload)) return;
		const { systemPrompt } = payload.context;
		if (systemPrompt.length !== 1 || systemPrompt[0] !== layout.prompt) return;
		return { ...payload, context: { ...payload.context, systemPrompt: layout.claudeBlocks } };
	});
	const conversationPath = process.env[WORKER_CONVERSATION_ENV];
	if (!conversationPath) return;
	let conversation: string | undefined;
	pi.on("context", (event) => {
		if (!pi.getFlag(WORKER_FLAG)) return;
		conversation ??= readFileSync(conversationPath, "utf8");
		return { messages: prependConversation(event.messages, conversation) };
	});
}

/**
 * Puts the conversation before the first user message's content as a block of its own. It is
 * added to each request instead of the transcript, so the task stays the recorded message and the
 * parent receives no copy of the conversation in the worker's results.
 */
function prependConversation(messages: AgentMessage[], conversation: string): AgentMessage[] {
	const index = messages.findIndex((message) => message.role === "user");
	const first = messages[index];
	if (first?.role !== "user") return messages;
	const content = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
	const next = [...messages];
	next[index] = { ...first, content: [{ type: "text", text: conversation }, ...content] };
	return next;
}
