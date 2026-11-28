import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { type Component, Container, TuiMainScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionMainView, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import * as editDiff from "../src/core/tools/edit-diff.ts";
import { createAllToolRenderers } from "../src/core/tools/renderers/index.ts";
import subagentExtension from "../src/extensions/subagent/index.ts";
import { emptyUsage, type SingleResult } from "../src/extensions/subagent/runner.ts";
import { findWorkerTeam, type WorkerView } from "../src/extensions/subagent/team.ts";
import { showWorkerView, type WorkerViewTeam } from "../src/extensions/subagent/worker-view.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

import { createHarness } from "./suite/harness.ts";

const opened: Array<{ dispose?(): void }> = [];

beforeAll(() => initTheme("dark"));

beforeEach(() => {
	vi.spyOn(SettingsManager, "create").mockReturnValue(SettingsManager.inMemory());
});

afterEach(() => {
	for (const component of opened) component.dispose?.();
	opened.length = 0;
	vi.restoreAllMocks();
});

function setup(status: WorkerView["status"], runs: SingleResult[] = []) {
	const worker: WorkerView = {
		id: "worker-1",
		cwd: process.cwd(),
		color: "syntaxString",
		name: "explorer",
		task: "Locate renderer",
		status,
		agentType: "explorer",
		inboxCount: 0,
		assignmentCount: 0,
		usage: emptyUsage(),
		elapsedMs: 0,
		runs,
	};
	const views = [worker];
	const listeners = new Set<() => void>();
	const unsubscribe = vi.fn();
	const team: WorkerViewTeam = {
		getViews: () => views,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				unsubscribe();
			};
		},
		sendUserMessage: vi.fn(async () => "delivered"),
		continue: vi.fn(async () => "queued"),
	};
	let view: ExtensionMainView | undefined;
	const notify = vi.fn();
	const ui = {
		setMainView: (next: ExtensionMainView | undefined) => {
			view = next;
		},
		notify,
	} as unknown as ExtensionUIContext;
	showWorkerView(ui, team, worker.id);
	if (!view) throw new Error("showWorkerView did not set a main view");
	const tui = new TuiMainScreen(new VirtualTerminal());
	const component = view.component(tui, theme);
	opened.push(component);
	return {
		view,
		team,
		notify,
		worker,
		component,
		tui,
		views,
		unsubscribe,
		update: () => {
			for (const listener of listeners) listener();
		},
	};
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-6.1-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

function run(messages: Message[], status: SingleResult["status"] = "completed"): SingleResult {
	return {
		agent: "explorer",
		agentSource: "builtin",
		task: "Locate renderer",
		status,
		exitCode: status === "running" ? null : 0,
		messages,
		stderr: "",
		usage: emptyUsage(),
	};
}

function click(component: Component, text: string): void {
	const lines = component.render(100);
	const row = lines.findIndex((line) => stripVTControlCharacters(line).includes(text));
	expect(row).toBeGreaterThanOrEqual(0);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y: row,
		screenX: 2,
		screenY: row,
		width: 100,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	expect(component.handleMouse?.(event)?.handled).toBe(true);
}

function expectChat(component: Component, expected: Container): void {
	const lines = expected.render(100);
	expect(component.render(100).slice(-lines.length)).toEqual(lines);
}

describe("worker main view", () => {
	it("keeps a compact worker identity and direct-message hint", () => {
		const { view, component } = setup("completed");
		expect(view.label).toBe("explorer");
		expect(view.color).toBe("syntaxString");
		const lines = component.render(100);
		expect(lines[0]).toContain(theme.fg("syntaxString", theme.bold("explorer")));
		expect(stripVTControlCharacters(lines[0])).toMatch(/^◯ explorer\s+idle • explorer/);
		expect(stripVTControlCharacters(lines[1])).toContain("Message this worker directly");
		expect(lines.map(stripVTControlCharacters).join("\n")).toContain("No worker messages yet.");
	});

	it("renders user and assistant content identically to the main chat components", () => {
		const user = { role: "user", content: "Find **the renderer**", timestamp: 1 } satisfies Message;
		const response = assistant([
			{ type: "thinking", thinking: "Check the components." },
			{ type: "text", text: "## Found\n```ts\nconst ready = true;\n```" },
		]);
		const userRender = vi.spyOn(UserMessageComponent.prototype, "render");
		const assistantRender = vi.spyOn(AssistantMessageComponent.prototype, "render");
		const { component } = setup("completed", [run([user, response])]);
		component.render(100);
		expect(userRender).toHaveBeenCalled();
		expect(assistantRender).toHaveBeenCalled();
		const expected = new Container();
		expected.addChild(new UserMessageComponent(user.content));
		expected.addChild(new AssistantMessageComponent(response));
		expectChat(component, expected);
		expect(component.render(100).map(stripVTControlCharacters).join("\n")).not.toMatch(/── Run|^User$|^Assistant$/m);
	});

	it("uses the built-in code tool renderer and forwards clicks to expand its result", () => {
		const task = { role: "user", content: "Locate renderer", timestamp: 1 } satisfies Message;
		const response = assistant(
			[{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "renderer.ts", offset: 1, limit: 5 } }],
			"toolUse",
		);
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "export const ready = true;" }],
			isError: false,
			timestamp: 2,
		};
		const toolRender = vi.spyOn(ToolExecutionComponent.prototype, "render");
		const { component, tui } = setup("completed", [run([task, response, result])]);
		const expected = new Container();
		expected.addChild(new UserMessageComponent(task.content));
		expected.addChild(new AssistantMessageComponent(response));
		const tool = new ToolExecutionComponent(
			"read",
			"read-1",
			{ path: "renderer.ts", offset: 1, limit: 5 },
			{},
			createAllToolRenderers().read,
			tui,
			process.cwd(),
		);
		tool.updateResult(result);
		expected.addChild(tool);
		expectChat(component, expected);
		expect(toolRender).toHaveBeenCalled();
		expect(component.render(100).join("\n")).not.toContain("export const ready");
		click(component, "renderer.ts");
		tool.setExpanded(true);
		expectChat(component, expected);
		expect(stripVTControlCharacters(component.render(100).join("\n"))).toContain("export const ready = true;");
	});

	it("renders complete historical edit calls without recomputing their saved diff", () => {
		const compute = vi.spyOn(editDiff, "computeEditsDiff");
		const complete = vi.spyOn(ToolExecutionComponent.prototype, "setArgsComplete");
		const started = vi.spyOn(ToolExecutionComponent.prototype, "markExecutionStarted");
		const response = assistant(
			[
				{
					type: "toolCall",
					id: "edit-1",
					name: "edit",
					arguments: { path: "renderer.ts", edits: [{ oldText: "false", newText: "true" }] },
				},
			],
			"toolUse",
		);
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "edit-1",
			toolName: "edit",
			content: [{ type: "text", text: "Edited renderer.ts" }],
			details: { diff: "-1 const ready = false;\n+1 const ready = true;", firstChangedLine: 1 },
			isError: false,
			timestamp: 2,
		};
		const { component, tui } = setup("completed", [run([response, result])]);
		const expected = new Container();
		expected.addChild(new UserMessageComponent("Locate renderer"));
		expected.addChild(new AssistantMessageComponent(response));
		const tool = new ToolExecutionComponent(
			"edit",
			"edit-1",
			{ path: "renderer.ts", edits: [{ oldText: "false", newText: "true" }] },
			{},
			createAllToolRenderers().edit,
			tui,
			process.cwd(),
		);
		tool.updateResult(result);
		expected.addChild(tool);
		expectChat(component, expected);
		expect(complete).toHaveBeenCalledOnce();
		expect(started).toHaveBeenCalledOnce();
		expect(compute).not.toHaveBeenCalled();
	});

	it("loads the worker's saved presentation settings and preserves clicked thinking state across updates", () => {
		vi.mocked(SettingsManager.create).mockReturnValueOnce(
			SettingsManager.inMemory({ hideThinkingBlock: true, outputPad: 0, markdown: { codeBlockIndent: "    " } }),
		);
		const response = assistant([
			{ type: "thinking", thinking: "Private reasoning" },
			{ type: "text", text: "```ts\nconst done = true;\n```" },
		]);
		const { component, worker, update } = setup("completed", [run([response])]);
		expect(SettingsManager.create).toHaveBeenCalledExactlyOnceWith(worker.cwd);
		const expected = new Container();
		const markdownTheme = { ...getMarkdownTheme(), codeBlockIndent: "    " };
		expected.addChild(new UserMessageComponent("Locate renderer", markdownTheme, 0));
		expected.addChild(new AssistantMessageComponent(response, true, markdownTheme, "Thinking...", 0));
		expectChat(component, expected);
		expect(component.render(100).join("\n")).not.toContain("Private reasoning");
		click(component, "Thinking...");
		expect(component.render(100).join("\n")).toContain("Private reasoning");
		update();
		expect(component.render(100).join("\n")).toContain("Private reasoning");
		expect(SettingsManager.create).toHaveBeenCalledTimes(1);
	});

	it("updates the same assistant component while streaming and completes it without duplication", () => {
		const user: Message = { role: "user", content: "Locate renderer", timestamp: 1 };
		const active = run([user], "running");
		active.streamingMessage = assistant([
			{ type: "thinking", thinking: "Working" },
			{ type: "text", text: "Partial" },
		]);
		const render = vi.spyOn(AssistantMessageComponent.prototype, "render");
		const { component, update, worker } = setup("running", [active]);
		component.render(100);
		const original = render.mock.contexts[0];
		expect(render).toHaveBeenCalledTimes(1);
		click(component, "Working");
		render.mockClear();
		active.streamingMessage = assistant([
			{ type: "thinking", thinking: "Working more" },
			{ type: "text", text: "Partial answer" },
		]);
		update();
		const streaming = component.render(100).join("\n");
		expect(streaming).toContain("Partial answer");
		expect(streaming).not.toContain("Working more");
		expect(render.mock.contexts).toEqual([original]);
		const final = assistant([
			{ type: "thinking", thinking: "Working more" },
			{ type: "text", text: "Final answer" },
		]);
		active.messages.push(final);
		active.streamingMessage = undefined;
		active.status = "completed";
		worker.status = "completed";
		update();
		render.mockClear();
		const completed = component.render(100).map(stripVTControlCharacters).join("\n");
		expect(completed.match(/Final answer/g)).toHaveLength(1);
		expect(completed).not.toContain("Partial answer");
		expect(completed).not.toContain("Working more");
		expect(render.mock.contexts).toEqual([original]);
	});

	it("refreshes same-object streaming tool arguments and retains the tool component through its result", () => {
		const call = {
			type: "toolCall",
			id: "stream-read",
			name: "read",
			arguments: { path: "before.ts" },
		} satisfies AssistantMessage["content"][number];
		const active = run([], "running");
		active.streamingMessage = assistant([call]);
		const render = vi.spyOn(ToolExecutionComponent.prototype, "render");
		const { component, worker, update } = setup("running", [active]);
		expect(component.render(100).join("\n")).toContain("before.ts");
		const original = render.mock.contexts[0];
		render.mockClear();
		call.arguments.path = "after.ts";
		update();
		const updated = component.render(100).join("\n");
		expect(updated).toContain("after.ts");
		expect(updated).not.toContain("before.ts");
		expect(render.mock.contexts).toEqual([original]);
		active.messages.push(assistant([call], "toolUse"), {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "export const streamed = true;" }],
			isError: false,
			timestamp: 2,
		});
		active.streamingMessage = undefined;
		active.status = "completed";
		worker.status = "completed";
		update();
		render.mockClear();
		component.render(100);
		expect(render.mock.contexts).toEqual([original]);
		click(component, "after.ts");
		expect(stripVTControlCharacters(component.render(100).join("\n"))).toContain("export const streamed = true;");
	});

	it.each(["aborted", "failed"] as const)("finalizes a preserved streaming partial when the run is %s", (status) => {
		const active = run([], "running");
		active.streamingMessage = assistant([{ type: "text", text: "Partial response" }]);
		const updateContent = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
		const { component, worker, update } = setup("running", [active]);
		component.render(100);
		active.status = status;
		active.errorMessage = "Worker stopped unexpectedly";
		worker.status = status === "aborted" ? "interrupted" : "failed";
		update();
		const rendered = stripVTControlCharacters(component.render(100).join("\n"));
		expect(updateContent).toHaveBeenLastCalledWith(
			expect.objectContaining({ stopReason: status === "aborted" ? "aborted" : "error" }),
			false,
		);
		expect(rendered).toContain("Partial response");
		expect(rendered.match(/Worker stopped unexpectedly/g)).toHaveLength(1);
		update();
		expect(component.render(100).map(stripVTControlCharacters).join("\n")).toBe(rendered);
	});

	it("steers a starting worker directly and releases the foreground wait before its one completion report", async () => {
		const parent = await createHarness({ extensionFactories: [subagentExtension] });
		const originalScript = process.argv[1];
		process.argv[1] = fileURLToPath(new URL("./fixtures/subagent-model-worker.mjs", import.meta.url));
		const ctx = parent.session.extensionRunner.createContext();
		try {
			const releaseFile = join(parent.tempDir, "release");
			parent.setResponses([
				fauxAssistantMessage(
					fauxToolCall("subagent", {
						agent: "explorer",
						model: parent.getModel().id,
						task: JSON.stringify({ log: join(parent.tempDir, "worker.jsonl"), releaseFile }),
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("main continued"),
				fauxAssistantMessage("received report"),
			]);
			const mainTurn = parent.session.prompt("Start the explorer");
			await vi.waitFor(() => expect(findWorkerTeam(ctx)?.list()[0]?.status).toBe("running"));
			const team = findWorkerTeam(ctx)!;
			const workerId = team.list()[0].id;
			const setMainView = vi.fn<(view: ExtensionMainView | undefined) => void>();
			showWorkerView({ setMainView, notify: vi.fn() } as unknown as ExtensionUIContext, team, workerId);
			setMainView.mock.calls[0][0]!.onSubmit("Inspect the parser first");
			await vi.waitFor(() =>
				expect(team.getViews()[0].runs[0].pendingSteering).toEqual(["Inspect the parser first"]),
			);
			expect(parent.faux.state.callCount).toBe(1);
			const editor = new CustomEditor(
				new TuiMainScreen(new VirtualTerminal()),
				defaultEditorTheme,
				new KeybindingsManager(),
			);
			editor.onAction("app.subagents.background", () => team.backgroundForegroundWorkers());
			editor.setText("draft");
			editor.handleInput("\x02");
			await mainTurn;
			expect(editor.getText()).toBe("draft");
			expect(team.list()).toMatchObject([{ id: workerId, status: "running" }]);
			expect(parent.session.messages).toContainEqual(
				expect.objectContaining({ role: "toolResult", details: expect.objectContaining({ jobIds: [workerId] }) }),
			);
			editor.handleInput("\x02");
			expect(editor.getCursor().col).toBe(4);
			writeFileSync(releaseFile, "");
			await vi.waitFor(() => expect(parent.faux.state.callCount).toBe(3));
			await parent.session.waitForIdle();
			expect(
				parent.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "subagent-result",
				),
			).toHaveLength(1);
		} finally {
			await findWorkerTeam(ctx)?.dispose();
			process.argv[1] = originalScript;
			parent.cleanup();
		}
	});

	it("continues an interrupted worker directly", async () => {
		const { view, team } = setup("interrupted");
		view.onSubmit("resume");
		await vi.waitFor(() => expect(team.continue).toHaveBeenCalledWith("worker-1", "resume"));
		expect(team.sendUserMessage).not.toHaveBeenCalled();
	});

	it("retains editor text when an interrupted worker becomes active before submission", async () => {
		const { view, team } = setup("interrupted");
		vi.mocked(team.continue).mockResolvedValueOnce("already_active");
		view.onSubmit("keep this message");
		await vi.waitFor(() => expect(team.sendUserMessage).toHaveBeenCalledWith("worker-1", "keep this message"));
	});

	it.each(["queued_until_continue", "retained_until_continue: Resolve the pending assignment"])(
		"reports retained messages instead of implying delivery (%s)",
		async (result) => {
			const { view, team, notify } = setup("completed");
			vi.mocked(team.sendUserMessage).mockResolvedValueOnce(result);
			view.onSubmit("hello");
			await vi.waitFor(() =>
				expect(notify).toHaveBeenCalledWith(expect.stringMatching(/queued|retained/), "warning"),
			);
		},
	);

	it("surfaces send errors", async () => {
		const { view, team, notify } = setup("running");
		vi.mocked(team.sendUserMessage).mockRejectedValueOnce(new Error("Worker transport unavailable"));
		view.onSubmit("hello");
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Worker transport unavailable", "error"));
	});

	it("does not send to a cancelled or removed worker", async () => {
		const { view, team, notify, component, views } = setup("cancelled");
		view.onSubmit("hello");
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("explorer has been cancelled.", "warning"));
		expect(team.sendUserMessage).not.toHaveBeenCalled();
		views.length = 0;
		view.onSubmit("hello again");
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Worker worker-1 no longer exists.", "warning"));
		expect(component.render(100).join("\n")).toContain("no longer exists");
		expect(team.sendUserMessage).not.toHaveBeenCalled();
	});

	it("unsubscribes when switching away from the worker", () => {
		const { component, unsubscribe } = setup("running");
		component.dispose?.();
		opened.splice(opened.indexOf(component), 1);
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
