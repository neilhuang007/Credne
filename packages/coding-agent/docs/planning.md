# Planning tools

The main agent owns the plan, updates individual tasks, and assigns tasks to new or existing workers. The permanent system prompt uses the supplied OpenAI planning instructions, with `update_plan` references adapted to Credne's planning tools. The first `enter_plan_mode` call on a conversation branch appends the plan examples as text in its tool response, alongside the current plan. Later calls return only the current plan snapshot. It does not add an approval gate or restrict editing. A small edit can still be completed directly.

To edit the prompts:

- Main system prompt and planning instructions: `MAIN_AGENT_PROMPT` in `packages/coding-agent/src/core/main-agent-prompt.ts`, adapted from `internal/context-management/oai-sys-prompt.md`. The adaptation uses Credne's identity and tools, omits unsupported Codex approval modes, and retains Credne's subagent policy.
- Examples returned on entering plan mode: `PLANNING_GUIDANCE` in `packages/coding-agent/src/extensions/planning/guidance.ts`.
- Concise task field descriptions: `packages/coding-agent/src/extensions/planning/schema.ts`. Plan-level parameters and tool descriptions are in `packages/coding-agent/src/extensions/planning/index.ts`.

The examples stay out of the permanent system prompt. API mechanics remain in tool descriptions and schemas rather than being duplicated in the plan-entry response.

The session records that examples have been shown, so reloads, resumes, compaction, and forks that inherit the entry do not insert them again. A new session or a branch before the first entry receives them on its first call. Starting another plan in the same conversation does not repeat them.

Task creation and update instructions are excerpts from the local Claude Code `TaskCreate` and `TaskUpdate` references, with `TaskGet` replaced by `get_plan`. Credne maps Claude's `subject` field to `name`. Execution order, success criteria, relevant paths, assignment notifications, and automatic worker completion are Credne additions whose essential semantics remain in the tool schemas.

`create_plan` records the objective and a flat list of tasks without starting workers. Its task list may be empty. Each task requires only `name`, `description`, and `order`. Use `task_create` to add a task and `task_update` to update individual fields or status. The main agent chooses which ready tasks to run through `assign_tasks` or `assign_task`.

```json
{
  "objective": "Add a searchable product catalog",
  "tasks": [
    {
      "order": 1,
      "name": "Product search API",
      "description": "Implement GET /products?q= returning {id, name, price} records. Keep this response contract consistent with the UI task."
    },
    {
      "order": 1,
      "name": "Product search interface",
      "description": "Build the search interface against GET /products?q= and the agreed {id, name, price} response contract."
    },
    {
      "order": 2,
      "name": "Verify the complete search flow",
      "description": "Verify the interface against the implemented API and report any contract mismatch."
    }
  ]
}
```

The example generates IDs `1`, `2`, and `3`. The main agent calls `assign_tasks` with the returned plan revision and `taskIds: ["1", "2"]`. Both tasks have order 1 and can run simultaneously. With `background: true`, the default, assignment returns immediately so the main agent can continue reasoning or revise other tasks. With `background: false`, the call waits for all assigned workers and returns their results and usage. At most four workers run at once in either mode.

Tasks with the same order may run together. Put a task alone in an order when it must run exclusively. Every task with a lower order must complete before a later order can start. Sequencing uses `order` alone. There are no `parentId` or `dependsOn` fields.

Optional creation fields are `acceptance` and `paths`. `acceptance` records success criteria. `paths` records relevant files or directories so workers can locate existing code without repeating exploration. These paths do not lock files or establish dependencies. The harness assigns and returns task IDs. Reuse a returned ID only when revising an existing task; omitting an ID creates a new task. Generated IDs are never reused within the plan, including after supersession. Without acceptance criteria, the description defines the required outcome.

Task descriptions define scope. Workers share the working directory, so the main agent must assess whether concurrent tasks will conflict and avoid editing files a running worker is changing. Scheduling checks task states, execution order, and the worker limit.

## Main agent tools

The tools below `enter_plan_mode` are active and callable from the start, but requests leave their declarations out until the conversation branch enters planning: the first `enter_plan_mode` call, or the first saved plan, declares them from the next model call. The revealing result lists them. A resumed branch with a plan or an earlier `enter_plan_mode` call declares them again.

* `enter_plan_mode({})` returns the plan examples only on first entry, plus the current plan snapshot on every call.
* `create_plan({objective, tasks})` records a plan without starting workers.
* `task_create({revision, name, description, order, acceptance?, paths?})` adds an individual task.
* `task_update({revision, taskId, name?, description?, order?, acceptance?, paths?, status?, output?, error?, reason?})` changes only the supplied fields. Arrays replace the previous values; empty arrays clear them. `done` requires `output`, `failed` requires `error`, and `superseded` requires `reason`. Assigned tasks must settle before they can be updated. Editing completed work can reopen later completed tasks.
* `get_plan({taskId?})` returns the current plan and ready task IDs. Select a task ID to inspect an individual result.
* `revise_plan({revision, reason, tasks})` replaces the active task definitions. Supply the complete desired active task list, retaining returned IDs for existing tasks. Use it to add tasks, revise descriptions or order, or supersede obsolete work.
* `checkpoint_context({name, description?})` marks a meaningful stage the main agent completed itself, such as documentation reviewed or design agreed. It records a context boundary without changing a planning task's state.
* `get_subagent_context({})` lists numbered context checkpoints with their kinds and previews. Worker results and successful `task_update` completions become checkpoints automatically.
* `assign_tasks({revision, taskIds, background?, model?, tier?, reasoningEffort?, turn?})` starts individual tasks and returns a worker ID for each task. `background` defaults to `true`; `false` waits for results. `model` is an exact `provider/id` selection. `tier` is `light`, `medium`, or `heavy` and replaces the `worker` profile's model and effort. `turn` is 0 for fresh context, -1 for latest safe history, or a positive checkpoint number from `get_subagent_context`. Controls apply to the selected batch; use separate calls for different controls.
* `assign_task({revision, taskId, workerId, background?})` queues an assignment notification for an existing worker, retaining its conversation, tools, model, and effort. A busy worker finishes its current run before processing the next assignment. Only ready tasks may be assigned.
* `cancel_tasks({revision, taskIds})` stops the selected workers and all their queued assignments. It waits for them to exit before their tasks can be assigned again.

The main agent can use `list_agents`, `send_agent_message`, `interrupt_agent`, `continue_agent`, and `steer_agent` with the returned worker IDs. Workers can send information to `"main"` or another worker ID. Interrupting retains the worker conversation; continuing rechecks task readiness and the worker limit. Continuing a completed task reopens it and affected completed work, and is rejected if affected work is running. Superseded, changed, or reassigned tasks cannot be resumed through an old worker ID. See [Subagent communication](subagents.md#communication-and-control).

```json
{
  "revision": 1,
  "taskIds": ["1", "2"],
  "background": true,
  "turn": -1,
  "reasoningEffort": "high"
}
```

An assignment response includes a mapping such as `[{"taskId":"1","workerId":"...","model":"provider/model","thinkingLevel":"xhigh"},{"taskId":"2",...}]`, with the model and reasoning level each worker was given. The plan remains separate from its worker conversations.

New planned workers use the bundled `worker` profile. Reused workers retain their original profile, so choose a worker with suitable tools. Each assignment contains the objective, task details, and completed results from earlier orders. The full plan definition is included the first time it is sent to a worker and again when the definition changes. Status changes alone do not resend it. Assignment notifications are appended as new prompts in the retained conversation when that worker reaches them. Include implementation context in the description and relevant paths in `paths`.

Foreground assignment waits for the first run of each assigned worker; later continuations remain separate runs. Aborting a foreground call cancels its assigned workers and waits for them to stop. An already aborted call starts no workers. Both modes record completion checkpoints and complete successful tasks directly. Background results and later continuations can wake an idle main agent; initial foreground results do not start an extra parent turn.

Use the latest revision returned by the tools. A stale revision is rejected rather than overwriting a worker result that arrived in the meantime.

After reading the architecture documentation, the main agent can call `checkpoint_context({name: "Documentation reviewed", description: "Routing and storage contracts identified"})`. On a subsequent call, `get_subagent_context` returns that milestone alongside conversation boundaries, worker reports, messages, and completed local tasks. A worker can inherit history through its checkpoint number. This selects conversation history, not an earlier version of the working files. See [Context and model controls](subagents.md#context-and-model-controls) for safe tool batch boundaries.

## Task status

Tasks have `pending`, `queued`, `running`, `done`, `failed`, or `superseded` status. Assignment sets `queued`, execution sets `running`, and a successful worker result sets `done`. When every task in an order is done, the next order becomes ready. Failed and interrupted runs remain unfinished. Ready tasks still need an explicit assignment.

For work performed in the main conversation, use `task_update` to set `running` before starting and `done` with an output summary after completing it. This also records a context checkpoint. `queued` is managed by assignment. There is no `review_task` tool; reopen work by setting its status to `pending`.

Revisions preserve unchanged tasks with retained IDs and reopen completed results in later orders when earlier work changes. Removed tasks remain in history as superseded. Queued and running worker tasks and the earlier orders they rely on cannot be changed until those assignments settle. Unrelated work in the same or later orders can be revised while workers run.

## Sessions and models

The current plan is stored in session entries and restored from the selected conversation branch. Queued or running tasks become failed on recovery and are never restarted automatically. Changing sessions or navigating the conversation tree stops active workers and their assignment queues.

Workers use the bundled `worker` profile's model and effort, `claude-opus-5-5` at `xhigh`, resolved on a Claude pool when the current account does not serve it (see [Profile model and effort](subagents.md#profile-model-and-effort)). `assign_tasks.model`, `assign_tasks.tier`, or `--planning-model provider/id` overrides that selection. Because the profile pins a model, the [tier classifier](subagents.md#tier-classifier) does not rate assigned tasks. The main agent controls `reasoningEffort` per assignment. Broker workers use the parent's serving account by default; an explicit different provider or account overrides this choice. Invalid model selections or unsupported explicit reasoning levels fail before any task starts. Worker processes disable planning and delegation tools while retaining peer and main agent messaging.

All workers share one queue with at most four active runs, including general subagents and continuations. Each retained worker also has an ordered assignment notification queue. `list_agents` reports its `assignmentCount` separately from ordinary messages in `inboxCount`.

Above the input, Credne shows a compact task list with bold task names. Pending and queued tasks show `☐`, running tasks show a spinner, completed tasks show `✓`, and failed tasks show `×`. Task status, ID, and execution order align on the right, separated by ` • `. The header summarizes progress and the plan revision. Short terminals prioritize running and unfinished tasks and summarize the remaining rows so the prompt stays visible. Detailed task states and worker IDs remain available through `get_plan`.

Below the input, assigned workers appear under `main` with right-aligned model, agent type, usage, and cache statistics. The collapsed list shows at most three workers and indicates how many are hidden. With an empty prompt and no autocomplete, Down Arrow focuses and expands the inline agent list; Enter on a worker opens its retained conversation without stopping other workers. Escape, or Up Arrow from `main`, collapses the list. Run `/subagents` to open the separate session picker. Worker messages and completions also appear in the main conversation.

The execution code comes from [Pi's official subagent example](../examples/extensions/subagent/README.md) and is shared with the built in subagent tool. The planner adds task ordering, revisions, individual task updates, assignment notifications, and automatic completion without installing another runtime package. The example folder remains unchanged.
