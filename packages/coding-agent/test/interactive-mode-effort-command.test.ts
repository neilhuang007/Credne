import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ThinkingCommandContext = {
	session: {
		getAvailableThinkingLevels: () => ThinkingLevel[];
		setThinkingLevel: (level: ThinkingLevel, options: { persist: boolean }) => void;
	};
	showThinkingSelector: () => void;
	selectThinkingLevel: (level: ThinkingLevel) => void;
	showThinkingLevelSaved: (level: ThinkingLevel) => void;
	showError: (message: string) => void;
};

type SubmitContext = {
	promptHistory: { record: (text: string) => void };
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: { setText: (text: string) => void };
	handleThinkingCommand: (searchTerm?: string) => void;
};

type AutocompleteContext = {
	session: {
		scopedModels: [];
		modelRuntime: { getAvailableSnapshot: () => [] };
		promptTemplates: [];
		extensionRunner: { getRegisteredCommands: () => [] };
		getAvailableThinkingLevels: () => ThinkingLevel[];
	};
	settingsManager: { getEnableSkillCommands: () => boolean };
	skillCommands: Map<string, string>;
	sessionManager: { getCwd: () => string };
	fdPath: null;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	handleThinkingCommand(this: ThinkingCommandContext, searchTerm?: string): void;
	selectThinkingLevel(this: ThinkingCommandContext, level: ThinkingLevel): void;
	createBaseAutocompleteProvider(this: AutocompleteContext): AutocompleteProvider;
};

const interactiveModePrototype = (InteractiveMode as unknown as { prototype: InteractiveModePrivate }).prototype;

function createCommandContext(levels: ThinkingLevel[]) {
	const context: ThinkingCommandContext = {
		session: { getAvailableThinkingLevels: () => levels, setThinkingLevel: vi.fn() },
		showThinkingSelector: vi.fn(),
		selectThinkingLevel: interactiveModePrototype.selectThinkingLevel,
		showThinkingLevelSaved: vi.fn(),
		showError: vi.fn(),
	};
	const submitContext: SubmitContext = {
		promptHistory: { record: vi.fn() },
		defaultEditor: {},
		editor: { setText: vi.fn() },
		handleThinkingCommand: (searchTerm) => interactiveModePrototype.handleThinkingCommand.call(context, searchTerm),
	};
	interactiveModePrototype.setupEditorSubmitHandler.call(submitContext);
	return { context, submitContext };
}

describe("InteractiveMode /effort command", () => {
	it.each(["/effort", "/thinking"])("opens the supported-level selector for %s", async (command) => {
		const { context, submitContext } = createCommandContext(["off", "low", "high"]);

		await submitContext.defaultEditor.onSubmit?.(command);

		expect(submitContext.editor.setText).toHaveBeenCalledWith("");
		expect(context.showThinkingSelector).toHaveBeenCalledOnce();
		expect(context.session.setThinkingLevel).not.toHaveBeenCalled();
	});

	it.each(["/effort HIGH", "/thinking HIGH"])(
		"saves the requested level for new sessions with %s",
		async (command) => {
			const { context, submitContext } = createCommandContext(["off", "low", "high"]);

			await submitContext.defaultEditor.onSubmit?.(command);

			expect(context.session.setThinkingLevel).toHaveBeenCalledWith("high", { persist: true });
			expect(context.showError).not.toHaveBeenCalled();
		},
	);

	it.each(["medium", "unknown"])("rejects unsupported or invalid level %s", async (level) => {
		const { context, submitContext } = createCommandContext(["off", "low", "high"]);

		await submitContext.defaultEditor.onSubmit?.(`/effort ${level}`);

		expect(context.session.setThinkingLevel).not.toHaveBeenCalled();
		expect(context.showError).toHaveBeenCalledWith(
			`Unknown thinking level "${level}". Available levels: off, low, high.`,
		);
	});

	it("completes both commands with the current model's supported levels", async () => {
		let availableLevels: ThinkingLevel[] = ["off", "high"];
		const context: AutocompleteContext = {
			session: {
				scopedModels: [],
				modelRuntime: { getAvailableSnapshot: () => [] },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
				getAvailableThinkingLevels: () => availableLevels,
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
			fdPath: null,
		};
		const provider = interactiveModePrototype.createBaseAutocompleteProvider.call(context);
		const options = { signal: new AbortController().signal };

		const effortLine = "/effort ";
		const effortSuggestions = await provider.getSuggestions([effortLine], 0, effortLine.length, options);
		expect(effortSuggestions?.items.map((item) => item.value)).toEqual(["off", "high"]);

		availableLevels = ["off", "low"];
		const updatedEffortSuggestions = await provider.getSuggestions([effortLine], 0, effortLine.length, options);
		expect(updatedEffortSuggestions?.items.map((item) => item.value)).toEqual(["off", "low"]);

		const thinkingLine = "/thinking ";
		const thinkingSuggestions = await provider.getSuggestions([thinkingLine], 0, thinkingLine.length, options);
		expect(thinkingSuggestions?.items.map((item) => item.value)).toEqual(["off", "low"]);
	});
});
