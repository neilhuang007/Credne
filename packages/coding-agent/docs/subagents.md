# Subagents

The built in `subagent` tool delegates work to isolated child processes. It includes four agent definitions: `explorer`, `worker`, `critic`, and `crazy`. An installed extension that registers `subagent` replaces the built in extension.

Bundled definitions have the lowest priority. User definitions in the agent configuration directory override matching bundled names. With `agentScope: "both"`, project definitions override user definitions too. `agentScope: "project"` loads bundled and project definitions; the default `"user"` loads bundled and user definitions.

## Model tiers

Each bundled profile carries a default capability tier: `light`, `medium`, or `heavy`. The harness maps the tier to a model and a reasoning effort on the current serving account, so the main agent usually does not choose a model. It passes `tier` only when a task is clearly easier or harder than its profile assumes.

| Profile | Default tier | Meant for |
| :--- | :--- | :--- |
| `explorer` | `light` | Searching and returning information, not reasoning about solutions. |
| `worker` | `medium` | Implementation within the assigned scope. |
| `critic` | `heavy` | Reviewing the current diff. |
| `crazy` | `heavy` | Extremely hard tasks and deep research. Supply the relevant context, references, constraints, and a focused question. |

A tier maps to these models, written as [family aliases](#model-aliases), and efforts:

| Provider | `light` | `medium` | `heavy` |
| :--- | :--- | :--- | :--- |
| `anthropic` | `haiku` at `medium` | `opus` at `xhigh` | `fable` at `xhigh` |
| `openai` | `luna` at `medium` | `sol` at `xhigh` | `astra` at `xhigh` |
| `xai` | `grok` at `low` | `grok` at `high` | `grok` at `xhigh` |
| `meta` | `ember` at `medium` | `spark` at `xhigh` | `wonder` at `xhigh` |

A row applies only when the current account serves its model. A Claude account therefore gets the Anthropic row and a ChatGPT account the OpenAI row, so the child usually comes from the same family as the main agent. xAI has one current model, so its tiers differ only in effort. A tier that has no row the account serves, such as any tier on an account that serves only DeepSeek or Gemini models, is skipped and never causes an error: the next source below applies.

The child's model comes from the first of these that applies:

1. `model` in the call.
2. `tier` in the call.
3. The profile's `model`.
4. The profile's `tier`.
5. The main agent's model on the current account.

The effort comes from `reasoningEffort` in the call when it is set. An effort the selected model does not support is rejected. Otherwise a model that a tier selected uses the tier's effort, moved to the nearest level the model supports. In every other case the child inherits the main agent's effort, adjusted to the model's supported levels. For example, `tier: "heavy"` on an account serving `claude-fable-5-2` starts the child on that model at `xhigh`, and an explicit `model` ignores the tier together with its effort.

A user or project agent sets its default with a `tier: light`, `tier: medium`, or `tier: heavy` line in its frontmatter. Any other value is ignored and the agent still loads. A profile `model` is more specific than its tier and wins over it.

The mapping is the source file `src/extensions/subagent/model-tiers.json` of the coding agent package: a list of `{ "provider", "tier", "alias", "effort" }` rows. `alias` names a row of `model-aliases.json` for the same `provider`. The rows of a tier are tried in file order, and the first whose model the account serves wins. The file is compiled into the build, so a change needs a rebuild. Only `anthropic` and `openai` have rows; accounts of other vendors inherit the main agent's model until rows are added.

Use `search_models` to see which models an account serves, or to choose a model explicitly.

### Tier classifier

A profile's tier is a fixed guess. The `worker` profile is `medium`, so a one-line rename and a redesign of the cache both run on the `medium` model unless the main agent notices the difference and passes `tier`. The tier classifier lets the harness notice instead: before a subagent is dispatched, a cheap model rates the task as `light`, `medium` or `heavy`, and the rated tier can replace the profile's tier. It is on by default and works on every setup: it uses a classifier model when one is available, and otherwise asks the light-tier chat model of the current account, which can also rate a reasoning effort.

Set `subagents.tierClassifier` in [settings](settings.md#subagents):

| Value | Behavior |
| :--- | :--- |
| `off` | No rating. |
| `shadow` | Rate and record the result, but dispatch exactly as with `off`. Use it to measure the rating before trusting it. |
| `apply` | Rate and record, and dispatch with the rated tier, and the rated effort when there is one (see [the rule](#the-rule)). This is the default. |

**Two backends.** The *decision* backend asks a classifier model one score question and reads the probability of each level; it rates the tier only. The *chat* backend asks a chat model for a tier and a reasoning effort as one JSON object, `{"model": "heavy", "effort": "xhigh"}`. The decision backend is used whenever a classifier model is available. The chat backend is used only when the mode is not `off` and no classifier model is available, which is the case for a setup with neither an OpenAI API key account nor a Jev key. One task is never rated by both.

**When it runs.** For each task, only when all of these hold: the mode is not `off`; the call passed neither `model` nor `tier` for the task, on the task or at the top level; and the agent profile does not pin a `model`. A task with its own `model` or `tier`, or a profile with a `model`, is never rated. A profile without a tier is rated like any other, and in `apply` mode the rated tier takes the place of "inherit the main agent's model". With `subagent`, the items of `tasks` and `chain` are rated at the same time, after any project agent approval and before the first one starts. A `chain` step is rated before its predecessors have run, so its `{previous}` placeholder is still in the task text. `assign_tasks` rates each task of the call on its own, so two tasks of one call can run at different tiers; a `model` or `tier` on the `assign_tasks` call, or `--planning-model`, applies to every task of the call and skips the rating.

**Which classifier.** The classifier models available to the session, with working credentials (see [classifier models](models.md#use-classifier-models)). `gpt-6-luna` is preferred, then a model whose ID contains `jev`, then the first other model. There is no setting for this. With none available, the chat backend rates instead.

**Which chat model.** The light-tier model of the current serving account, found the way a `tier` is (see [Model tiers](#model-tiers)): `haiku` on a Claude account and `luna` on a ChatGPT account. It is asked for the lowest reasoning level it supports and for at most 100 output tokens. It starts no subagent, and its own request is not rated. If the account has no light-tier row, or a pool's serving account is not known yet, nothing is rated: no request is sent, nothing is recorded, and the profile's tier applies.

**The question.** The decision backend asks one `score` question, "How demanding is `task`?", with three levels in this order. The wording is the `tierLevels` list at the top of `src/extensions/subagent/tier-classifier.ts`, and a person should review it:

| Level | Tier | Description sent to the classifier |
| :--- | :--- | :--- |
| 0 | `light` | Repeatable, well-defined tasks: exploring a codebase or database; searching files and the web; making small edits and extracting fields when the expected result is clear; classification and routing. |
| 1 | `medium` | Everyday coding: fixing bugs and adding features; working through multistep tasks that need testing and revision along the way. |
| 2 | `heavy` | Long-horizon agentic work: solving open-ended problems that require weighing trade-offs; planning and carrying out complex projects, adjusting the approach as new information comes in; reviewing written code to give strategic guidance or course correction. |

**The chat prompt.** The chat backend sends one system prompt and, as the only message, the state below serialized as JSON. The prompt reuses the three level descriptions above, so there is one source for them, and adds four effort descriptions. The effort wording follows Anthropic's effort guidance and OpenAI's model selection guide; it is `effortLevels` at the top of `tier-classifier.ts`, and a person should review it too.

```text
You rate a task that a coding agent is about to delegate to a subagent. Reply with one JSON object and nothing else, in this form: {"model": "heavy", "effort": "xhigh"}.

model is one of light, medium, heavy or default.
- light: <description of the light level above>
- medium: <description of the medium level above>
- heavy: <description of the heavy level above>

effort is one of low, medium, high, xhigh or default.
- low: Simple tasks.
- medium: Most workflows.
- high: Intelligence-sensitive work.
- xhigh: Complex or long-running tasks.

Answer default for a field when the task does not clearly fit one value.
```

**What is sent.** A classifier model's provider receives only the state below and the question. It does not receive the system prompt, the conversation, the agent profile or any other task. This matters when the session's own model comes from another provider: a Claude session with the `openai` classifier sends task text to OpenAI. The chat backend runs on the session's own account, so the task text stays with the provider that already serves the session. A Claude account sends it to Claude and no other provider receives it. The chat model gets the chat prompt and the same state, and nothing else.

| Call | State |
| :--- | :--- |
| `subagent` | `{ "task": "<task text>" }`, with the text cut to 16,000 characters. A subagent task must be self-contained, so nothing else is sent. |
| `assign_tasks` | `{ "objective": "<plan objective>", "plan": ["<step name>", ...], "task": { "name", "description", "acceptance", "paths" } }`. The objective is cut to 2,000 characters and the description to 16,000. `plan` lists the names of the plan's active steps in order, without descriptions. `task` holds the assigned step's own details; `acceptance` and `paths` appear only when the step has them. |

The state is the same for both backends: `task` is the field being judged, and `objective` and `plan` are background.

**The rule.** The decision backend rates the level with the highest probability. In `apply` mode it is used only when that level's probability is at least 0.7; below that the profile's tier applies. The threshold is on the probability of the level being acted on, not on the answer's `confidence` and not on the averaged score. The rated tier replaces the profile's default tier; it is not a tier chosen by the caller, so an explicit `model` or `tier` still wins. As for any tier, a rated tier the account has no row for falls through to the main agent's model.

The chat backend's answer has no probability, so the 0.7 threshold does not apply: in `apply` mode the answer is used as given, unless it is `default`.

- `model` is `light`, `medium`, `heavy` or `default`. A tier replaces the profile's tier like the decision backend's tier. `default` keeps the profile's tier.
- `effort` is `low`, `medium`, `high`, `xhigh` or `default`. An effort replaces the effort of the tier row that selects the child's model, moved to the nearest level the model supports; it is never rejected. `default` keeps the row's effort. The effort applies only when a tier row selects the model, which is the profile's tier or the rated tier. A profile without a tier and without a rated tier inherits the main agent's model and effort as before, and the rated effort is not used. It never applies when the call passed `reasoningEffort`, which still wins and is still rejected when the model does not support it.

For example, the `worker` profile is `medium`. The answer `{"model": "default", "effort": "low"}` starts it on the `medium` model at `low` instead of `xhigh`. The answer `{"model": "heavy", "effort": "default"}` starts it on the `heavy` model at that row's `xhigh`. With `reasoningEffort: "high"` in the call, both start at `high`. The decision backend rates no effort, so it never changes one.

**Reading the reply.** A model's output is untrusted input. The first JSON object in the reply is taken, so surrounding prose or a code fence is fine, and only the values listed above are accepted, in lower case. A missing field, another value or no object is a failed rating with reason `malformed`.

**Fallbacks.** The classifier never blocks or fails a dispatch. The decision backend has one deadline of three seconds, combined with the tool call's abort signal, covering the lookup of the classifier and all the ratings of a call, which run concurrently. A lookup that fails or runs into that deadline counts as no classifier, and the chat backend then runs, with its own deadline of five seconds, combined with the abort signal, for all the chat ratings of the call. A timeout, an error result, a rejected call, an aborted call and a missing or malformed answer all dispatch with the profile's tier and the tier row's effort; so does an answer without per-level probabilities. `gpt-6-luna`, Jev on TypeSafe's API, and chat models served through the `llama-cpp-classify` adapter (see [llama.cpp](llama-cpp.md#classification)) report per-level probabilities. A System One service that leaves them out is recorded as `no-level-probabilities` and nothing is applied.

**What is recorded.** Every rating and every failure is appended to the session as a custom entry of type `subagent-tier-classification`. It is not sent to any model. The entry holds the `backend` (`decision` or `chat`), the task's agent name, the profile's tier, the `provider/id` of the model that rated (a classifier model or the chat model, in `classifier`), the latency in milliseconds and the usage that model reported, and either:

- `outcome: "classified"` from the decision backend, with `tier`, the three level `probabilities`, the averaged `score`, and `applied`, whether the rated tier replaced the profile's tier;
- `outcome: "classified"` from the chat backend, with `tier` and `effort` as the model answered them, `default` included, and `applied`, an object `{ tier, effort }` that says which of the two were handed to the dispatch. The dispatch still applies its own rules to them, so a rated effort does not override `reasoningEffort`; or
- `outcome: "failed"` with `reason` (`timeout`, `aborted`, `error`, `malformed` or `no-level-probabilities`), a short `message` for errors, and the averaged `score` when the answer had no per-level probabilities.

The entry has no task text, objective or plan: the tool call already holds them.

To compare the rating with the tier that was used, read the entries of a session in `shadow` mode, where the tier used is always `profileTier`. This lists each rating next to it:

```bash
jq -c 'select(.type == "custom" and .customType == "subagent-tier-classification")
  | .data | {backend, agent, used: .profileTier, rated: .tier, effort, probabilities, reason}' session.jsonl
```

Rows where `rated` is `heavy` and `used` is `light` or `medium` are the tasks the rating would have moved up. Count how often the two agree and, for the decision backend, how often the rated level had a probability of at least 0.7 before switching to `apply`.

## Context and model controls

Single calls and individual items in `tasks` or `chain` accept these controls. An item overrides the corresponding top level value.

| Parameter | Meaning |
| :--- | :--- |
| `turn: 0` | Start fresh. This is the default. |
| `turn: -1` | Copy the latest safe conversation history from the current branch. |
| `turn: 3` | Copy history through checkpoint 3 from `get_subagent_context`. |
| `model` | Model ID, unique name, or [family alias](#model-aliases) such as `sol` on the current account. An explicit `provider/model` ID selects that route. Overrides the `tier` and the profile's model and tier. |
| `tier` | `light`, `medium`, or `heavy`: the [capability tier](#model-tiers) for this task. Defaults to the profile's tier. The harness picks the model and effort on the current account. Overrides the profile's model and tier. |
| `reasoningEffort` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, where supported by the selected model. Overrides the tier's effort. |

`get_subagent_context({})` lists chronological checkpoints on the current branch as `{turn, kind, preview}`. They include user messages, completed main agent responses, worker results, agent messages, completed local tasks, and named steps. The main agent marks a stage it completed itself with `checkpoint_context({name, description?})`, for example `name: "Documentation reviewed"`. Planning results and successful `task_update` completions create checkpoints automatically. Ordinary tool calls do not create checkpoints; selecting individual tool calls is not currently exposed.

Checkpoint numbers remain stable while that branch grows. A snapshot contains the history through the selected boundary, including the returned worker report rather than its entire private conversation. Selecting earlier context does not restore earlier working files. After switching branches, list checkpoints again.

Checkpoints wait for every result in their tool batch before becoming selectable. Several milestones in one batch share its completed boundary. The latest safe selection stops before an unfinished batch. Snapshots are captured when the task is submitted, including tasks that wait in the queue. Future main agent messages are delivered only when explicitly sent. Resuming a worker retains its own accumulated conversation.

For example, a context listing might contain:

```json
{
  "turns": [
    {"turn": 1, "kind": "user", "preview": "Build product search"},
    {"turn": 2, "kind": "step", "preview": "Documentation reviewed: Routing and storage contracts identified"},
    {"turn": 3, "kind": "task_result", "preview": "Task api, worker ...: completed."},
    {"turn": 4, "kind": "task_result", "preview": "Task docs completed: Documented the product search contract"}
  ]
}
```

`turn: 2` includes the documentation milestone; `turn: 4` also includes the API result and the documentation task completed by the main agent. A successful planning worker completes its task immediately. Later orders become ready when all earlier tasks are done. The result checkpoint records what the worker reported.

Omitting reasoning effort uses the tier's effort when a tier selected the model, and otherwise inherits the main agent's setting, adjusted to the selected model's supported levels. An explicitly unsupported effort is rejected. By default, broker workers use the account serving the parent. Selecting another model on the same pool still pins that account. An explicit different provider or account selects that route instead. Unknown parent affinity or a model unavailable on the parent account produces an error rather than silently choosing another account.

```json
{
  "agent": "worker",
  "task": "Implement the agreed API contract in src/api",
  "background": true,
  "turn": -1,
  "model": "sol",
  "reasoningEffort": "xhigh"
}
```

The model value above is a [family alias](#model-aliases). It resolves to the newest Sol model the current account serves. No account name is required. Omit `model` and `reasoningEffort` to use the profile's [tier](#model-tiers) instead, or pass `"tier": "heavy"` for a task harder than the profile assumes.

## Finding models

`search_models`, the worker coordination tools (`list_agents`, `send_agent_message`, `interrupt_agent`, `continue_agent`, `steer_agent`, `change_agent_model`), `get_subagent_context`, and `checkpoint_context` are active and callable from the start, but the main agent's requests leave their declarations out until its first `subagent`, `assign_tasks`, or `assign_task` call on the branch. That call, even a failed one, declares them from the next model call and lists them in its result. Workers declare their messaging tools from the start.

Call `search_models` when choosing a subagent model. It searches the same configured chat-model scope used by dispatch: the current serving account for a pool (for `pool:claude` and `pool:all`, the account that answered last), or the pinned account or provider otherwise. Discovery is on demand; model catalogs are not added to the system prompt or refreshed through per-turn hooks.

`search_models({})` returns a compact, cost-ranked shortlist of five models. Each compact model has an exact `provider/model` `id`, `reasoningEfforts`, `contextWindow`, and `cost` with `input`, `output`, and `cacheRead` rates. Costs are USD per million tokens. A zero input and output cost sorts after known prices because zero may mean unknown, not free. Cost is only a price signal, not a capability guarantee; prefer economical models for bounded work, then judge suitability from the task.

Use `detail: "full"` when you need the existing metadata such as display name, input types, maximum output tokens, or full cost tiers. Full metadata is also retained in the tool result's `details` in either mode. Search matches IDs and display names case-insensitively. Specify `sort: "name"` for alphabetical order or `sort: "cost"` for price order. `limit` defaults to five and can be increased up to 100; pass `nextOffset` as `offset` to fetch another page. For example:

```json
{"query": "luna", "detail": "full"}
```

Reuse a result while the parent model and serving account remain unchanged. Refresh discovery after a model/account change or a dispatch failure. For dispatch on the same account, pass the bare `modelId` portion of the exact result ID; do not pass its provider prefix, which can pin a pool result to an account that no longer serves the parent. To intentionally change routes, search with an explicit `provider` and pass a returned `provider/model` ID. Unknown pool affinity fails closed instead of silently selecting another account. The same selection rules apply to `assign_tasks`.

### Model aliases

A family alias is a short name for the newest model of a model family. Several generations of one family can be served together, such as `gpt-5.6-sol`, `gpt-6-sol`, `gpt-6.1-sol` and `gpt-6.2-sol`. Without an alias, `sol` matches all of them and fails as ambiguous. With the alias, `sol` selects `gpt-6.2-sol`.

A model reference is resolved in this order, within the models the current account (or the provider named in a `provider/model` reference) serves:

1. An exact model ID.
2. A family alias.
3. An exact display name, then a unique case-insensitive substring of the ID or display name.

An alias works wherever a subagent model is chosen: the `subagent` tool, `assign_tasks`, `change_agent_model`, an agent profile's `model`, and the rows of the [tier table](#model-tiers). Matching uses the model ID only, so one row covers the vendor's own provider, ChatGPT and Claude accounts, and pools, which all serve the vendor's model IDs unchanged.

| Provider | Alias | Model |
| :--- | :--- | :--- |
| `anthropic` | `fable` | `claude-fable-5-2` |
| `anthropic` | `opus` | `claude-opus-5-5` |
| `anthropic` | `sonnet` | `claude-sonnet-5-5` |
| `anthropic` | `haiku` | `claude-haiku-5-5` |
| `openai` | `astra` | `gpt-6.2-astra` |
| `openai` | `sol` | `gpt-6.2-sol` |
| `openai` | `terra` | `gpt-6.1-terra` |
| `openai` | `luna` | `gpt-6-luna` |
| `xai` | `grok` | `grok-4.7` |
| `meta` | `wonder` | `muse-wonder-1.0` |
| `meta` | `spark` | `muse-spark-1.3` |
| `meta` | `ember` | `muse-ember-1.0` |
| `deepseek` | `pro` | `deepseek-v4-pro` |
| `deepseek` | `flash` | `deepseek-flash` |
| `google` | `neon` | `gemini-4-neon` |
| `google` | `argon` | `gemini-4-argon` |
| `google` | `carbon` | `gemini-4-carbon` |
| `google` | `hydrogen` | `gemini-4-hydrogen` |
| `google` | `flash` | `gemini-3.8-flash` |
| `google` | `flash-lite` | `gemini-3.5-flash-lite` |

The table is the source file `src/extensions/subagent/model-aliases.json` of the coding agent package: a list of `{ "provider", "alias", "model" }` rows with lowercase aliases. It is compiled into the build, so a change needs a rebuild. When a new model ships, change the `model` of the family's row. `provider` is the vendor's catalog provider ID. It records who owns the family. Resolving an alias by name ignores it, but a tier row uses it to pick that vendor's row of an alias such as `flash`. An alias can have several rows, as `flash` does: rows are tried in file order, and the first whose model the account serves wins. Aliases are not discovered from the catalog, so a family without a row keeps using ordinary matching.

An alias whose target the current account does not serve is not an error. Resolution continues with ordinary name and substring matching. For example, `sol` on an account serving only `gpt-5.6-sol` and `gpt-6.1-sol` is still ambiguous. Use `search_models` to see which models an account serves.

## Background work

Set `background: true` when the main agent can continue without the result. Set `background: false` to wait for the results in the tool call. The general `subagent` tool defaults to `false`; planned `assign_tasks` calls default to `true`. Both modes use the same worker queue and return worker IDs that can be used for later communication and continuation.

```json
{
  "agent": "explorer",
  "task": "Find the routing module and describe its contracts",
  "background": true
}
```

For parallel tasks:

```json
{
  "tasks": [
    {"agent": "explorer", "task": "Inspect the routing module"},
    {"agent": "critic", "task": "Review the database changes"}
  ],
  "background": true
}
```

The call returns one worker ID per task immediately. Up to four runs are active across general subagents, planning workers, and continuations combined; remaining runs wait in submission order. Each background completion delivers the worker ID, result text, and usage as a follow up message. An idle main agent starts a turn to handle it. Background mode supports single and parallel calls; chains remain foreground operations. Foreground results also include worker IDs for later continuation.

`/subagents` opens the session picker for general and planning workers in the terminal UI (Enter shows the chosen session in the main view), or lists them in non-interactive modes. `/subagents cancel <id>` stops one worker permanently, and `/subagents cancel all` closes all workers. Active runs retain their slots until interruption settles. Queued runs that are cancelled never start. Session changes and shutdown stop child processes and suppress late notifications. Worker identities and conversations belong to the running parent session and are not restored after a restart.

## Communication and control

The main agent and workers can call `list_agents({})` and `send_agent_message({to, message})`. Use a worker ID as `to`, or `"main"` from a worker. The coordinator labels messages with the actual sending worker. Messages to a running main agent or peer enter its steering queue and arrive before the next model request, after the current tool batch finishes. A worker-to-main acknowledgement of `queued` means the coordinator accepted the message, not that the main agent has already read it. An idle main agent starts a turn to receive it. Messages to completed peers start a queued continuation when the assignment permits it. Interrupted workers retain messages until explicitly continued.

Only the main agent has these controls:

* `assign_task({revision, taskId, workerId, background?})` queues a ready planning task for an existing worker. A busy worker finishes its current run before reading the assignment notification. The queue preserves assignment order. `list_agents` reports `assignmentCount` separately from ordinary messages in `inboxCount`.
* `interrupt_agent({agentId})` stops the current run and retains its conversation and inbox.
* `change_agent_model({agentId, model, reasoningEffort?})` changes a settled or interrupted worker's model without replacing its conversation. Omitted effort preserves the worker's current setting, adjusted to the new model's supported levels. Use `search_models` to choose an available model. Interrupt a running or queued worker first, change its model, then explicitly continue it. Changing the model does not start a run.
* `continue_agent({agentId, prompt})` queues another run of that worker with the supplied instruction and its retained context.
* `steer_agent({agentId, prompt})` sends an instruction to a running worker at Pi's next steering boundary. It does not immediately stop a shell command.

For example, the API worker can send the UI worker `"The endpoint returns {items, nextCursor}; use nextCursor for pagination"`. The main agent can interrupt either worker, inspect the partial changes, and continue it with a correction. Messages do not grant permission to edit another worker's files. Planning workers must still satisfy the planner's execution order and worker limit when continued. Continuing completed work reopens affected results and is rejected if affected work is running.

If a worker process crashes or must be forcibly killed because it ignores interruption, that conversation cannot continue in the current process. Its result reports the failure. Inspect partial changes and assign the task to a new worker.

## Display and prompt caching

Below the prompt, a compact tree shows `main` and its workers. Worker names are bold, idle workers have an open circle, and running workers use the standard animated spinner. The right column shows status, model, agent type, reasoning effort, elapsed working time, token usage, cache hit rates, and cost, separated by ` • `. While the prompt has focus, at most three workers are shown, prioritizing running workers. A horizontally centered `Press down for more` hint shows how many additional workers are hidden and follows the configured `app.subagents.select` key. Short terminals show fewer rows so the prompt stays visible. Focusing the inline list expands it, and arrow navigation scrolls through every worker. `/subagents` opens the separate session picker, which also lists every worker. Narrow terminals truncate rows instead of wrapping them.

With an empty prompt and no autocomplete open, press **Down Arrow** to focus the inline agent list, initially on `main`. Use **Up/Down** to move through its rows. Press **Enter** on a worker to switch the main view to its retained conversation, and on `main` to switch back. **Up Arrow** from `main` or **Escape** collapses the list and returns focus to the prompt; typing also collapses the list and returns to the prompt. Hovering highlights either a worker or `main`. Click a worker to open it, or click `main` to return to the main session.

While a worker is shown, the chat area uses the same user-message, assistant, thinking, and tool formatting as the main chat, with live assistant output while it runs. The prompt takes the worker's color, its top border ends in an `@name` badge, and the empty prompt reads `Message @name…`. Text submitted from the prompt goes to that worker as a follow-up; sending to an interrupted worker explicitly resumes it. Slash commands still run in the main session. **Escape** in the prompt switches back to the main session. The transcript updates as worker messages arrive, and the main session keeps running and recording output while a worker is shown. When the inline list has focus, its selection arrow replaces the row's status icon; it does not add a column. Normal prompt cursor movement is unchanged when the editor contains text. Remap the shortcut with `app.subagents.select` in `keybindings.json`. Run `/subagents` when you want the explicit session picker.

Ordinary tool calls remain in the conversation. Foreground subagents retain their expandable results, and background completions and messages appear as labeled conversation messages.

Workers retain their subprocess and session between prompts. Continuations preserve the worker's model, reasoning effort, account, and conversation. Each worker receives a distinct session identity so provider continuation state cannot collide with its parent or peers. [Prompt caching](#prompt-caching) describes how matching workers share cached prefixes.

Every subagent uses its own agent file body as its system prompt, followed by the project instruction files and the working directory last. It receives neither the main agent's system prompt nor its documentation pointer or skills list. Agent prompt wording is preserved.

A fresh worker's initial user message contains only its task. With a selected conversation cutoff, its first text block contains a stripped reference conversation and its second block contains the task. Stripping removes system messages, thinking, failed provider attempts, and worker reports of provider failures such as exhausted credits or capacity errors. It preserves user messages, assistant text, ordinary tool and command failures, and worker execution failures. Tool calls retain their names and bounded arguments. Each retained tool output keeps its first 200 characters with the number of omitted characters. The wrapper is `<parent_conversation note="The main agent's conversation, given for reference. Tool outputs are shortened.">`. The same history produces identical text.

New planned workers use the bundled `worker` system prompt and its `medium` tier; `assign_tasks` accepts `model`, `tier`, and `reasoningEffort` for the whole batch. Assignments to existing workers preserve their original profile, tools, model, and conversation. Each assignment notification contains the objective, task details, and completed results from earlier orders. The full plan is included on its first delivery to a worker and again when its definition changes. A selected reference conversation precedes a new worker's assignment. Later assignments and continuations append prompts to the retained conversation.

Workers share the working directory with the main agent. Define task scope in descriptions and coordinate edits when delegating implementation. Use the [planning tools](planning.md) when work needs ordered phases or revisions. The general subagent tool reports results without changing planning task states.

## Prompt caching

Cache reuse requires an identical request prefix. Anthropic processes tools, system, and messages in that order. Subagents share prefixes with matching siblings. Reusing the main agent's cache is outside this design because each subagent needs its own system prompt and tools.

For example, three workers with the same profile, model, account, effort, project context, and conversation cutoff share their tools, system prompt, and stripped reference conversation. The first worker warms that prefix while beginning its task. Its siblings wait for provider response evidence, then submit their different tasks after the shared prefix.

* **Tools.** Each worker declares its agent's tools plus `list_agents` and `send_agent_message`, sorted by name. An unrestricted agent gets `read`, `bash`, `edit`, `write`, and `tool_search`. Subagents never declare delegation, planning, or main agent control tools. MCP schemas are discovered through `tool_search` rather than preloaded.
* **Stable content first.** Agent instructions remain in the system prompt. The stripped conversation, when present, precedes the task. Worker IDs, session IDs, and timestamps do not enter this shared content.
* **Cache key.** OpenAI requests use a deterministic `prompt_cache_key` derived from the provider, model, tools, system prompt, and reasoning configuration. Different tasks and conversation cutoffs keep the same routing key so they can reuse their common system prefix. The provider still matches the actual prefix tokens before reusing any cached work. Profile names alone do not split identical prefixes. Parent and worker session identities do not determine this key; transport sessions remain separate.
* **Breakpoints.** Anthropic requests mark the end of the system prompt and the end of the stripped conversation. The existing conversation tail marker supports the worker's own later turns. Marker placement stays within the provider's four breakpoint limit.
* **One initial writer.** Admission happens after each child builds its actual request. Matching siblings wait until the first provider response proves processing has reached response generation. The system prefix and each reference-conversation cutoff have separate warmup records: a new cutoff can reuse the system prefix while its own siblings wait for that longer prefix. A local stream startup event alone does not release them. If the leader fails without that evidence, one waiting sibling takes its place. Cancellation releases waiting work.

The first productive request performs the sibling warmup. This feature adds no speculative requests or recurring paid keepalive calls. The harness's separately configured cache warming remains unchanged. A separate Claude `max_tokens: 0` request would require nonstreaming transport and cannot preserve every supported thinking configuration; issuing it only when tasks arrive would add a request and delay useful work.

Native Anthropic requests through the account broker retain the worker's explicit markers. Workers select the broker's explicit caching mode so it does not add conflicting markers; native API routes consume that broker option before forwarding upstream. Claude subscription routes still apply the broker's Claude Code compatibility transformation. It relocates caller system content after the first user message and fingerprints that message in a billing header. Fresh tasks can therefore differ before the shared agent prompt reaches the upstream model. Inherited siblings can share the reference conversation, but the relocated agent prompt follows their different tasks. The harness does not change this subscription behavior, so exact native layout and sibling reuse are not guaranteed on that route.

Explicit sibling admission covers Anthropic Messages and OpenAI request families, including Codex, Azure, and compatible Chat Completions. Other provider adapters keep their existing caching behavior and benefit from the stable prompt layout, without this provider readiness gate.

Two explorers with the same instructions, tools, model, account, and effort can therefore share their system cache even when their tasks or selected checkpoints differ. The same applies to workers. An explorer and worker whose instructions differ cannot reuse the project context that follows that difference: caching requires a matching beginning, not matching text anywhere in the request. Sharing those later sections would require changing prompt order, which this implementation does not do.

Cache entries live at the provider, not in a local store of agent answers. Different pinned accounts do not share this cache, and pool routing can reduce reuse if requests land on different accounts. Provider cache lifetime, minimum prefix size, account scope, and capacity still apply. Short prefixes may report no cache activity even with valid markers. Changing tools or prompts changes their cache identity. The harness preserves the configured cache lifetime and does not pad or rewrite prompts to reach a token threshold. Provider usage is the evidence of a hit, rather than the existence of a key or marker.

### Cache hit rate

Every usage line with prompt tokens shows `CH`, the share read from the cache: `cacheRead / (input + cacheRead + cacheWrite)`. `first` is the same share for the worker's first request with reported prompt usage. It helps distinguish sibling reuse from reuse of the worker's own later conversation. Zero prompt tokens yield a zero rate. Totals divide the summed token counts, rather than averaging percentages.

```text
3 turns ↑1.2k ↓850 R58k W2.1k CH94.6% (first 96.2%) $0.0412 ctx:21k provider/model-id
```

Results carry both values as `usage.cacheHitRate` and `usage.firstCacheHitRate`. The details of a `subagent` tool result carry the sum over its workers as `usage`, without a first request share.

Usage includes configured cache refreshes that finish during the active run. Those refreshes add tokens and cost without adding task turns or changing the first request rate. A completed result is a snapshot of that run. Later idle refreshes do not rewrite the completed result. The parent session also records cumulative worker usage separately from model context, including idle refreshes, so the footer below the prompt combines the main agent and all workers across the entire session. Its price is the total recorded cost, and its `CH` is the weighted rate from all recorded input, cache-read, and cache-write tokens. Cumulative worker records replace earlier records for the same worker rather than adding them twice, and survive reopening the parent session.

See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Implementation source

The built in extension adapts the repository's [official subagent example](../examples/extensions/subagent/README.md), leaving the example folder unchanged. Planning and general subagents share the child process runner under `src/extensions/subagent/`.

The queue design was informed by [pi-fast-subagent's background job manager at commit 559cc175](https://github.com/tuansondinh/pi-fast-subagent/blob/559cc175447b25d1a162cf436875f0c60ac569be/background-job-manager.ts). The coordinator reuses the queue and Pi's RPC commands for retained subprocess sessions, interruption, steering, and continuation.
