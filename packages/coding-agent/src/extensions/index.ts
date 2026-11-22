import type { InlineExtension } from "../core/extensions/types.ts";
import accountsExtension from "./accounts/index.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import planningExtension from "./planning/index.ts";
import subagentExtension from "./subagent/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

/** First-party model providers used by Credne's CLI and headless SDK. */
export function getBuiltInModelExtensions(agentDir?: string): InlineExtension[] {
	return [
		{ name: "llama.cpp", factory: llamaExtension, builtin: true },
		{ name: "accounts", factory: (pi) => accountsExtension(pi, agentDir), builtin: true },
	];
}

export const builtInExtensions: InlineExtension[] = [
	...getBuiltInModelExtensions(),
	{ name: "planning", factory: planningExtension, builtin: true },
	{ name: "subagent", factory: subagentExtension, replaceable: true, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
