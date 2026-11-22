// Regression tests for per-project interactive prompt history and manual model defaults.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Container, getKeybindings, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { PromptHistory } from "../src/core/prompt-history.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import type { WarningGroupComponent } from "../src/modes/interactive/components/warning-group.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const prototype = InteractiveMode.prototype as unknown as {
	setupEditorSubmitHandler(this: object): void;
	renderInitialMessages(this: object): void;
	handleFollowUp(this: object): Promise<void>;
	handleModelCommand(this: object, searchTerm: string): Promise<void>;
	selectInteractiveModel(this: object, ...args: unknown[]): Promise<void>;
	cycleModel(this: object, direction: "forward" | "backward"): Promise<void>;
	showWarning(this: object, message: string): void;
};
const tempDirs: string[] = [];
const originalKeybindings = getKeybindings();

function history(project: string, agentDir: string): PromptHistory {
	return new PromptHistory(project, agentDir);
}

function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-history-"));
	tempDirs.push(dir);
	return dir;
}

beforeAll(() => initTheme("dark"));
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	setKeybindings(originalKeybindings);
});

describe("interactive editor history", () => {
	it("recalls normal, slash, shell and queued submissions after restart, without transcript seed reordering", async () => {
		const agentDir = createTempDir();
		const project = path.join(agentDir, "my-project");
		const store = history(project, agentDir);
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		editor.setHistory(store.load());
		const host = {
			defaultEditor: editor,
			editor,
			promptHistory: store,
			pendingUserInputs: [] as string[],
			mainView: undefined,
			session: { isCompacting: false, isStreaming: false, isBashRunning: false },
			flushPendingBashComponents: vi.fn(),
			handleModelCommand: vi.fn(async () => {}),
			handleBashCommand: vi.fn(async () => {}),
			updateEditorBorderColor: vi.fn(),
			isExtensionCommand: vi.fn(() => false),
			queueCompactionMessage: vi.fn(),
		};
		prototype.setupEditorSubmitHandler.call(host);
		host.session.isCompacting = true;
		editor.setText("queued");
		editor.handleInput("\r");
		await Promise.resolve();
		expect(host.queueCompactionMessage).toHaveBeenCalledWith("queued", "steer");
		host.session.isCompacting = false;
		for (const submitted of ["first", "/model", "!echo hello", "last", "last"]) {
			editor.setText(submitted);
			editor.handleInput("\r");
			await Promise.resolve();
		}
		expect(host.pendingUserInputs).toEqual(["first", "last", "last"]);
		expect(host.handleModelCommand).toHaveBeenCalledOnce();
		expect(host.handleBashCommand).toHaveBeenCalledWith("echo hello", false);
		expect(store.load()).toEqual(["queued", "first", "/model", "!echo hello", "last"]);

		const restarted = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		restarted.setHistory(history(project, agentDir).load());
		restarted.setText("draft");
		restarted.handleInput("\x1b[A");
		restarted.handleInput("\x1b[A");
		expect(restarted.getText()).toBe("last");
		restarted.handleInput("\x1b[A");
		expect(restarted.getText()).toBe("!echo hello");
		restarted.handleInput("\x1b[B");
		restarted.handleInput("\x1b[B");
		expect(restarted.getText()).toBe("draft");
	});

	it("seeds a resumed session only when no durable history exists, preserving durable order", () => {
		const agentDir = createTempDir();
		const project = path.join(agentDir, "project");
		const store = history(project, agentDir);
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		const fakeThis = {
			promptHistory: store,
			sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
			renderSessionEntries: vi.fn((_entries: unknown[], options: { populateHistory: boolean }) => {
				if (options.populateHistory) {
					editor.addToHistory("session first");
					editor.addToHistory("session last");
				}
			}),
			renderProjectTrustWarningIfNeeded: vi.fn(),
		};
		prototype.renderInitialMessages.call(fakeThis);
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith([], {
			updateFooter: true,
			populateHistory: true,
		});
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("session last");

		store.record("durable first");
		store.record("durable last");
		editor.setText("");
		editor.setHistory(store.load());
		prototype.renderInitialMessages.call(fakeThis);
		expect(fakeThis.renderSessionEntries).toHaveBeenLastCalledWith([], {
			updateFooter: true,
			populateHistory: false,
		});
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("durable last");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("durable first");
	});

	it("records queued follow-up submissions without writing them again when dequeued", async () => {
		const agentDir = createTempDir();
		const store = history(path.join(agentDir, "project"), agentDir);
		const keybindings = KeybindingsManager.create();
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		editor.setText("follow up");
		const host = {
			editor,
			promptHistory: store,
			session: { isCompacting: false, isStreaming: true, prompt: vi.fn(async () => {}) },
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		await prototype.handleFollowUp.call(host);
		expect(host.session.prompt).toHaveBeenCalledWith("follow up", { streamingBehavior: "followUp" });
		expect(store.load()).toEqual(["follow up"]);
	});

	it("keeps projects isolated, bounds history, and merges concurrent store instances", () => {
		const agentDir = createTempDir();
		const first = history(path.join(agentDir, "project-a", "..", "project-a"), agentDir);
		const otherSession = history(path.join(agentDir, "project-a"), agentDir);
		const second = history(path.join(agentDir, "project-b"), agentDir);
		first.record("a");
		otherSession.record("b");
		second.record("other project");
		expect(otherSession.load()).toEqual(["a", "b"]);
		for (let index = 0; index < 103; index++) first.record(`prompt ${index}`);
		expect(otherSession.load()).toHaveLength(100);
		expect(otherSession.load().at(-1)).toBe("prompt 102");
		expect(second.load()).toEqual(["other project"]);
		const editor = new CustomEditor(
			new TuiMainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			KeybindingsManager.create(),
		);
		editor.setHistory(otherSession.load());
		editor.setHistory(second.load());
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("other project");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("other project");
	});

	it("ignores invalid files and unwritable storage without blocking submissions", () => {
		const agentDir = createTempDir();
		const store = history("/invalid", agentDir);
		store.record("keep");
		const directory = path.join(agentDir, "prompt-history");
		const [file] = fs.readdirSync(directory);
		fs.writeFileSync(path.join(directory, file!), "not JSON");
		expect(store.load()).toEqual([]);
		store.record("recovered");
		expect(store.load()).toEqual(["recovered"]);
		const inaccessible = history("/other", path.join(agentDir, "not-a-directory"));
		fs.writeFileSync(path.join(agentDir, "not-a-directory"), "file");
		expect(() => inaccessible.record("no crash")).not.toThrow();
		expect(inaccessible.load()).toEqual([]);
	});
});

describe("interactive model selection", () => {
	it("persists direct /model selection and model cycling", async () => {
		const model = { id: "model-2", provider: "example", name: "Model 2", reasoning: false };
		const session = {
			setModel: vi.fn(async () => {}),
			cycleModel: vi.fn(async () => ({ model, thinkingLevel: "off" })),
			scopedModels: [],
		};
		const host = {
			session,
			findExactModelMatch: vi.fn(async () => model),
			selectInteractiveModel: prototype.selectInteractiveModel,
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
		};
		await prototype.handleModelCommand.call(host, "example/model-2");
		await prototype.cycleModel.call(host, "forward");
		expect(session.setModel).toHaveBeenCalledWith(model, { persist: true });
		expect(session.cycleModel).toHaveBeenCalledWith("forward", { persist: true });
	});
});

describe("interactive warnings", () => {
	it("groups warnings into a collapsed count, and clicking the header reveals and hides details", () => {
		const chatContainer = new Container();
		const host = {
			chatContainer,
			ui: { requestRender: vi.fn() },
			warningGroup: undefined as WarningGroupComponent | undefined,
		};
		prototype.showWarning.call(host, "diagnostic one");
		prototype.showWarning.call(host, "diagnostic two");
		const group = host.warningGroup!;
		const rendered = () =>
			group
				.render(100)
				.join("\n")
				.replace(/\u001b\[[0-9;]*m/g, "");
		expect(rendered()).toContain("Warnings (2)");
		expect(rendered()).not.toContain("diagnostic one");
		const header = group.children[0] as { handleMouse: (event: object) => { handled: boolean } | undefined };
		const click = { type: "click", button: "left", x: 2, y: 0, width: 100, height: 1, screenX: 2, screenY: 0 };
		expect(header.handleMouse(click)).toEqual({ handled: true });
		expect(rendered()).toContain("diagnostic one");
		expect(rendered()).toContain("diagnostic two");
		header.handleMouse(click);
		expect(rendered()).not.toContain("diagnostic two");
		group.setExpanded(true);
		expect(rendered()).toContain("diagnostic two");
	});
});
