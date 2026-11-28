// Cleans a compaction region for the steps that cut it into blocks: removes noise, the agent's calls to compact, and
// failures, except failed shell commands and failed delegations whose workers changed files, and shortens long texts. A file path that a read, search,
// edit or write call names, or that a worker's result lists, is shown relative to the project directory when it lies
// inside it, so every step that reads the cleaned region sees the same short paths.
// Also renders messages as plain text for a model to read: original messages part by part, cleaned messages with each
// run of tool calls condensed into a few lines, whole or as the end that fits a length.
// Also collects the files a worker's run changed: the worker's result carries them, and the cleaned rendering lists them
// after the worker's report.
import { isAbsolute, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	contentText,
	type ImageContent,
	type JsonObject,
	type JsonValue,
	type Message,
	type TextContent,
	type ToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { getCwdRelativePath } from "../../utils/paths.ts";
import type { ProjectedSessionEntry } from "../session-manager.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import { clipText } from "./block-condenser.ts";
import { estimateTokens } from "./compaction.ts";

/** A cleaned session entry, with the size its messages had before cleaning. */
export interface CleanEntry extends ProjectedSessionEntry {
	/** Estimated tokens of the entry's original messages. */
	rawTokens: number;
}

const editedFileSchema = Type.Object({ path: Type.String(), ranges: Type.Array(Type.String()) });

/**
 * A file a worker changed with edit and write calls: its `path`, absolute as {@link collectEditedFiles} stores it (lists
 * stored before may hold a relative one), and its `ranges` as an `[Edited]` line shows them, `first:last` or `first`
 * for the lines an edit changed, `(written)` for a write, none when an edit's lines are unknown.
 */
export type EditedFile = Static<typeof editedFileSchema>;

// The user's rules for long texts. A text of at most `maxShortLines` lines and `maxShortChars` characters is short and
// kept whole. Only outputs that are rendered are shortened: a long shell output keeps its last `maxShellOutputLines`
// non-blank lines, since a command's result (the pass and fail counts of a test run, the errors of a check) sits above
// its last line, and a long custom message keeps its last line. A long input keeps only its first non-blank line, but a
// shell command is kept whole up to `maxCommandChars`, since its later lines (a commit, a test run) matter as much as its
// first, and text sent to a worker up to `maxWorkerTextChars`, since it is what the worker was asked to do. Each line
// kept is clipped to `maxKeptLineChars`. Subagent reports are conclusions already and are kept whole. The values are
// meant to be tuned.
const maxShortLines = 8;
const maxShortChars = 600;
const maxKeptLineChars = 300;
const maxShellOutputLines = 10;
const maxCommandChars = 2_000;
/** The most characters compaction keeps of one text sent to a worker, such as its task. */
export const maxWorkerTextChars = 4_000;
const outputMarker = "<output truncated>";
const inputMarker = "<input truncated>";
const imageMarker = "<image>";

/** The tools that run a shell `command`. */
export const shellTools: ReadonlySet<string> = new Set(["bash", "powershell"]);

/** The tools that explore the workspace: read a file, search it or list it. */
export const exploreTools: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/** The tools that change a file at its `path`. */
export const editTools: ReadonlySet<string> = new Set(["edit", "write"]);

/**
 * Removes from a region what the determination steps do not need: failures other than failed shell commands and failed
 * delegations whose workers changed files, the agent's calls to compact with their results, noise and the bulk of long
 * texts. Shows the file paths of the tool lines
 * relative to the project directory `cwd` when they lie inside it.
 */
export function cleanTranscript(entries: readonly ProjectedSessionEntry[], cwd: string): CleanEntry[] {
	const failed = failedCalls(entries);
	const kept = new Map<string, ToolCall>();
	// An entry whose messages are all removed stays: the slicer still reads an aborted or failed reply from its source
	// entry, and entry ids must stay contiguous.
	return entries.map((entry) => ({
		sourceEntry: entry.sourceEntry,
		messages: entry.messages.flatMap((message) => cleanMessage(message, failed, kept, cwd)),
		rawTokens: entry.messages.reduce((sum, message) => sum + estimateTokens(message), 0),
	}));
}

// The paragraphs of a rendered transcript are separated by a blank line.
const paragraphBreak = "\n\n";

/** Renders messages as plain text for a model to read, one labelled paragraph per part. */
export function renderTranscript(messages: readonly AgentMessage[]): string {
	return messages.flatMap(renderMessage).join(paragraphBreak);
}

/**
 * Renders cleaned messages as plain text for a model to read, with each run of tool calls (the assistant messages and
 * tool results between two user or custom messages) condensed into group lines. Of the tool outputs, only shell outputs
 * and the reports of delegations that waited are shown. A worker's report, in such a result or in a result message, is
 * followed by the files its result lists as changed.
 */
export function renderCleaned(messages: readonly AgentMessage[]): string {
	return cleanedParagraphs(messages).join(paragraphBreak);
}

/** The line above the end of a transcript cut to fit, as {@link renderCleanedEnd} renders it. */
export const truncatedMarker = "<block truncated>";

/**
 * Renders the end of cleaned messages as {@link renderCleaned} renders them, in at most `maxChars` characters: as many
 * of the final paragraphs as fit, each whole, so the text starts at a message or a tool line, never inside one. Empty
 * when not even the last paragraph fits.
 */
export function renderCleanedEnd(messages: readonly AgentMessage[], maxChars: number): string {
	const paragraphs = cleanedParagraphs(messages);
	let start = paragraphs.length;
	let chars = 0;
	while (start > 0) {
		const added = paragraphs[start - 1].length + (start < paragraphs.length ? paragraphBreak.length : 0);
		if (chars + added > maxChars) break;
		chars += added;
		start--;
	}
	return paragraphs.slice(start).join(paragraphBreak);
}

/**
 * The files a worker's run changed: those of its successful edit and write calls, each with its ranges as an `[Edited]`
 * line shows them and a relative path resolved against the worker's working directory `cwd`, and those the results of
 * its own delegating calls list, as they list them.
 */
export function collectEditedFiles(messages: readonly Message[], cwd: string): EditedFile[] {
	const results = new Map<string, ToolResultMessage>();
	for (const message of messages) {
		if (message.role === "toolResult") results.set(message.toolCallId, message);
	}
	const edited = new Map<string, string[]>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const result = results.get(part.id);
			if (editTools.has(part.name)) {
				// The main session reads the list from its own directory, which may differ from the worker's, so a relative
				// path is resolved here, as the tools resolved it.
				const path = stringArg(part.arguments, "path") ?? "";
				if (result && !result.isError)
					addEdit(edited, isAbsolute(path) ? path : resolveToCwd(path, cwd), part, result);
			} else if (delegationTools.has(part.name)) {
				// A failed delegation, such as one whose worker was aborted, still lists what its worker changed. Its workers
				// stored their paths absolute by the same rule, so they are kept as listed.
				addListedFiles(edited, workerResults(result?.details).listed);
			}
		}
	}
	return [...edited].map(([path, ranges]) => ({ path, ranges }));
}

/** One paragraph per rendered message part or tool line, as {@link renderCleaned} describes them. */
function cleanedParagraphs(messages: readonly AgentMessage[]): string[] {
	const results = new Map<string, ToolResultMessage>();
	const paragraphs: string[] = [];
	let run: AssistantMessage[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			run.push(message);
		} else if (message.role === "toolResult") {
			results.set(message.toolCallId, message);
		} else {
			paragraphs.push(...renderRun(run, results), ...renderMessage(message), ...resultMessageEdits(message));
			run = [];
		}
	}
	paragraphs.push(...renderRun(run, results));
	return paragraphs;
}

/** Whether the call delegated work and waited for the response, which then arrived as its result. */
export function isForegroundDelegation(call: ToolCall | undefined): boolean {
	// subagent waits unless sent to the background; assign_tasks and assign_task return at once unless told to wait.
	if (call?.name === "subagent") return call.arguments.background !== true;
	return (call?.name === "assign_tasks" || call?.name === "assign_task") && call.arguments.background === false;
}

/** The argument at `key` when it is a string. */
export function stringArg(args: JsonObject, key: string): string | undefined {
	const value = args[key];
	// Tool arguments are produced by a model, so each field is checked before it is used.
	return typeof value === "string" ? value : undefined;
}

/** The ids of the calls whose result is an error, except delegations whose workers changed files. */
function failedCalls(entries: readonly ProjectedSessionEntry[]): Set<string> {
	const failed = new Set<string>();
	for (const entry of entries) {
		for (const message of entry.messages) {
			if (message.role !== "toolResult" || !message.isError) continue;
			// What a failed or aborted worker changed stays on disk, so its call stays with its report and its files.
			const listed = delegationTools.has(message.toolName) ? workerResults(message.details).listed : [];
			if (!listed.some((result) => result.editedFiles.length > 0)) failed.add(message.toolCallId);
		}
	}
	return failed;
}

// Custom messages that deliver a worker's report: subagent-result (subagent extension), planning-result (planning
// extension) and agent-message (a worker's message to main, subagent/team.ts).
const reportMessages: ReadonlySet<string> = new Set(["subagent-result", "planning-result", "agent-message"]);

/**
 * The message cleaned, or nothing, with its file paths shown relative to the project directory `cwd`. Adds the calls it
 * keeps to `kept` by id, so their results stay too.
 */
function cleanMessage(
	message: AgentMessage,
	failed: ReadonlySet<string>,
	kept: Map<string, ToolCall>,
	cwd: string,
): AgentMessage[] {
	switch (message.role) {
		case "user":
			return cleanUser(message);
		case "assistant":
			return cleanAssistant(message, failed, kept, cwd);
		case "toolResult": {
			// A failed call other than a shell command, and a call to compact, are never kept, so this also drops their results.
			const call = kept.get(message.toolCallId);
			return call ? [cleanResult(message, call, cwd)] : [];
		}
		case "custom": {
			if (!message.display) return [];
			const text = contentText(message.content);
			const content = reportMessages.has(message.customType) ? withoutUsage(text) : shortenOutput(text, 1);
			if (!resultMessages.has(message.customType)) return [{ ...message, content }];
			return [{ ...message, content, details: projectResultMessageDetails(message.details, cwd) }];
		}
		case "bashExecution":
		case "branchSummary":
		case "compactionSummary":
		case "system":
			return [];
	}
}

function cleanUser(message: UserMessage): AgentMessage[] {
	if (typeof message.content === "string") return isBlank(message.content) ? [] : [message];
	const texts = message.content.filter((part) => part.type === "text");
	if (!isBlank(contentText(texts))) return [{ ...message, content: texts }];
	return message.content.some((part) => part.type === "image") ? [{ ...message, content: imageMarker }] : [];
}

function isBlank(text: string): boolean {
	return text.trim() === "";
}

// The compact extension's tool, whose calls request a compaction. Their instructions reach the compaction's agents in
// their system prompts, not as part of the conversation.
const compactTool = "compact";

function cleanAssistant(
	message: AssistantMessage,
	failed: ReadonlySet<string>,
	kept: Map<string, ToolCall>,
	cwd: string,
): AgentMessage[] {
	if (message.stopReason === "error" || message.stopReason === "aborted") return [];
	const content: (TextContent | ToolCall)[] = [];
	// A failed shell command stays with its output: a check that failed before one that passed is part of the work.
	for (const part of message.content) {
		if (part.type === "text" && !isBlank(part.text)) {
			content.push(part);
		} else if (
			part.type === "toolCall" &&
			part.argumentsError === undefined &&
			part.name !== compactTool &&
			(shellTools.has(part.name) || !failed.has(part.id))
		) {
			kept.set(part.id, part);
			content.push({ ...part, arguments: cleanArguments(part, cwd) });
		}
	}
	return content.length > 0 ? [{ ...message, content }] : [];
}

/**
 * The call's arguments with the path of a read, search, edit or write as {@link projectPath} shows it, a shell command
 * kept up to `maxCommandChars`, text sent to a worker up to `maxWorkerTextChars`, and every other long string shortened,
 * except those of an edit or a write.
 */
function cleanArguments(call: ToolCall, cwd: string): JsonObject {
	// Only the path of an edit or a write is rendered, so its texts are left as they are.
	if (editTools.has(call.name)) return withProjectPath(call.arguments, cwd);
	if (exploreTools.has(call.name)) return shortenArguments(withProjectPath(call.arguments, cwd));
	if (call.name === "subagent") return cleanSubagentArguments(call.arguments);
	const args = shortenArguments(call.arguments);
	const kept = keptArgument(call.name);
	const text = kept && stringArg(call.arguments, kept.key);
	return kept && text !== undefined ? { ...args, [kept.key]: clipInput(text, kept.maxChars) } : args;
}

/** The arguments with their `path`, when it is a string, as {@link projectPath} shows it. */
function withProjectPath(args: JsonObject, cwd: string): JsonObject {
	const path = stringArg(args, "path");
	return path === undefined ? args : { ...args, path: projectPath(path, cwd) };
}

/**
 * The path relative to the project directory `cwd`, with forward slashes, when it lies inside it (`.` for the directory
 * itself); otherwise as written. A relative path is resolved against `cwd`, as the tools resolve it.
 */
function projectPath(path: string, cwd: string): string {
	// Node's path functions compare whole segments as the platform does, on Windows with either separator and in any
	// case, so a sibling that only starts with the directory's name, such as `<cwd>-old`, is outside it.
	return getCwdRelativePath(path, cwd)?.replaceAll(sep, "/") ?? path;
}

// The tools that send a worker text, with the argument that holds it: send_agent_message, steer_agent and continue_agent
// (subagent/team.ts).
const workerMessageArgs: ReadonlyMap<string, string> = new Map([
	["send_agent_message", "message"],
	["steer_agent", "prompt"],
	["continue_agent", "prompt"],
]);

/** The argument of a call that is kept longer than the input rule allows, with its limit, if the call has one. */
function keptArgument(name: string): { key: string; maxChars: number } | undefined {
	if (shellTools.has(name)) return { key: "command", maxChars: maxCommandChars };
	const key = workerMessageArgs.get(name);
	return key === undefined ? undefined : { key, maxChars: maxWorkerTextChars };
}

/**
 * A subagent call's arguments with its task, at the top level and in each item of `tasks` and `chain`, kept up to
 * `maxWorkerTextChars`, and every other long string shortened.
 */
function cleanSubagentArguments(args: JsonObject): JsonObject {
	// Tool arguments are produced by a model, so each field is checked before it is used.
	return Object.fromEntries(
		Object.entries(args).map(([key, value]): [string, JsonValue] => {
			if (key === "task" && typeof value === "string") return [key, clipInput(value, maxWorkerTextChars)];
			if ((key === "tasks" || key === "chain") && isJsonArray(value)) {
				return [key, value.map((item) => (isJsonObject(item) ? cleanSubagentArguments(item) : shortenValue(item)))];
			}
			return [key, shortenValue(value)];
		}),
	);
}

/** The text whole up to `maxChars` characters, beyond that clipped and followed by the input marker. */
function clipInput(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${clipText(text, maxChars)}\n${inputMarker}`;
}

/** The arguments with every long string, at any depth, shortened by the input rule. */
function shortenArguments(args: JsonObject): JsonObject {
	return Object.fromEntries(
		Object.entries(args).map(([key, value]): [string, JsonValue] => [key, shortenValue(value)]),
	);
}

function shortenValue(value: JsonValue): JsonValue {
	if (typeof value === "string") return shortenInput(value);
	if (value === null || typeof value !== "object") return value;
	return isJsonArray(value) ? value.map(shortenValue) : shortenArguments(value);
}

// A type guard because Array.isArray does not narrow a readonly array out of a union.
function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
	return Array.isArray(value);
}

/** A long input as its first non-blank line followed by the marker; a short one whole. */
function shortenInput(text: string): string {
	const lines = longTextLines(text);
	if (!lines) return text;
	const first = lines.find((line) => !isBlank(line));
	return first === undefined ? inputMarker : `${clipText(first, maxKeptLineChars)}\n${inputMarker}`;
}

/** The lines of a long text, or undefined for a short one. */
function longTextLines(text: string): string[] | undefined {
	const lines = text.split(/\r?\n/);
	return text.length > maxShortChars || lines.length > maxShortLines ? lines : undefined;
}

// The listing of revealed tools that the harness adds as a content part of its own to the result that revealed them:
// revealTools in subagent/team.ts builds it, under a heading the subagent extension passes for the first delegating call
// and the planning extension for enter_plan_mode.
const toolListingPattern = /^Here are the relevant tools for \w+:(\n- [^\n]*)+$/;

/**
 * The result with what is rendered cleaned: a delegation's report whole without the tool listing and its usage, with
 * the files its worker results list as {@link projectPath} shows them; a shell output by the shell rule. Every other
 * result stays as it is, since its text is never rendered.
 */
function cleanResult(message: ToolResultMessage, call: ToolCall, cwd: string): ToolResultMessage {
	if (isForegroundDelegation(call)) {
		const parts = message.content.filter((part) => part.type !== "text" || !toolListingPattern.test(part.text));
		const text = withoutUsage(contentText(parts));
		return { ...message, content: [{ type: "text", text }], details: projectDelegationDetails(message.details, cwd) };
	}
	if (!shellTools.has(call.name)) return message;
	const text = shortenOutput(contentText(message.content), maxShellOutputLines);
	return { ...message, content: [{ type: "text", text }] };
}

// The usage the harness adds to a worker's report, mirroring its producers: the subagent extension ends a
// subagent-result message with "\n\nUsage: <stats>" (notifyResult), and the planning extension ends a planning-result
// message with "\nUsage: <json>" and gives each result of an assign_tasks call that waited a "usage" field holding a
// flat object.
const usageFooterPattern = /\n+Usage: [^\n]*$/;
const usageFieldPattern = /,"usage":\{[^{}]*\}/g;

/** The report without the usage the harness added to it. */
function withoutUsage(report: string): string {
	return report.replace(usageFooterPattern, "").replace(usageFieldPattern, "");
}

/** A long output as the marker followed by its last `keptLines` non-blank lines; a short one whole. */
function shortenOutput(text: string, keptLines: number): string {
	const lines = longTextLines(text);
	if (!lines) return text;
	const last = lines.filter((line) => !isBlank(line)).slice(-keptLines);
	return [outputMarker, ...last.map((line) => clipText(line, maxKeptLineChars))].join("\n");
}

/** One paragraph per part of the message. */
function renderMessage(message: AgentMessage): string[] {
	switch (message.role) {
		case "user":
			return textsOf(message.content).map((text) => `[User]: ${text}`);
		case "assistant":
			return message.content.flatMap((part) => {
				if (part.type === "text") return [`[Assistant]: ${part.text}`];
				return part.type === "toolCall" ? [`[Tool call]: ${part.name} ${JSON.stringify(part.arguments)}`] : [];
			});
		case "toolResult":
			return textsOf(message.content).map((text) => `[Tool result: ${message.toolName}]: ${text}`);
		case "custom": {
			const label = resultMessages.has(message.customType) ? "Subagent response" : "Message";
			return textsOf(message.content).map((text) => `[${label}]: ${text}`);
		}
		default:
			// The cleaner removes messages of the other roles.
			return [];
	}
}

// Custom messages that deliver a worker's result: subagent-result (subagent extension) and planning-result (planning
// extension). Both hold the result as `result` in their details.
const resultMessages: ReadonlySet<string> = new Set(["subagent-result", "planning-result"]);

/** The `[Subagent edited]` line that follows a worker's result message, when its result lists changed files. */
function resultMessageEdits(message: AgentMessage): string[] {
	return message.role === "custom" && resultMessages.has(message.customType) ? subagentEdited(message.details) : [];
}

function textsOf(content: string | readonly (TextContent | ImageContent)[]): string[] {
	return typeof content === "string"
		? [content]
		: content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}

/** A run of tool calls: the assistant's text before its last call, its calls in group lines, then the text after it. */
function renderRun(run: readonly AssistantMessage[], results: ReadonlyMap<string, ToolResultMessage>): string[] {
	const parts = run.flatMap((message) => message.content);
	// Text that stood between calls moves to the front, so that the calls condense into one place.
	const end = parts.findLastIndex((part) => part.type === "toolCall") + 1;
	const calls = parts.filter((part) => part.type === "toolCall");
	return [...assistantTexts(parts.slice(0, end)), ...renderCalls(calls, results), ...assistantTexts(parts.slice(end))];
}

function assistantTexts(parts: AssistantMessage["content"]): string[] {
	return parts.flatMap((part) => (part.type === "text" ? [`[Assistant]: ${part.text}`] : []));
}

// The tools that delegate work to workers: subagent (subagent extension), assign_tasks and assign_task (planning
// extension).
const delegationTools: ReadonlySet<string> = new Set(["subagent", "assign_tasks", "assign_task"]);

/**
 * The calls in groups, in this order whatever order they were made in: reads and searches, edits, each shell command
 * with its output, each delegation with the report it waited for and the files its workers changed, then every other
 * call with its arguments.
 */
function renderCalls(calls: readonly ToolCall[], results: ReadonlyMap<string, ToolResultMessage>): string[] {
	const read = new Map<string, string[]>();
	const edited = new Map<string, string[]>();
	const ran: string[] = [];
	const delegated: string[] = [];
	const called: string[] = [];
	for (const call of calls) {
		const result = results.get(call.id);
		if (call.name === "read") addItem(read, stringArg(call.arguments, "path") ?? "", readRange(call.arguments));
		else if (exploreTools.has(call.name)) addItem(read, searchItem(call), undefined);
		else if (editTools.has(call.name)) addEdit(edited, stringArg(call.arguments, "path") ?? "", call, result);
		else if (shellTools.has(call.name)) ran.push(ranParagraph(call, result));
		else if (delegationTools.has(call.name)) delegated.push(...delegatedParagraphs(call, result));
		else called.push(`${call.name} ${JSON.stringify(call.arguments)}`);
	}
	return [
		...groupLine("Read", read),
		...groupLine("Edited", edited),
		...ran,
		...delegated,
		...(called.length > 0 ? [`[Called]: ${called.join("; ")}`] : []),
	];
}

/**
 * Adds the file of an edit or write call to a group under `path`, with the lines the edit changed or the mark of a
 * write.
 */
function addEdit(
	edited: Map<string, string[]>,
	path: string,
	call: ToolCall,
	result: ToolResultMessage | undefined,
): void {
	addItem(edited, path, call.name === "write" ? "(written)" : editRange(result));
}

/** Adds the files the worker results list to a group, each once with each of its ranges that is new to it. */
function addListedFiles(edited: Map<string, string[]>, results: readonly ListedResult[]): void {
	for (const result of results) {
		for (const file of result.editedFiles) {
			addItem(edited, file.path, undefined);
			for (const range of file.ranges) addItem(edited, file.path, range);
		}
	}
}

/** Adds an item to a group once, with the range when it is known and new to the item. */
function addItem(items: Map<string, string[]>, key: string, range: string | undefined): void {
	const ranges = items.get(key) ?? [];
	if (range !== undefined && !ranges.includes(range)) ranges.push(range);
	items.set(key, ranges);
}

// The range of a read without an offset or a limit. It covers every other range, so the file is shown alone.
const wholeFile = "";

/** The lines a read asked for: `first:last` from its offset and limit, `first:` from an offset alone. */
function readRange(args: JsonObject): string {
	const offset = numberArg(args, "offset");
	const limit = numberArg(args, "limit");
	if (limit === undefined) return offset === undefined ? wholeFile : `${offset}:`;
	const first = offset ?? 1;
	return `${first}:${first + limit - 1}`;
}

function numberArg(args: JsonObject, key: string): number | undefined {
	const value = args[key];
	// Tool arguments are produced by a model, so each field is checked before it is used.
	return typeof value === "number" ? value : undefined;
}

/** A search or a listing as its tool, pattern and path, such as `grep "compact" in src/` or `ls src/`. */
function searchItem(call: ToolCall): string {
	const path = stringArg(call.arguments, "path");
	if (call.name === "ls") return path === undefined ? "ls" : `ls ${path}`;
	const search = `${call.name} "${stringArg(call.arguments, "pattern") ?? ""}"`;
	return path === undefined ? search : `${search} in ${path}`;
}

// A line the edit added, in the diff of EditToolDetails: "+", the line's number in the new file padded with spaces,
// then its text.
const addedLinePattern = /^\+ *(\d+) /gm;

/**
 * The lines an edit changed, from its result's details: `first:last` when the diff shows added lines, `first` when it
 * only removed lines, unknown without details.
 */
function editRange(result: ToolResultMessage | undefined): string | undefined {
	const details = result?.details;
	// Tool result details are persisted data, so each field is checked before it is used.
	if (!isJsonObject(details)) return undefined;
	const first = details.firstChangedLine;
	if (typeof first !== "number") return undefined;
	const diff = details.diff;
	const last = typeof diff === "string" ? [...diff.matchAll(addedLinePattern)].at(-1) : undefined;
	return last === undefined ? String(first) : `${first}:${last[1]}`;
}

/** Whether the value is a JSON object, not null or an array. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && typeof value === "object" && !isJsonArray(value);
}

/** A shell call as its command, marked when it failed, then on the next lines its cleaned output if it printed any. */
function ranParagraph(call: ToolCall, result: ToolResultMessage | undefined): string {
	const label = result?.isError ? "Ran, failed" : "Ran";
	const command = `[${label}]: ${stringArg(call.arguments, "command") ?? ""}`;
	const output = result ? contentText(result.content) : "";
	return isBlank(output) ? command : `${command}\n${output}`;
}

/**
 * A delegating call as its agents and tasks, followed by the report and the files its workers changed when it waited
 * for them.
 */
function delegatedParagraphs(call: ToolCall, result: ToolResultMessage | undefined): string[] {
	const line = `[Delegated]: ${delegatedTasks(call).join("; ")}`;
	if (!result || !isForegroundDelegation(call)) return [line];
	const report = textsOf(result.content).map((text) => `[Subagent response]: ${text}`);
	return [line, ...report, ...subagentEdited(result.details)];
}

/**
 * The `[Subagent edited]` lines for the files the worker results in the details list: one line, or, when the details
 * hold several workers, one per worker that changed files, starting with its id as the report names it. None when they
 * list no file.
 */
function subagentEdited(details: unknown): string[] {
	const { count, listed } = workerResults(details);
	if (count <= 1) return groupLine("Subagent edited", listedFiles(listed));
	// The reader can then tell which worker of the call changed which file.
	return listed.flatMap((result) =>
		groupLine("Subagent edited", listedFiles([result]), `Worker ${result.workerId}: `),
	);
}

/** The files the worker results list as a group, each once with its ranges. */
function listedFiles(results: readonly ListedResult[]): Map<string, string[]> {
	const edited = new Map<string, string[]>();
	addListedFiles(edited, results);
	return edited;
}

// A worker's result once it lists the files its run changed (runner.ts in the subagent extension sets the list), as the
// details of a delegating call hold it in `results` and those of a worker's result message in `result`.
const listedResultSchema = Type.Object({ workerId: Type.String(), editedFiles: Type.Array(editedFileSchema) });
const delegationDetailsSchema = Type.Object({ results: Type.Array(Type.Unknown()) });
const resultMessageDetailsSchema = Type.Object({ result: listedResultSchema });

/** A worker's result that lists the files its run changed. */
type ListedResult = Static<typeof listedResultSchema>;

/**
 * The worker results that a delegating call's details hold in `results`, or a worker result message's details in
 * `result`: how many there are, and those of them that list the files they changed.
 */
function workerResults(details: unknown): { count: number; listed: ListedResult[] } {
	// Details are persisted data, and results stored before the lists existed have none, so each one is checked.
	if (Value.Check(resultMessageDetailsSchema, details)) return { count: 1, listed: [details.result] };
	if (!Value.Check(delegationDetailsSchema, details)) return { count: 0, listed: [] };
	const listed = details.results.filter((result): result is ListedResult => Value.Check(listedResultSchema, result));
	return { count: details.results.length, listed };
}

/**
 * A delegating call's details with the files that its worker results list as {@link projectPath} shows them. A copy:
 * the stored details keep their paths.
 */
function projectDelegationDetails(details: JsonValue | undefined, cwd: string): JsonValue | undefined {
	// Details are persisted data, and results stored before the lists existed have none, so each one is checked.
	if (!isJsonObject(details) || !isJsonArray(details.results)) return details;
	const results = details.results.map((result) =>
		Value.Check(listedResultSchema, result) ? projectListedResult(result, cwd) : result,
	);
	return { ...details, results };
}

/**
 * A worker result message's details with the files its result lists as {@link projectPath} shows them. A copy: the
 * stored details keep their paths.
 */
function projectResultMessageDetails(details: unknown, cwd: string): unknown {
	// Details are persisted data, and results stored before the lists existed have none, so they are checked.
	if (!Value.Check(resultMessageDetailsSchema, details)) return details;
	return { ...details, result: projectListedResult(details.result, cwd) };
}

function projectListedResult(result: ListedResult, cwd: string): ListedResult {
	const editedFiles = result.editedFiles.map((file) => ({ ...file, path: projectPath(file.path, cwd) }));
	return { ...result, editedFiles };
}

/** Each task of a delegating call as `agent: task`; for the assign tools, the worker and the task id. */
function delegatedTasks(call: ToolCall): string[] {
	const args = call.arguments;
	if (call.name === "assign_tasks") {
		return arrayArg(args, "taskIds").flatMap((id) => (typeof id === "string" ? [`worker: task ${id}`] : []));
	}
	if (call.name === "assign_task") {
		return [`${stringArg(args, "workerId") ?? "worker"}: task ${stringArg(args, "taskId") ?? ""}`];
	}
	// A single subagent call names its agent and task at the top level, a parallel or chain call in its items.
	const items = [...arrayArg(args, "tasks"), ...arrayArg(args, "chain")].filter(isJsonObject);
	return (items.length > 0 ? items : [args]).map(
		(item) => `${stringArg(item, "agent") ?? ""}: ${stringArg(item, "task") ?? ""}`,
	);
}

/** The argument at `key` when it is an array, otherwise an empty one. */
export function arrayArg(args: JsonObject, key: string): readonly JsonValue[] {
	const value = args[key];
	// Tool arguments are produced by a model, so each field is checked before it is used.
	return isJsonArray(value) ? value : [];
}

/**
 * A group line of files or searches after the prefix, each once with its ranges joined by commas, the items joined by
 * semicolons. None for an empty group.
 */
function groupLine(label: string, items: ReadonlyMap<string, readonly string[]>, prefix = ""): string[] {
	if (items.size === 0) return [];
	const rendered = [...items].map(([key, ranges]) =>
		ranges.length === 0 || ranges.includes(wholeFile) ? key : `${key} ${ranges.join(", ")}`,
	);
	return [`[${label}]: ${prefix}${rendered.join("; ")}`];
}
