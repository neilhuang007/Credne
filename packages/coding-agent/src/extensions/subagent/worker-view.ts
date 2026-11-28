// Displays a worker with the main chat components and sends editor submissions directly to that worker.
import type { AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, ToolRenderers } from "../../core/extensions/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { createAllToolRenderers } from "../../core/tools/renderers/index.ts";
import { ActivitySpinner, renderActivityRow } from "../../modes/interactive/components/activity-row.ts";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { ToolExecutionComponent } from "../../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../modes/interactive/components/user-message.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { SingleResult } from "./runner.ts";
import type { WorkerTeam, WorkerView } from "./team.ts";
import { formatWorkerStats } from "./widget.ts";
import { renderWorkerName } from "./worker-color.ts";

export type WorkerViewTeam = Pick<WorkerTeam, "continue" | "getViews" | "sendUserMessage" | "subscribe">;

interface ToolChat {
	component: ToolExecutionComponent;
	result?: ToolResultMessage;
}

interface AssistantChat {
	component: AssistantMessageComponent;
	message: AssistantMessage;
	tools: Map<string, ToolChat>;
}

interface RunChat {
	root: Container;
	messages: Container;
	initialPrompt: Container;
	diagnostics: Text;
	processed: number;
	hasUserMessage: boolean;
	tools: Map<string, ToolChat>;
	toolResults: Map<string, ToolResultMessage>;
	streaming?: AssistantChat;
	finalizedPartial?: AssistantMessage;
}

/** Shows a worker's live chat and routes editor follow-ups directly to its retained conversation. */
export function showWorkerView(ui: ExtensionUIContext, team: WorkerViewTeam, workerId: string): void {
	const worker = team.getViews().find((view) => view.id === workerId);
	if (!worker) {
		ui.notify(`Worker ${workerId} no longer exists.`, "warning");
		return;
	}
	ui.setMainView({
		label: worker.name,
		color: worker.color,
		component: (tui, theme) => new WorkerChat(tui, theme, team, worker),
		onSubmit: (text) => void sendToWorker(ui, team, workerId, text),
	});
}

async function sendToWorker(ui: ExtensionUIContext, team: WorkerViewTeam, workerId: string, prompt: string) {
	const worker = team.getViews().find((view) => view.id === workerId);
	if (!worker) return ui.notify(`Worker ${workerId} no longer exists.`, "warning");
	if (worker.status === "cancelled") return ui.notify(`${worker.name} has been cancelled.`, "warning");
	try {
		let result =
			worker.status === "interrupted"
				? await team.continue(workerId, prompt)
				: await team.sendUserMessage(workerId, prompt);
		if (result === "already_active") result = await team.sendUserMessage(workerId, prompt);
		if (result === "cancelled" || result === "not_running") {
			ui.notify(`${worker.name}: message not sent (${result})`, "warning");
		} else if (result === "queued_until_continue") {
			ui.notify(`${worker.name}: message queued while interrupted. Send a follow-up here to resume it.`, "warning");
		} else if (result.startsWith("retained_until_continue:")) {
			ui.notify(
				`${worker.name}: message retained until resumed. ${result.slice("retained_until_continue:".length).trim()}`,
				"warning",
			);
		}
	} catch (error) {
		ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

class WorkerChat extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly team: WorkerViewTeam;
	private readonly workerId: string;
	private readonly cwd: string;
	private readonly settings: SettingsManager;
	private readonly spinner: ActivitySpinner;
	private readonly unsubscribe: () => void;
	private readonly header = new Text("", 0, 0);
	private readonly chat = new Container();
	private readonly pending = new Text("", 0, 0);
	private readonly runs: RunChat[] = [];
	private readonly renderers: Readonly<Record<string, ToolRenderers | undefined>> = createAllToolRenderers();
	private dirty = true;
	private isRunning = false;

	constructor(tui: TUI, theme: Theme, team: WorkerViewTeam, worker: WorkerView) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.team = team;
		this.workerId = worker.id;
		this.cwd = worker.cwd;
		this.settings = SettingsManager.create(worker.cwd);
		this.spinner = new ActivitySpinner(
			tui,
			(text) => theme.fg("accent", text),
			(text) => text,
			"",
		);
		this.spinner.stop();
		this.addChild(this.header);
		this.addChild(this.chat);
		this.addChild(this.pending);
		this.unsubscribe = team.subscribe(() => {
			this.dirty = true;
			this.updateSpinner();
			tui.requestRender();
		});
		this.updateSpinner();
	}

	override render(width: number): string[] {
		const worker = this.team.getViews().find((view) => view.id === this.workerId);
		if (!worker) {
			this.header.setText(this.theme.fg("muted", `Worker ${this.workerId} no longer exists.`));
			this.chat.clear();
			this.pending.setText("");
			return super.render(width);
		}
		const icon = worker.status === "running" ? this.spinner.render(1)[0] : this.theme.fg("muted", "◯");
		const back = keyText("app.interrupt");
		this.header.setText(
			[
				renderActivityRow(
					width,
					`${icon} ${renderWorkerName(worker, this.theme)}`,
					this.theme.fg("muted", formatWorkerStats(worker)),
				),
				this.theme.fg(
					"dim",
					`Message this worker directly${back ? ` · ${back} returns to main` : ""} · /commands run in main`,
				),
				this.theme.fg("border", "─".repeat(width)),
			].join("\n"),
		);
		if (this.dirty) {
			this.updateChat(worker);
			const steering = worker.runs.find((run) => run.status === "running")?.pendingSteering ?? [];
			this.pending.setText(steering.map((message) => this.theme.fg("dim", `Steering: ${message}`)).join("\n"));
			this.dirty = false;
		}
		return super.render(width);
	}

	override invalidate(): void {
		super.invalidate();
		this.spinner.invalidate();
	}

	dispose(): void {
		this.unsubscribe();
		this.spinner.stop();
	}

	private updateSpinner(): void {
		const running = this.team.getViews().find((view) => view.id === this.workerId)?.status === "running";
		if (running === this.isRunning) return;
		this.isRunning = running;
		if (running) this.spinner.start();
		else this.spinner.stop();
	}

	private updateChat(worker: WorkerView): void {
		if (!worker.runs.length) {
			this.chat.clear();
			this.chat.addChild(new Text(this.theme.fg("muted", "No worker messages yet."), 0, 0));
			return;
		}
		for (let index = 0; index < worker.runs.length; index++) {
			const run = worker.runs[index];
			let chat = this.runs[index];
			if (!chat) {
				if (!this.runs.length) this.chat.clear();
				else this.chat.addChild(new Spacer(1));
				chat = this.createRunChat(run);
				this.runs.push(chat);
				this.chat.addChild(chat.root);
			}
			for (let messageIndex = chat.processed; messageIndex < run.messages.length; messageIndex++) {
				const message = run.messages[messageIndex];
				if (message.role === "toolResult") chat.toolResults.set(message.toolCallId, message);
			}
			for (; chat.processed < run.messages.length; chat.processed++)
				this.addMessage(chat, run.messages[chat.processed]);
			this.updateRunStreaming(chat, run);
			const errors = [
				run.errorMessage &&
				chat.finalizedPartial?.errorMessage !== run.errorMessage &&
				!run.messages.some((message) => message.role === "assistant" && message.errorMessage === run.errorMessage)
					? run.errorMessage
					: "",
				run.terminationSignal ? `Signal: ${run.terminationSignal}` : "",
				run.stderr.trim(),
			].filter(Boolean);
			chat.diagnostics.setText(errors.length ? `\n${this.theme.fg("error", errors.join("\n"))}` : "");
		}
	}

	private updateRunStreaming(chat: RunChat, run: SingleResult): void {
		if (run.status === "running" || run.status === "pending") {
			if (run.streamingMessage)
				chat.streaming = this.updateAssistant(chat, run.streamingMessage, chat.streaming, true);
			return;
		}
		const partial = run.streamingMessage ?? chat.streaming?.message;
		if (!partial || chat.finalizedPartial) return;
		chat.finalizedPartial = {
			...partial,
			stopReason: run.status === "aborted" ? "aborted" : run.status === "failed" ? "error" : partial.stopReason,
			errorMessage: run.errorMessage ?? partial.errorMessage,
		};
		this.updateAssistant(chat, chat.finalizedPartial, chat.streaming, false);
		chat.streaming = undefined;
	}

	private createRunChat(run: SingleResult): RunChat {
		const root = new Container();
		const messages = new Container();
		const initialPrompt = new Container();
		initialPrompt.addChild(new UserMessageComponent(run.task, this.markdownTheme(), this.settings.getOutputPad()));
		messages.addChild(initialPrompt);
		const diagnostics = new Text("", this.settings.getOutputPad(), 0);
		root.addChild(messages);
		root.addChild(diagnostics);
		return {
			root,
			messages,
			initialPrompt,
			diagnostics,
			processed: 0,
			hasUserMessage: false,
			tools: new Map(),
			toolResults: new Map(),
		};
	}

	private addMessage(chat: RunChat, message: Message): void {
		if (message.role === "user") {
			this.addUserMessage(chat, message);
		} else if (message.role === "assistant") {
			this.updateAssistant(chat, message, chat.streaming, false);
			chat.streaming = undefined;
		} else if (message.role === "toolResult") {
			const tool = chat.tools.get(message.toolCallId);
			if (tool) this.applyToolResult(tool, message);
		}
	}

	private addUserMessage(chat: RunChat, message: UserMessage): void {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "[Image attached]")).join("\n");
		const component = new UserMessageComponent(text, this.markdownTheme(), this.settings.getOutputPad());
		if (!chat.hasUserMessage) {
			chat.initialPrompt.clear();
			chat.initialPrompt.addChild(component);
			chat.hasUserMessage = true;
		} else {
			chat.messages.addChild(new Spacer(1));
			chat.messages.addChild(component);
		}
	}

	private updateAssistant(
		chat: RunChat,
		message: AssistantMessage,
		previous: AssistantChat | undefined,
		streaming: boolean,
	): AssistantChat {
		const rendered = previous ?? {
			component: new AssistantMessageComponent(
				undefined,
				this.settings.getHideThinkingBlock(),
				this.markdownTheme(),
				"Thinking...",
				this.settings.getOutputPad(),
			),
			message,
			tools: new Map<string, ToolChat>(),
		};
		if (!previous) chat.messages.addChild(rendered.component);
		rendered.component.updateContent(message, streaming);
		rendered.message = message;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			let tool = rendered.tools.get(part.id);
			if (!tool) {
				tool = { component: this.createTool(part) };
				rendered.tools.set(part.id, tool);
				chat.tools.set(part.id, tool);
				chat.messages.addChild(tool.component);
			} else {
				tool.component.updateArgs(part.arguments);
			}
			const result = chat.toolResults.get(part.id);
			if (result) this.applyToolResult(tool, result);
			if (!streaming) {
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					tool.component.updateResult({
						content: [{ type: "text", text: message.errorMessage || "Operation aborted" }],
						isError: true,
					});
				} else {
					tool.component.setArgsComplete();
				}
			}
		}
		return rendered;
	}

	private applyToolResult(tool: ToolChat, result: ToolResultMessage): void {
		if (tool.result === result) return;
		if (!tool.result) tool.component.markExecutionStarted();
		tool.component.updateResult(result);
		tool.result = result;
	}

	private createTool(call: ToolCall): ToolExecutionComponent {
		return new ToolExecutionComponent(
			call.name,
			call.id,
			call.arguments,
			{
				showImages: this.settings.getShowImages(),
				imageWidthCells: this.settings.getImageWidthCells(),
				outputPad: this.settings.getOutputPad(),
			},
			this.renderers[call.name],
			this.tui,
			this.cwd,
		);
	}

	private markdownTheme() {
		return { ...getMarkdownTheme(), codeBlockIndent: this.settings.getCodeBlockIndent() };
	}
}
