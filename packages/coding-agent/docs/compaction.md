# Compaction Reference

This reference describes automatic compaction, branch summarization, persisted entries, and extension hooks. For the user workflow, see [Sessions and Context](sessions.md#manage-conversation-context).

**Source files** ([pi](https://github.com/earendil-works/pi)):
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) - Auto-compaction logic
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) - Branch summarization
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts) - Shared utilities (file tracking, serialization)
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts) - Entry types (`CompactionEntry`, `BranchSummaryEntry`)
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) - Extension event types

For TypeScript definitions in your project, inspect `node_modules/@earendil-works/pi-coding-agent/dist/`.

## Overview

Pi has two summarization mechanisms:

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Compaction | Context exceeds threshold, the agent calls `compact`, or `/compact` | Summarize old messages to free up context |
| Branch summarization | `/tree` navigation | Preserve context when switching branches |

Both use closely related structured formats and track file operations cumulatively. Summarization requests disable prompt-cache writes because these one-off prompts are unlikely to be reused; the blocks strategy writes to the cache only where a later request of the same compaction reads it (see [Blocks Strategy](#blocks-strategy)).

## Compaction

### When It Triggers

Auto-compaction triggers when:

```
contextTokens > contextWindow - reserveTokens
```

By default, `reserveTokens` is 16384 tokens (configurable in `~/.pi/agent/settings.json` or `<project-dir>/.pi/settings.json`). It only decides when compaction starts. Summary requests use the model's output limit, reduced when needed so input and output fit the context window.

During a multi-turn agent run, Pi checks the canonical projected context after tools finish and their results are appended, before starting the next assistant response. If the threshold is crossed, Pi compacts during `prepareNextTurn`, then performs the existing catch-up steering poll before `turn_start`. It skips this between-turn check when the completed tool batch terminates the run and no queued message requires another response. Pi also checks before a new user prompt and performs final-attempt overflow recovery after the low-level run ends.

A provider context-overflow error or an early final `stopReason: "length"` can select one compact-and-retry recovery attempt. Length responses with tool calls retain their synthetic failed tool results and follow the ordinary tool/queue scheduler rather than forcing the run to end.

You can also trigger manually with `/compact [instructions]`, where optional instructions focus the summary.

### Agent-Initiated Compaction

Forced compaction runs wherever the agent happens to be. The built-in `compact` extension lets the main agent compact at a moment of its choosing instead, after finishing a step, so that new work starts in a fresh context window.

When free context (`contextWindow - contextTokens`) is at or below the remind threshold and compaction is enabled, Pi inserts a hidden `compaction-reminder` message and declares the `compact` tool, which takes one optional parameter, `instructions`. The threshold is the smaller of `remindTokens` (default 50000) and 20% of the context window. When that threshold is not above `reserveTokens`, Pi never reminds, because forced compaction would start first: with the default 16384 reserve, a 64k model is never reminded and a 200k model is reminded at 40000 free tokens. Pi reminds once per compaction. The reminder arrives with the next request and never starts or extends a run: at the start of a run it joins the run's starting messages, between turns it is appended after the turn's tool results, and after a final response it waits for the next prompt.

Calling `compact` requests compaction through `ctx.requestCompaction()`. Pi compacts before the agent's next response, with reason `"agent"`, and the run continues. If there is nothing to compact, the tool requests nothing and answers `Nothing to compact yet: the conversation is too short.` With `instructions`, the agent tells that compaction, under the headings `Focus`, `Next steps` and optionally `Remove`, which parts of the conversation to keep in detail, the immediate work that follows, and which context the current goal does not need; the blocks strategy follows them (see [Custom instructions](#custom-instructions)). The agent may also keep working; forced compaction at `reserveTokens` and `/compact` work as before. Every compaction withdraws the tool before the compaction entry records the tool state, so the compacted context does not declare it; a failed compaction gives it back. Reminders from before the latest compaction stay in the session but are left out of every request, so a reminder in the kept messages does not report the free context of before. Subagent workers get neither the reminder nor the tool.

The tool is not in the initial tool list and the system prompt does not change: the reminder activates the tool, so models that accept mid-conversation tool changes receive it as a later declaration and keep their cached prompt prefix. On models that cannot take a tool declaration in the middle of a conversation, revealing `compact` changes the top-level tool list and costs one prompt cache miss per compaction cycle, as it does for the planning and subagent tools.

### Blocks Strategy

By default (`"strategy": "blocks"`), the built-in `compact` extension replaces the single summary through `session_before_compact`. Set `"strategy": "summary"` to write the single summary described under [How It Works](#how-it-works) instead; Pi never switches to it on its own. The blocks strategy works on the model-visible entries since the previous compaction, in these steps:

1. **Clean**: failed tool calls other than `bash` and `powershell` commands, the agent's `compact` calls with their results, hidden messages and errors are removed, and so is the tool listing Pi appends to the result that reveals the subagent or planning tools. Subagent reports (worker result messages, worker messages to main, and the result of a delegating call that waited for its workers) are kept whole without their usage line. Each run of tool calls between two user inputs or other messages is condensed into a few lines: the agent's text from before the run's last call, then `[Read]` (files read with their line ranges, and searches), `[Edited]` (files edited with the changed lines, or written), one `[Ran]` per shell command with its output (`[Ran, failed]` for a command that failed, in the order the commands ran), one `[Delegated]` per delegating call with the report it waited for, `[Called]` (every other tool with its arguments), and last the agent's text after the last call. Of the tool outputs only shell outputs and those reports are kept. A worker's report, in the result of a delegating call that waited or in a worker result message, is followed by a `[Subagent edited]` line in the form of `[Edited]`: the files that worker changed with successful `edit` and `write` calls, and those its own workers' results list, collected from the worker's run when the run ended, whether it completed, failed or was aborted. There is no such line when the worker changed nothing, and none for results stored before the list existed. When one call ran several workers, each worker that changed files gets its own line, starting with its ID as the report names it, for example `[Subagent edited]: Worker 7f3a: src/parser.ts 1:80`. A delegating call whose result is an error, as a `subagent` call's is when one of its foreground workers failed or was aborted, is kept with its report and those lines when one of its workers changed files, and otherwise removed like any failed call. Texts over 8 lines or 600 characters are shortened: a `bash` or `powershell` output keeps its last 10 non-blank lines, any other custom message its last line; a shell command is kept up to 2,000 characters, and text sent to a worker (the `task` of a `subagent` call, at the top level and in each item of `tasks` and `chain`, the `message` of `send_agent_message`, and the `prompt` of `steer_agent` and `continue_agent`) up to 4,000 characters, each clipped beyond that and marked `<input truncated>`; any other tool input keeps its first line, and edits and writes show only their paths. In `[Read]` (files read, and the paths of searches and listings), `[Edited]` and `[Subagent edited]` lines, a path inside the project directory (the session's working directory) is shown relative to it with forward slashes, for example `src/parser.ts` for `/work/app/src/parser.ts` in project `/work/app`, and the directory itself as `.`; a path outside it keeps its full form. Paths are compared as the platform does, so on Windows either separator and any case match. The session entries keep the paths the tools were called with, and a worker's result stores each file it changed at its absolute path, a relative one resolved against the worker's working directory (see [Subagents](subagents.md)).
2. **Condense the user prompt**: a chat model updates the previous compaction's prompt with every user input since, into one prompt. It does not read the conversation. Each input comes with its context from the cleaned range: the last 1,500 characters of the agent's last text before it, the first 1,500 characters of the agent's first text after it, and the files the agent read, edited or wrote before the next input (at most 10), with their paths as step 1 shows them. The model uses the context only to understand what an input refers to. When the request would not fit the compactor's window, the context texts are shortened evenly; the inputs never are. It keeps requirements and decisions the agent already carried out, and drops one-time requests such as asking the agent to continue. When its request gets no usable reply after its retry, the user prompt is every user input so far in order, those stored by earlier compactions first, separated by blank lines and not rewritten; that text is also stored as the condensed prompt, and the compaction goes on.
3. **Slice**: the range is cut into blocks, each one request and the work done for it, by rules and without a model. A block starts only at the first entry of the range; at a user input sent while the agent was waiting, that is when the agent's last message before it made no tool call, was interrupted or failed, or there was none (an input typed into running work only steers it); at an agent message that hands work to a worker (a `subagent` call for the `worker` agent, or `assign_tasks` or `assign_task`; explorers, critics and other agents serve the current work); and at the next user input or agent message after a plan task is marked done. Commits, passing checks and reports coming back do not start a block: on real sessions they almost never began a new request. A cut that comes before the current block has an agent message is absorbed, so a request stays with the reply to it. Then a block under 2,000 tokens of the original conversation joins the block before it, since its account would be nearly as long as the block; the first block stays. Each block is numbered (`b1`, `b2`, ...); numbering continues across compactions.
4. **Condense blocks**: a chat model writes an account of each block from the user prompt and that block alone, and chooses how much detail the block needs to resume the user's task, including for the last block. There is no fixed target. Each account is limited to the character length of the cleaned block the model received, excluding the user prompt and request wrapper. If a reply exceeds that limit, Pi shortens it to fit and marks the cut with `…`. An empty block or a `(nothing to keep)` reply produces an empty account. Accounts tell what the agent did, the technical constraints or requirements the block uncovered, the decisions made and why, the errors and failed approaches, and the outcome. They name each file created or changed with its lines as the block's `[Edited]` line shows them, for example `(src/app.ts 111:112)`, and give the files of a `[Subagent edited]` line as that worker's work. Every block's request has the same system prompt, the writer's instructions followed by the user prompt, and a user message that holds only the block, so the requests share one prefix. With more than one block, the request for the shortest block is sent first, alone, and once it is answered the others follow, 8 at a time, so they can read that prefix from the prompt cache it wrote (described below). A block whose request gets no usable reply after its retry keeps its whole cleaned transcript as its account, counts as done in the progress, and the compaction goes on.
5. **Remove outdated statements**: each account is written from its block alone, so an early account can state something a later block changed, such as an old name or a design that was replaced later. A chat agent reads the record laid out as the summary lays it out: `User prompt:` with the condensed prompt, then `Agent transcript:` with `b<N>` over every non-empty account, those carried from earlier compactions and this compaction's, the last block's included. Its system prompt, based on Claude Code's memory consolidation prompt, asks it to remove statements that a later account contradicts and the work of blocks that was undone later, and to keep technical constraints, decisions with their reasons, errors with their resolution, and approaches that failed. It can only remove, through one tool, `remove`, whose one argument `text` is the exact text to delete. Like the `edit` tool, the text must match exactly once. It must lie inside the user prompt or inside one account; a match that takes in a heading or a `b<N>` line, or spans two accounts, does not count, since it would break the record's layout. Each tool result says whether the text was removed, did not match or matched more than once. After a removal only the whitespace where the text was is tidied: no doubled space, no space before punctuation, no blank line left behind. An account left empty is left out of the summary with its `b<N>` line, as every empty account is, and so is the `User prompt` part when the prompt is left empty. The agent may call the tool as often as it likes over at most 6 requests and ends with a text reply. The pruned prompt and accounts are what the summary shows and what the compaction stores, so later compactions start from them; the removed texts are stored as `removed`. The step is skipped when fewer than two accounts hold text, or, with custom instructions, when none does. When a request gets no usable reply after its retry, or the 6 requests run out, the removals already made are kept and the compaction goes on.
6. **Subagents and plan**: in the main session, each running or queued worker gets a two-sentence status card from its prompts and reports; the latest plan is listed with each task's status, name and ID. When a card's request gets no usable reply after its retry, the card is the latest prompt the worker received (its most recent task or steering text), clipped to 4,000 characters, and the compaction goes on.
7. **Next steps**: one chat request, started with step 4 and running alongside steps 4 to 6, writes what comes next. It is sent, as its one user message, what the main agent's context held, cleaned: the previous compaction's summary when there is one, then a blank line and every message since, rendered as in step 1 (the whole range the blocks are cut from), and no tools. Its system prompt is Claude Code's continuation-summary prompt for next steps: pending tasks the agent was explicitly asked to work on, the next step related to the most recent work, with verbatim quotes showing where it left off, blockers and open questions, and priority order. When the text is longer than the compactor's window allows (3 characters per token, 20,000 tokens left for the instructions and reply), the request holds the previous summary whole, since its next steps are the only record of a task pending before it and not mentioned since, then a blank line, the line `<block truncated>` and as many of the final messages and tool lines as fit the rest, each whole; only when the previous summary alone is too long is it left out. When the request gets no usable reply after its retry, or the reply is nothing but the heading, the part reads `Please compare the current work done with the intended task in the prompt, and finish anything left.` and the compaction goes on.
8. **Assemble**: the stored summary is the text below. It runs from the goal to the current state, then the history, then what comes next. A part with nothing in it is left out with its heading, and so is an earlier block whose account is empty.

```
Text from before compaction is no longer in your context. Before you quote it or show it again, read it again with the read_block tool.
Reread important files for reference and implementation when needed.

User prompt:
<condensed prompt>

Plan:
<plan>

Subagents:
<id> (<agent>, <status>): <card>

Agent transcript:
b1
<account>

b2
<account>

b3
<cleaned transcript>

Next steps:
<next steps>
```

The `read_block` reminder is left out where `read_block` is not registered, as in a subagent worker. The summary has no separate list of changed files: each account names the files its block created or changed, its workers' included, with their lines. The `Next steps` part holds the reply of step 7; when the reply opens with a line that only repeats that heading, such as `## Next Steps`, the line is dropped.

The agent transcript shows the account of every block so far, earlier compactions' blocks first, and ends with the last block of this compaction as its cleaned transcript: the text its account was written from (step 1), with the user's inputs, so the agent reads its most recent work as it happened. That entry takes at most 5% of the session model's context window, counted as 3 characters per token. When the cleaned transcript is longer, the entry is the block's account, a blank line, the line `<block truncated>`, and as many of the transcript's final messages and tool lines as fit the rest, each whole. When the block's account is its cleaned transcript, because its request failed, the account is left out, so the entry starts at `<block truncated>`. At the next compaction that block is no longer in the range, so its stored account is shown like the others, and new next steps replace the old ones, which step 7 reads as part of the previous summary.

No entry is kept. The compaction entry's `firstKeptEntryId` is empty, which matches no entry, so after the compaction the model sees the replayed system message, the summary as one user message, and only what came after the compaction. `keepRecentTokens` does not apply.

Every chat request uses one model, the compactor, chosen from the curated tier table of the current account that subagents use (see [Subagents](subagents.md)), never by price alone. It is the account's medium tier model of the session model's own family, the vendor the tier table files the session model under (`anthropic`, `openai`, ...), so a GPT session is never compacted by a Claude model or the other way round, even on a pool that serves both. The session model compacts when the account has no medium tier model of its family (or the tier table files it under none), when the session model is that model (the same model ID), or when the session model is cheaper than it (both input prices known; a price of zero means unknown, not free). When the session model is a broker pool that has not answered in this process yet, as in a new or resumed process before the first reply, the account serving it is not known; the compactor is then the medium tier model of the session model's family shared by the accounts the pool tries first for the session model (its enabled accounts that list the model, only the subscriptions among them when there are any), sent through the pool, and the session model compacts when those accounts have different medium tier models or none. Its context window may be smaller than the session model's, since no request reads the whole conversation: the inputs of steps 2 and 7 are fitted to the compactor's window, and a request that is still too long fails and falls back like any failed request. So on Anthropic, a session on the heavy tier model compacts with the medium tier model, and a session on the medium or light tier model compacts with itself. Every request runs at medium reasoning. Only requests whose prefix a later request of the same compaction reads write to the prompt cache, with the provider's short retention: the block requests when there is more than one block (step 4), and every request of the removal agent (step 5), whose later rounds resend the earlier ones. On Anthropic, Pi marks the end of the system prompt and the end of the newest user message as cache breakpoints, so a block request after the first reads the system prompt, with the user prompt in it, from the cache; on OpenAI and Codex, prompt caching works on the longest prefix the cache a request reaches has seen, so the requests of each of the two steps carry one prompt cache key of their own: `prompt_cache_key`, or through the account broker oh-my-pi's `promptCacheKey` with the broker's shared-prefix affinity, which also keeps them on one account of a pool (Claude through the broker gets only that affinity). OpenAI reads only a shared prefix of at least 1,024 tokens, so with a short user prompt the block requests can read nothing from the cache while the removal agent's later rounds do; OpenAI and Codex report no cache writes. The rewriter, the next steps and the cards run without cache writes, since nothing reads their prefix. The compaction's `usage` is the sum of all these requests, cache reads and writes included. A previous summary-strategy compaction is carried forward as block `b0`.

A chat request without a usable reply (rejected, stopped with an error or at the token cap, or blank) is sent once more after 5 seconds, since rate limits and overloads last for seconds; cancelling ends the wait at once. No request that fails again discards the compaction: the user prompt falls back to the user's inputs (step 2), a block to its cleaned transcript (step 4), the removal agent keeps the removals it made (step 5), a card falls back to the worker's latest prompt (step 6), and the next steps fall back to a fixed request to compare the work with the task (step 7). A compaction that fails otherwise fails like any failed compaction: nothing is stored, no summary is written in its place, Pi reports the error, and a reminded agent gets the `compact` tool back.

While it runs, the working indicator's place at the top left of the input box shows one line: the spinner, one progress bar for the whole compaction, the whole-number percentage of the whole compaction done, the current step with its count in brackets where it has one (`Cleaning the transcript`, `Condensing the user prompt`, `Slicing into blocks`, `Compacting blocks [5/12]`, `Removing outdated statements`, `Summarizing subagents [1/3]`, `Writing the next steps`), and the key that cancels it, for example a bar, `28% Compacting blocks [3/12]  escape to cancel`. The bar is drawn in solid cells like the usage-limit bars of `/accounts` and has one part per step, sized by how long the step usually takes, so it moves at an even pace: the user prompt 3, the block accounts 10, the removal 3, the subagent cards 1 (only when workers are running or queued at the start; a part for cards that are not written counts as done), and the next steps 3; cleaning and slicing take no noticeable time and have no part. Finished and skipped steps are in the accent colour and steps still to come in a muted one. The current step is yellow: solid for its finished share and shaded for the rest, so the solid cells are the share of the whole compaction done, and the percentage is worked out from the same parts. The counts cover the accounts and the cards, each counted once its text is settled, a fallback included. A step without a count makes one request, a few whose number is not known, or none, so its part stays shaded until it ends, and the spinner shows that it runs. The next-steps request, which runs alongside the counted steps, is not counted, and `Writing the next steps` shows while Pi waits for it. The bar is up to 50 cells wide; when it would get fewer than 20, the cancel key is left out first, then the end of the step's label is cut; the bar, the percentage and the count stay. While the line is shown in the border, the usage badge on its right is not drawn, so the line can use the whole border; the badge returns when the compaction ends. The side panel's `Compacting` section (opened with `/diff` or its toggle key) shows the key that cancels it, the same bar with the percentage, and the step with its count. The interrupt key (`app.interrupt`, Escape by default) cancels a blocks compaction as it cancels the summary: requests in flight are aborted, nothing is stored and the context stays as it was.

After the first blocks compaction, the `read_block` tool is declared and stays active. It takes a block number and an optional character `offset`, and returns the block's original entries rendered as a transcript, without cleaning, in pages of 20,000 characters. Block `b0` and unknown numbers return an error. The compaction entry stores `details` as:

```typescript
{
  strategy: "blocks";
  request: string;            // the condensed user prompt, or every user input joined when its request failed, as step 5 left it
  userMessages: string[];     // every user input so far, verbatim
  blocks: { number: number; firstEntryId: string; lastEntryId: string; text: string }[]; // every block so far, the last included, accounts as step 5 left them
  borders: {                  // one per cut of this compaction's range, before small blocks joined
    firstEntryId: string;
    kinds: string[];          // what placed the cut: "start", "user", "dispatch" or "plan"
    tokens: number;           // estimated tokens of the original conversation up to the next cut
  }[];
  models: { compactor: string }; // as provider/id
  removed?: string[];         // the texts step 5 removed, in order; absent when the step was skipped
  instructions?: string;      // the custom instructions the compaction followed; absent without any
}
```

A cut in `borders` whose `firstEntryId` starts no block in `blocks` was joined to the block before it. Entries stored by earlier versions also hold a `score` and a `source` per border, other kinds, `models.classifier`, `models.writer`, and `changedFiles`; they are still read.

#### Custom instructions

A compaction can carry custom instructions, one-time and for that compaction only: the text after `/compact`, or the `instructions` argument of the agent's `compact` call. Instructions that are empty or only whitespace count as none. The block writers (step 4), the removal agent (step 5) and the next-steps agent (step 7) each get them as a block in their system prompt, after its instructions and, for the block writers, before the user prompt: a sentence on how to follow them, then the heading `## Compact Instructions` and the instructions. The block writers are told to keep everything the instructions name to keep, the removal agent to remove what they name to remove and stay away from what they name to keep, and the next-steps agent to include their next steps exactly. The user prompt (step 2) and the cards (step 6) get nothing. With instructions, step 5 runs whenever an account holds text. The agent's `compact` call is removed in step 1, so its instructions reach the agents only through those blocks. Pi holds a call's instructions until the compaction it requested starts, before the agent's next turn, and forgets them then, or when the run ends without that compaction; a compaction that is cancelled or fails does not keep them. The compaction stores them as `instructions`. With `"strategy": "summary"`, `/compact` instructions focus the summary as before, and the agent's are not used.

### How It Works

1. **Find cut point**: Walk backwards through the finalized session projection, accumulating token estimates until `keepRecentTokens` (default 20k, configurable in `~/.pi/agent/settings.json` or `<project-dir>/.pi/settings.json`) is reached
2. **Extract messages**: Collect projected messages from the previous kept boundary (or session start) up to the cut point
3. **Generate summary**: Call LLM to summarize with structured format, passing the previous summary as iterative context when present
4. **Append entry**: Save `CompactionEntry` with summary and `firstKeptEntryId`
5. **Rebuilds context**: Session rebuilds the context for the next request, using summary + messages from `firstKeptEntryId` onwards

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

On repeated compactions, the summarized span starts at the previous compaction's kept boundary (`firstKeptEntryId`), not at the compaction entry itself, falling back to the entry after the previous compaction if that kept entry cannot be found in the path. A retain-none compaction records its own ID as `firstKeptEntryId`; repeated compaction starts after that entry. This preserves messages that survived the earlier compaction by including them in the next summarization pass as well. Pi also recalculates `tokensBefore` from the rebuilt, context-edited session projection before writing the new `CompactionEntry`, so the token count reflects the actual pre-compaction context being replaced. Omitted raw entries remain stored but do not affect cut selection, summaries, checkpoints, or token estimates.

### Overflow and Length Recovery Ordering

Recovery preserves the existing lifecycle and queue order. The completed attempt remains visible to `turn_end` and `agent_end`; post-run recovery then repairs persisted model context before a fresh retry:

```text
persist final assistant response
→ extension/public turn_end
→ extension/public agent_end
→ append context_edit omissions for the selected attempt
→ for overflow/length: run session_before_compact and append compaction on success
→ start the retry as a fresh run
```

If recovery compaction fails or is cancelled, Pi keeps the omission edits, appends no compaction, and schedules no internal retry. Existing queued work remains governed by ordinary steering and follow-up rules. `agent_before_settle` sees the repaired projection after recovery processing. Raw transcript history, exports, billing totals, and history-search extensions can still inspect the omitted attempt.

### Split user-message spans

A user-message span starts with a user message and includes all turns until the next user message. Normally, compaction cuts at user-message boundaries.

When one user-message span exceeds `keepRecentTokens`, the cut point lands within that span at an assistant message. This is a split user-message span:

```
Split user-message span (one span exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no earlier user-message spans)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

For split user-message spans, Pi generates two summaries and merges them:
1. **History summary**: Previous context (if any)
2. **User-message-span prefix summary**: The early part of the split user-message span

### Cut Point Rules

Valid cut points are:
- User messages
- Assistant messages
- BashExecution messages
- Custom messages (custom_message, branch_summary)

Never cut at tool results (they must stay with their tool call).

Preparation advances the kept boundary into a context-invisible suffix only when that suffix contains an omitted assistant attempt and no unomitted context-producing entries. Recovery `context_edit` omissions satisfy this rule; intrinsically context-invisible metadata may coexist with them. Metadata alone and newly appended custom messages do not move the cut. A replacement edit affecting the candidate input or summarized prefix also blocks advancement because the omitted assistant answered the pre-edit input; replacements of suffix entries that are ultimately omitted remain safe. This allows an over-budget recovered input to be summarized while retaining the edits that keep the abandoned attempt omitted, without making bookkeeping change whether new model input is preserved verbatim.

### CompactionEntry Structure

Defined in [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  tokensAfter?: number; // estimated context tokens right after the compaction
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store any JSON-serializable data in `details`. The default compaction tracks file operations, but custom extension implementations can use their own structure. Generated and extension-provided summaries store their LLM `usage` when available so session totals include summarization work.

See [`prepareCompaction()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) and [`compact()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) for the implementation. For direct programmatic summarization, `generateSummary()` returns the summary text and `generateSummaryWithUsage()` returns `{ text, usage }`.

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, Pi offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### Cumulative File Tracking

Default compaction and branch summarization track files cumulatively. Both extract file operations from tool calls in the messages being summarized. Compaction also carries file lists from the previous Pi-generated compaction. Branch summarization carries file lists from Pi-generated branch summaries in the entries it summarizes.

File tracking therefore accumulates across default compactions and nested default branch summaries. Pi does not automatically carry file lists from extension-generated summaries whose `fromHook` field is `true`; extensions manage their own `details` format.

### BranchSummaryEntry Structure

Defined in [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  fromId: string;      // Entry we navigated from
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Same as compaction, extensions can store custom data in `details`.

See [`collectEntriesForBranchSummary()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), [`prepareBranchEntries()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), and [`generateBranchSummary()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) for the implementation.

## Summary Format

Both formats include Goal, Constraints & Preferences, Progress, Key Decisions, and Next Steps. Compaction summaries also include Critical Context. Branch summaries stop after Next Steps. Pi appends file lists to either format when relevant.

Compaction summaries use this format:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### Message Serialization

Before summarization, messages are serialized to text via [`serializeConversation()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts):

```
[User]: What they said
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Thinking blocks are omitted. Providers return summaries of the real reasoning, and replayed thinking is often not part of the model's live context, so including it could make the summarization request larger than the context it summarizes.

Tool results are truncated to 2000 characters during serialization. Content beyond that limit is replaced with a marker indicating how many characters were truncated. This keeps summarization requests within reasonable token budgets, since tool results (especially from `read` and `bash`) are typically the largest contributors to context size.

## Custom Summarization via Extensions

Extensions can intercept and customize both compaction and branch summarization. See [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) for event type definitions.

### session_before_compact

Fired before auto-compaction or `/compact`. Can cancel, fail, or provide a custom summary. See `SessionBeforeCompactEvent` and `CompactionPreparation` in the types file.

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - user-message-span prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - effective settings after applying model overrides

  // branchEntries - all entries on current branch (for custom state)
  // reason - "manual" (/compact), "threshold", "overflow", or "agent" (ctx.requestCompaction())
  // willRetry - whether the aborted turn is retried after compaction (overflow recovery)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Fail: nothing is stored and no summary is generated. A handler that throws fails the same way.
  return { error: "What went wrong" };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage, // Optional; included in session totals
      details: { /* custom data */ },
    }
  };
});
```

#### Converting Messages to Text

To generate a summary with your own model, convert messages to text using `serializeConversation`:

```typescript
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant]: response text
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const { summary, usage } = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage,
    }
  };
});
```

See [custom-compaction.ts](../examples/extensions/custom-compaction.ts) for a complete example using a different model.

### session_compact_failed

Fired when manual or automatic compaction fails or is aborted. This is useful for telemetry extensions that need to pair `session_before_compact` attempts with terminal outcomes.

```typescript
pi.on("session_compact_failed", async (event, ctx) => {
  const { reason, errorMessage, aborted, willRetry, fromExtension } = event;
  // reason - "manual" (/compact), "threshold", "overflow", or "agent" (ctx.requestCompaction())
  // errorMessage - present for non-abort failures
  // aborted - true for canceled/aborted compactions
  // willRetry - whether the aborted turn would have retried after compaction
  // fromExtension - whether extension-provided compaction content was being used, or a handler failed the compaction
});
```

### session_before_tree

Fired before `/tree` navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        // usage: summaryResponse.usage, // Optional; included in session totals
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

## Settings

Configure compaction in `~/.pi/agent/settings.json` or `<project-dir>/.pi/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "remindTokens": 50000,
    "strategy": "blocks"
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable auto-compaction |
| `reserveTokens` | `16384` | Free context tokens below which auto-compaction starts |
| `keepRecentTokens` | `20000` | Recent tokens to keep (not summarized) by the `"summary"` strategy |
| `remindTokens` | `50000` | Free context tokens below which the agent is reminded that it can compact, capped at 20% of the context window; no reminder when the cap is not above `reserveTokens` (see [Agent-Initiated Compaction](#agent-initiated-compaction)) |
| `strategy` | `"blocks"` | `"blocks"` condenses the conversation block by block, shows the last block's cleaned transcript and the next steps, and keeps no message; if it fails, the compaction fails (see [Blocks Strategy](#blocks-strategy)). `"summary"` writes one structured summary |

Disable auto-compaction with `"enabled": false`. This also stops the reminder that offers the agent the `compact` tool. You can still compact manually with `/compact`.

### Per-model overrides

Use `compaction.modelOverrides` to tune token budgets for different models:

```json
{
  "compaction": {
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "some-provider/big-model": {
        "reserveTokens": 400000
      }
    }
  }
}
```

For a model with a 1M context window, this override triggers compaction above 600K tokens and keeps the ordinary 20000 recent tokens. Other models retain the ordinary 16384-token reserve.

Keys are exact, case-sensitive `provider/modelId` values, including any slashes within the model ID. Each `reserveTokens`, `keepRecentTokens`, and `remindTokens` value falls back independently from the model override to the ordinary setting to the built-in default. Values must be non-negative safe integers. Invalid values in the matching model override produce an error when read; only omitted fields fall back to the ordinary setting. Model override entries must be objects. Invalid ordinary token settings produce an error when read, even if the active model has a valid override. Only omitted ordinary values use built-in defaults. `enabled` remains global, not model-specific.

These resolved values are used for manual compaction, all automatic threshold checks, overflow recovery, and extension-visible `preparation.settings`. Model switches affect subsequent checks and compactions without changing ordinary settings. Compaction already in progress uses the model and settings captured for that operation. Branch summarization settings are unaffected.

Overrides work in both global and project settings. The files merge recursively before lookup, so a global model-specific value beats a project-wide fallback; a project must override that model entry to change it. See [Settings](settings.md#per-model-compaction-overrides) for details.
