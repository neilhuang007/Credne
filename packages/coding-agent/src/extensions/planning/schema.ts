// Defines planning tool input and persisted session state schemas.
import { Type } from "typebox";

// Name and description wording comes from Claude Code TaskCreate/TaskUpdate; other descriptions are API facts.
export const taskCreateSchema = Type.Object(
	{
		name: Type.String({
			minLength: 1,
			description: 'A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")',
		}),
		order: Type.Integer({
			minimum: 1,
			description: "Tasks with the same order may run together. All tasks with a lower order must complete first.",
		}),
		description: Type.String({ minLength: 1, description: "What needs to be done" }),
		acceptance: Type.Optional(
			Type.Array(Type.String(), { description: "Conditions required to complete the task." }),
		),
		paths: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				description: "Relevant files or directories; does not lock them.",
			}),
		),
	},
	{ additionalProperties: false },
);

export const taskRevisionSchema = Type.Object(
	{
		...taskCreateSchema.properties,
		id: Type.Optional(
			Type.String({ minLength: 1, description: "Returned ID of an existing task to retain; omit for a new task." }),
		),
	},
	{ additionalProperties: false },
);

const taskUpdateFields = {
	revision: Type.Integer({ minimum: 1, description: "Current plan revision returned by get_plan." }),
	taskId: Type.String({ minLength: 1, description: "ID of the task to update." }),
	name: Type.Optional(
		Type.String({ minLength: 1, description: 'Change the task title (imperative form, e.g., "Run tests")' }),
	),
	description: Type.Optional(Type.String({ minLength: 1, description: "Change the task description" })),
	order: Type.Optional(taskCreateSchema.properties.order),
	acceptance: taskCreateSchema.properties.acceptance,
	paths: taskCreateSchema.properties.paths,
};

export const taskUpdateSchema = Type.Object(
	{
		...taskUpdateFields,
		status: Type.Optional(
			Type.Union(
				[
					Type.Literal("pending"),
					Type.Literal("running"),
					Type.Literal("done"),
					Type.Literal("failed"),
					Type.Literal("superseded"),
				],
				{ description: "The task status (see Status Workflow below)" },
			),
		),
		output: Type.Optional(
			Type.String({ minLength: 1, description: "Required when status is done. Summarize the completed result." }),
		),
		error: Type.Optional(Type.String({ minLength: 1, description: "Required when status is failed." })),
		reason: Type.Optional(Type.String({ minLength: 1, description: "Required when status is superseded." })),
	},
	{ additionalProperties: false, minProperties: 3 },
);

export const planSchema = Type.Object({
	objective: Type.String(),
	revision: Type.Integer({ minimum: 1 }),
	reason: Type.String(),
	tasks: Type.Array(
		Type.Object({
			spec: Type.Object(
				{ ...taskCreateSchema.properties, id: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
			state: Type.Union([
				Type.Object({ status: Type.Literal("pending") }),
				Type.Object({ status: Type.Literal("queued") }),
				Type.Object({ status: Type.Literal("running") }),
				Type.Object({
					status: Type.Literal("done"),
					output: Type.String(),
				}),
				Type.Object({ status: Type.Literal("failed"), error: Type.String() }),
				Type.Object({ status: Type.Literal("superseded"), reason: Type.String() }),
			]),
		}),
	),
});
