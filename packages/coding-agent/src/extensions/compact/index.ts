// Lets the main agent compact at a moment of its choosing: when free context runs low, a hidden reminder reveals the compact tool.
// Also runs the "blocks" compaction strategy and registers read_block, which reads a condensed block in full.
import { Type } from "typebox";
import { prepareCompaction } from "../../core/compaction/compaction.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { resolveCompactionStrategy, resolveCompactionTokenSetting } from "../../core/settings-manager.ts";
import { createSubagentDispatch } from "../subagent/dispatch.ts";
import { findWorkerTeam } from "../subagent/team.ts";
import { compactWithBlocks } from "./pipeline.ts";
import { CompactionProgress, type ProgressView } from "./progress.ts";
import { CompactionSection, renderStatusLine } from "./progress-section.ts";
import { registerReadBlock } from "./read-block.ts";

const TOOL_NAME = "compact";
const REMINDER_TYPE = "compaction-reminder";
// Key of the progress section in the side panel.
const PROGRESS_KEY = "compact";
// Above the planning (0) and subagent (10) sections: a running compaction holds up all other work.
const PROGRESS_ORDER = -10;
// The tool's loadout change until the agent has been reminded.
const HIDE_COMPACT = { hiddenDeclarations: [TOOL_NAME] };
// Free context is reminded about at most at this share of the window, so a small window is not reminded from the start.
const remindWindowShare = 0.2;

/**
 * Registers the `compact` tool and the reminder that reveals it once free context drops to the remind threshold, the
 * "blocks" compaction strategy, and the `read_block` tool.
 */
export default function compactExtension(pi: ExtensionAPI): void {
	// Whether the agent has been reminded since the latest compaction; restore() reads it from the branch.
	let reminded = false;
	// Time of the latest compaction on the branch: reminders up to it are stale and leave the model's context.
	let compactedAt: number | undefined;
	// The blocks strategy weighs the medium tier model of the current account, as subagent dispatch picks it, as its
	// compactor.
	const dispatch = createSubagentDispatch(pi);
	// The instructions of the latest compact call, held for the compaction it requested. That compaction runs before the
	// next turn starts or not at all, so they are forgotten at the next compaction, turn or end of the run, whichever
	// comes first.
	let requestedInstructions: string | undefined;

	pi.registerTool({
		name: TOOL_NAME,
		label: "Compact",
		// Draft wording, to be reviewed by the user.
		description:
			"Compact the conversation so that further work continues in a fresh context window. Call it after finishing the current step, when the remaining task requires significantly more work.",
		parameters: Type.Object({
			instructions: Type.Optional(
				Type.String({
					// The user's wording, lightly edited, to be reviewed by the user.
					description:
						'Special instructions for condensing the current conversation. Use only when necessary. Write them under section headings. Under "Focus", name the parts of the conversation to focus on and keep in detail. Under "Next steps", give the immediate work that follows. Optionally, under "Remove", name context that is not needed to achieve the current goal.',
				}),
			),
		}),
		// Activated by the reminder, so the tool is declared late and the initial tool list never holds it.
		defaultActive: false,
		// Hides it if a restored or configured loadout activates it before the reminder.
		prepareLoadout: () => (reminded ? undefined : HIDE_COMPACT),
		async execute(_id, args, _signal, _update, ctx) {
			const compaction = pi.getSettings().compaction;
			const settings = {
				enabled: compaction?.enabled ?? SETTINGS_DEFAULTS.compaction.enabled,
				reserveTokens: resolveCompactionTokenSetting(compaction, "reserveTokens", ctx.model),
				keepRecentTokens: resolveCompactionTokenSetting(compaction, "keepRecentTokens", ctx.model),
			};
			// The core drops a requested compaction when there is nothing to compact, so it is not promised then.
			if (!prepareCompaction(ctx.sessionManager.getBranch(), settings)) {
				return {
					content: [{ type: "text", text: "Nothing to compact yet: the conversation is too short." }],
					details: {},
				};
			}
			requestedInstructions = args.instructions;
			ctx.requestCompaction();
			return { content: [{ type: "text", text: "Compaction will run before your next response." }], details: {} };
		},
	});
	registerReadBlock(pi);

	/**
	 * Marks the agent reminded and activates the tool when free context is at or below the remind threshold and the
	 * agent was not reminded since the latest compaction; returns the reminder to insert. The threshold is the smaller
	 * of `remindTokens` and a fifth of the window, and there is none when it is not above `reserveTokens`.
	 */
	function remind(ctx: ExtensionContext): string | undefined {
		if (reminded) return undefined;
		const compaction = pi.getSettings().compaction;
		if (!(compaction?.enabled ?? SETTINGS_DEFAULTS.compaction.enabled)) return undefined;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return undefined;
		const remindTokens = resolveCompactionTokenSetting(compaction, "remindTokens", ctx.model);
		const threshold = Math.min(remindTokens, usage.contextWindow * remindWindowShare);
		// Forced compaction starts once free context drops to reserveTokens, so a lower threshold would never come first.
		if (threshold <= resolveCompactionTokenSetting(compaction, "reserveTokens", ctx.model)) return undefined;
		// An estimate can exceed the window; the reminder then reports nothing left.
		const remaining = Math.max(0, usage.contextWindow - usage.tokens);
		if (remaining > threshold) return undefined;
		// Main agent only: a subagent worker's tool allowlist leaves the tool unregistered.
		if (!pi.getAllTools().some((tool) => tool.name === TOOL_NAME)) return undefined;
		reminded = true;
		pi.setActiveTools([...pi.getActiveTools(), TOOL_NAME]);
		return reminderText(remaining, usage.contextWindow);
	}

	/** Activates the tool when the agent has been reminded and it is not active. */
	function restoreTool(): void {
		const active = pi.getActiveTools();
		if (reminded && !active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
	}

	/** Recomputes the state from the branch: reminded means a reminder follows its latest compaction. */
	function restore(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch();
		const latestCompaction = branch.findLastIndex((entry) => entry.type === "compaction");
		compactedAt = latestCompaction >= 0 ? Date.parse(branch[latestCompaction].timestamp) : undefined;
		reminded = branch
			.slice(latestCompaction + 1)
			.some((entry) => entry.type === "custom_message" && entry.customType === REMINDER_TYPE);
		// A reminder after the last request may not have declared the tool yet. A tool active without a
		// reminder is left to prepareLoadout: removing it here would drop the restored loadout's pending tools.
		restoreTool();
	}

	/**
	 * Runs the blocks strategy with the compaction's custom instructions, if any. An interruption cancels the compaction,
	 * as it does the summary's; a failure fails it with the reason, and the summary never runs in its place.
	 */
	async function compactBlocks(
		event: SessionBeforeCompactEvent,
		instructions: string | undefined,
		ctx: ExtensionContext,
	): Promise<SessionBeforeCompactResult> {
		// The pipeline writes a card for each running or queued worker of the main session; the bar has a part for them
		// from the start when there are any.
		const subagents = findWorkerTeam(ctx)?.subagentRecords().length ?? 0;
		const progress = new CompactionProgress((view) => showProgress(view, ctx), subagents);
		try {
			const compaction = await compactWithBlocks(pi, event, dispatch, progress, instructions, ctx);
			if (event.signal.aborted) return { cancel: true };
			return { compaction };
		} catch (error) {
			if (event.signal.aborted) return { cancel: true };
			return { error: error instanceof Error ? error.message : String(error) };
		} finally {
			// The indicator line is left to go with the compaction's indicator: restoring the default text here would show
			// it until the compaction ends.
			ctx.ui.setSidePanelSection(PROGRESS_KEY, undefined);
		}
	}

	// At the start of a run the reminder joins the run's starting messages.
	pi.on("before_agent_start", (_event, ctx) => {
		const content = remind(ctx);
		if (content) return { message: { customType: REMINDER_TYPE, content, display: false } };
	});
	// Between turns it is appended once the turn's tool results are in, before the next request. Without
	// triggerTurn it neither starts a run nor keeps one going: a final turn leaves it for the next request.
	pi.on("turn_end", (_event, ctx) => {
		const content = remind(ctx);
		if (content) pi.sendMessage({ customType: REMINDER_TYPE, content, display: false }, { triggerTurn: false });
	});
	// A reminder kept in the compacted context would report the free context of before; dropping it from every request
	// alike keeps the cached prefix stable. Extensions cannot persist an omission at compaction time.
	pi.on("context", (event) => {
		const since = compactedAt;
		if (since === undefined) return;
		const messages = event.messages.filter(
			(message) =>
				!(message.role === "custom" && message.customType === REMINDER_TYPE && message.timestamp <= since),
		);
		if (messages.length < event.messages.length) return { messages };
	});
	pi.on("session_before_compact", (event, ctx) => {
		// Withdrawn before the compaction entry records the tool state, so the compacted context does not declare it;
		// the next reminder declares it late again.
		const active = pi.getActiveTools();
		if (active.includes(TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		// A compact call's instructions belong to the compaction it requested, and the user's to the one /compact starts.
		const requested = requestedInstructions;
		requestedInstructions = undefined;
		const instructions = (event.reason === "agent" ? requested : event.customInstructions)?.trim() || undefined;
		if (resolveCompactionStrategy(pi.getSettings().compaction) === "blocks") {
			return compactBlocks(event, instructions, ctx);
		}
	});
	// A compaction a compact call requested runs before the next turn starts, or not at all once the run ends.
	pi.on("turn_start", () => {
		requestedInstructions = undefined;
	});
	pi.on("agent_end", () => {
		requestedInstructions = undefined;
	});
	pi.on("session_compact", (event) => {
		reminded = false;
		compactedAt = Date.parse(event.compactionEntry.timestamp);
	});
	// A failed compaction leaves the context as it was, so a reminded agent gets the tool back.
	pi.on("session_compact_failed", () => restoreTool());
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
}

/**
 * Shows the progress in place of the working indicator and in the side panel. Without a UI both do nothing, and the
 * line also does nothing in a mode without the compaction indicator.
 */
function showProgress(view: ProgressView, ctx: ExtensionContext): void {
	ctx.ui.setCompactionStatus?.((width, spinner) => renderStatusLine(view, width, spinner, ctx.ui.theme));
	ctx.ui.setSidePanelSection(PROGRESS_KEY, (_tui, theme) => new CompactionSection(view, theme), {
		order: PROGRESS_ORDER,
	});
}

// The user's wording, meant to be reviewed and edited by a person, not reworded by an agent.
function reminderText(remaining: number, contextWindow: number): string {
	return `<system-reminder>
You are approaching your context limit: ${remaining.toLocaleString("en-US")} of ${contextWindow.toLocaleString("en-US")} tokens remain. You can trigger compaction with the compact tool after finishing the most recent step, when the task requires significantly more work. You may choose to continue if the task can be completed within the remaining context window.
</system-reminder>`;
}
