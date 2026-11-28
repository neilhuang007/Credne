// Follows how far a blocks compaction has got: each step takes a part of the whole in proportion to how long it usually
// takes, and a step with a known number of model requests advances within its part as they finish.

/**
 * The steps of a blocks compaction, in order; the prune and subagents steps are skipped when they have nothing to do.
 * The next steps are written alongside the condense, prune and subagents steps; the last step waits for them.
 */
export type CompactionStep = "clean" | "rewrite" | "slice" | "condense" | "prune" | "subagents" | "next";

/** Where a step stands: finished or skipped, running, or still to come. */
export type SegmentState = "done" | "current" | "pending";

/** One step's part of the progress bar. */
export interface ProgressSegment {
	/** How long the step usually takes, relative to the other parts. */
	weight: number;
	state: SegmentState;
}

/** What a progress display shows. */
export interface ProgressView {
	/** The current step's short label, such as `Compacting blocks`. */
	label: string;
	/** The steps that take a part of the bar, in order. */
	segments: readonly ProgressSegment[];
	/** The current step's finished and total requests; undefined for a step that does not count them. */
	count: { done: number; total: number } | undefined;
}

const stepOrder: readonly CompactionStep[] = ["clean", "rewrite", "slice", "condense", "prune", "subagents", "next"];

// How long each step usually takes, relative to the others, so the bar moves at an even pace. Cleaning and slicing take
// no noticeable time and get no part.
const stepWeights: Readonly<Record<CompactionStep, number>> = {
	clean: 0,
	rewrite: 3,
	slice: 0,
	condense: 10,
	prune: 3,
	subagents: 1,
	next: 3,
};

// The steps that count their chat requests as they finish: condensing and the subagent cards. The others make one
// request, a few rounds whose number is not known in advance, or none; the request for the next steps, which runs
// alongside them, is not counted.
const countedSteps: ReadonlySet<CompactionStep> = new Set(["condense", "subagents"]);

/** Tracks the steps of one blocks compaction and hands every change to `show`. */
export class CompactionProgress {
	private readonly show: (view: ProgressView) => void;
	/** Whether the bar has a part for the subagent cards. */
	private withSubagents: boolean;
	private step: CompactionStep = "clean";
	private done = 0;
	private total: number | undefined;

	/** `subagents` is the number of workers whose cards the compaction is expected to write, as known at its start. */
	constructor(show: (view: ProgressView) => void, subagents: number) {
		this.show = show;
		this.withSubagents = subagents > 0;
	}

	/** Starts a step; `total` is the number of requests it will make, when known. */
	begin(step: CompactionStep, total?: number): void {
		this.step = step;
		this.done = 0;
		this.total = total;
		// The workers may have changed since the start; a part shown for cards that are not written counts as done.
		if (step === "subagents") this.withSubagents = true;
		this.publish();
	}

	/** Counts one finished chat request when the current step counts its requests. */
	finished(): void {
		if (!countedSteps.has(this.step)) return;
		this.done++;
		this.publish();
	}

	private publish(): void {
		const current = stepOrder.indexOf(this.step);
		const segments = stepOrder.flatMap((step, index): ProgressSegment[] => {
			if (stepWeights[step] === 0 || (step === "subagents" && !this.withSubagents)) return [];
			const state = index < current ? "done" : index === current ? "current" : "pending";
			return [{ weight: stepWeights[step], state }];
		});
		const count =
			countedSteps.has(this.step) && this.total
				? { done: Math.min(this.done, this.total), total: this.total }
				: undefined;
		this.show({ label: stepLabel(this.step), segments, count });
	}
}

function stepLabel(step: CompactionStep): string {
	switch (step) {
		case "clean":
			return "Cleaning the transcript";
		case "rewrite":
			return "Condensing the user prompt";
		case "slice":
			return "Slicing into blocks";
		case "condense":
			return "Compacting blocks";
		case "prune":
			return "Removing outdated statements";
		case "subagents":
			return "Summarizing subagents";
		case "next":
			return "Writing the next steps";
	}
}
