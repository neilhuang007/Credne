# Multiple Accounts

The built-in `accounts` extension connects several accounts per provider, for example two Claude subscriptions, a Claude API key and a ChatGPT subscription. Two terminals can use different accounts at the same time. Claude and ChatGPT subscriptions, Anthropic API keys and OpenAI API keys all authenticate and send requests through `credne-broker`, a shared Bun daemon backed by [oh-my-pi AI](https://github.com/can1357/oh-my-pi/tree/main/packages/ai). Credne keeps sessions, prompts, tools and the agent loop; oh-my-pi owns every provider request. The daemon design is described in `broker/README.md` in the repository.

## How requests are sent

Credne does not build provider requests. It posts each chat request to `/credne/v1/route/<target>/pi/stream` in oh-my-pi's own pi-native protocol, the one oh-my-pi's client uses to reach its auth gateway. The body holds the model ID, the system prompt, the messages with their earlier reasoning and signatures, the tool declarations, and the request options: reasoning level, output limit, temperature, session ID, cache retention and similar. oh-my-pi then reshapes the request for the account's provider (for a Claude subscription, Claude Code's request shaping), authenticates it and sends it. It streams its own events back, which Credne shows as an ordinary reply: text, reasoning and tool-call deltas, token usage with cache reads and writes, and the stop reason.

The session ID keeps one conversation on one pool account, so its prompt cache stays warm. Connection settings that apply to the hop between oh-my-pi and the provider (timeouts, retries, WebSocket preferences) are oh-my-pi's to decide and are not sent. Costs in the footer and the accounts panel are priced from Pi's catalog entry for the model and the token counts oh-my-pi reports.

## Setup

Build the daemon with Bun 1.4.4 or newer and put it in Pi's bin directory or on `PATH`:

```bash
npm --prefix broker run build
mkdir -p ~/.pi/agent/bin
cp broker/dist/* ~/.pi/agent/bin/
```

Pi discovers the daemon through `broker.json` in the accounts directory. If none is running, Pi starts it detached. Concurrent starts share one daemon, and it outlives the Pi process that started it. The daemon stops after 30 minutes without requests and starts again on the next one. Set `PI_ACCOUNTS_BROKER` to use a binary elsewhere. Installed Credne distributions include the executable and do not need Bun installed. Claude subscriptions also need the daemon.

Stop a previous-version broker before starting this version. If the previous backend is incompatible, Credne reports its process ID instead of reusing it or starting a second daemon beside it.

With no accounts configured, the extension registers no providers. Open `/accounts` to add one, or run `/accounts add`. If managed accounts already exist but the local model catalog is missing, opening `/accounts` starts the broker and rebuilds the catalog.

## Adding accounts

Run `/accounts add`. Choose `Claude account`, `ChatGPT account`, or `Other providers` to browse additional methods advertised by the installed broker. `/accounts add <provider-id> [api-key|oauth]` opens a provider directly. The list reflects OMP methods that Credne can actually enroll and route; it is not the full upstream OMP catalog. Choose by how you pay for the models:

| Account | Way | What you do |
| --- | --- | --- |
| Claude | `Subscription (Pro, Max, Team sign-in)` | Sign in with your claude.ai account in the browser. The broker stores and refreshes the sign-in. |
| Claude | `API key (Anthropic Console key)` | Name the account, then paste an Anthropic API key. |
| ChatGPT | Subscription | Sign in with your ChatGPT account in the browser. |
| ChatGPT | `API key (OpenAI API credits)` | Name the account, then paste an OpenAI API key. Requests use the official OpenAI API with that project's API billing. |

Escape in the method menu returns to the family menu; Escape there cancels. `/accounts add claude` and `/accounts add chatgpt` open their respective menus. Skip the menu with `/accounts add claude-subscription`, `/accounts add claude-api-key`, `/accounts add codex`, or `/accounts add openai-api-key`.

OpenAI API keys are registered as `openai-api` accounts with kind `api-key`. They use the official OpenAI API and never authenticate through Codex. Their family pool is `pool:openai`; ChatGPT subscription accounts stay in `pool:codex`.

The broker rejects a second account with the same API key (including keys in `config.yaml`) or the same name. Signing in again to a subscription that is already in the broker renews its sign-in, keeps its `disabled` setting and reports that no account was added. A subscription and an API key are separate accounts with separate limits.

For browser sign-in, Credne opens the page and also shows the link, so you can open it yourself. If oh-my-pi asks you to acknowledge a subscription sign-in risk, Credne shows its warning and waits for explicit confirmation before opening the browser. Declining cancels sign-in. The redirect is normally received automatically. If the browser shows an error after sign-in, or Credne runs on another machine than the browser, copy the full redirect URL from the browser and paste it into the prompt. Sign-in times out after five minutes.

The API-key prompt shows the key while you type, because extension dialogs have no masked input. The broker checks the key by listing its models before it stores the account, so an invalid key is rejected and nothing is saved.

When you add your first chat account and no model is selected or configured, Credne offers to use a model on that account as the default for new sessions. Adding another account doesn't change an existing selection.

## Upgrading from local Claude subscriptions or Console credits

If you used a `claude-sub:<id>` provider, sign in again with `/accounts add claude-subscription`, then use `/accounts switch` to choose the broker account or `pool:claude`. Credne does not read, migrate or delete the old `~/.pi/agent/accounts/claude-subscriptions.json` file. Broker-managed Claude subscriptions are listed as `acct:<id>`, like other accounts.

Claude Console browser sign-in (`/accounts add claude-api-credits`) is no longer supported. Existing Console credentials are left untouched and are not used by the broker. To use Anthropic's API, add a Console API key with `/accounts add claude-api-key`.

## Accounts and providers

In Credne, `/model` normally shows the model rather than one copy per account, as one row per model alias (`fable`, `astra`) that stands for the latest version served, grouped by vendor with the current vendor unfolded. A search lists every routed model as a flat list (see [Select a model](models.md#select-a-model)). When an interactive selection from a pool has several possible accounts, Credne asks which one to use before saving the model. Subscription accounts appear before API keys, and each option shows its exact model ID. Choosing an account pins it; choosing the pool keeps automatic failover. A session pinned to an account stays on it (see [Pinned accounts](#pinned-accounts)). When unrelated providers use the same ID and the broker cannot establish that they are the same model, choose the provider pool explicitly.

To choose the payer instead of using pooled routing, use `/accounts switch` or an explicit `acct:<id>/<model>` selection. For example, `--model acct:claude-api-work/claude-sonnet-4-5` pins the session when that account and model are registered. A deliberate account restriction is never widened to the global pool by an alias.

The accounts list shows each account with its state and model count:

```
Claude · you@example.com (Max)     ready           12 models
Claude · work key (API key)        cooling down until 14:05   12 models
ChatGPT Codex · you@example.com (Plus)   disabled   7 models
```

Each account name shows its family, its label or email, and its plan or kind. Its state can be `ready`, `cooling down until ...`, `quota exceeded`, `unavailable`, `error`, or `disabled`.

## Pools

A pool is a provider that lets the broker route each request to an enabled account that offers the requested model. There is one pool per model family and one combined pool:

| Pool | Provider | Contents |
| --- | --- | --- |
| All accounts | `pool:all` | Every enabled account, of any family. Select it explicitly when you want automatic routing across accounts. |
| Claude | `pool:claude` | Enabled Claude subscriptions and Anthropic API keys. |
| ChatGPT Codex | `pool:codex` | Enabled ChatGPT subscriptions. |
| OpenAI API | `pool:openai` | Enabled OpenAI API key accounts. |

A pool exists as soon as one enabled account belongs to its family, so `pool:claude` is listed even with a single Claude account. Pool models are the union of the models of its accounts. When a model is listed by more than one account, a request for it can be served by any of them.

Pools try eligible subscription accounts before ordinary API keys. For example, if a ChatGPT subscription and an OpenAI API key both offer the selected GPT model, `pool:all` uses the subscription first. When the subscription is rate-limited, the pool can use the key and incur API charges. Once the subscription is eligible again, it takes priority even if the key served the previous turn. Claude subscriptions and Anthropic API keys follow the same rule. The configured routing strategy and session affinity choose between accounts within each group.

Priority does not change the model or override a deliberate billing choice: `pool:openai` uses OpenAI API keys, and a pinned account never switches to a sibling. Pin a subscription if you want an error rather than API-key fallback. The footer shows which account served the last chat request.

### Subscription models

A pool can only prefer a subscription for models the subscription lists. The broker reads each Claude and ChatGPT subscription's model list from the provider with that account's own sign-in, using oh-my-pi's discovery: ChatGPT's Codex model list and Anthropic's `/v1/models`. It does this when the broker starts and at most every 15 minutes after that, whenever Credne asks for the account's models. Until the first read finishes, an account serves oh-my-pi's bundled list, and a pool request waits for the read before it chooses an account. Without this, a model newer than the bundled list (for example a new GPT release that both a ChatGPT plan and an OpenAI key offer) would always go to the billed key. A failed read keeps the current list and is retried after a minute. API-key accounts keep the list read when the key was added.

Opening `/model` refreshes the account list from a running broker, so newly discovered models appear without starting a new session. Listing models never starts the broker.

## Subscription web search

The built-in `web_search` tool runs the provider's hosted search on a Claude or ChatGPT subscription; API keys and public search engines are never used for it. The broker sends the search with oh-my-pi's own web search providers (vendored from oh-my-pi 19.0.0 in `broker/src/omp-search/`). Each request therefore uses the same endpoint, headers, body, system prompt and Claude request signing as a search in oh-my-pi itself:

- Claude: a separate Messages request with the `web_search_20250305` tool and the `web-search-2025-03-05` beta, on the session model's oh-my-pi search model (Claude Haiku 4.5), then on the session model if that fails.
- ChatGPT: a Codex Responses request with the hosted `web_search` tool, on GPT-6 Luna, then on the session model.

The tool sends only its query. `allowed_domains` and `blocked_domains` become oh-my-pi `site:` and `-site:` directives: Claude applies them as domain filters and ChatGPT as search operators. As in oh-my-pi, the broker then removes every source and citation outside them; the tool result notes when it did, because the search model's summary may still draw on removed sources. A search with nothing inside them fails over to the next model. A session pinned to a subscription searches with that account only. A pool searches with a subscription in the pool that offers the session's model, and tries the next one after a usage limit. A search request is held on the account's credential like a chat request, so an environment API key can never answer it. Add a subscription with `/accounts add codex` or `/accounts add claude-subscription`. Searches count against the subscription's usage. The bundled explorer and deep-research (`crazy`) profiles include `web_search`; an extension that registers its own `web_search` replaces the built-in.

## Pinned accounts

A session on `acct:<id>` is pinned to one account. Every request uses that account. When it is rate-limited, out of quota or rejected, Pi reports the error with the account name and the provider's retry time, and it never moves the session to another account. Use a pool when you want failover, and a pinned account when you need a specific account.

A pinned session keeps its account for every model the account serves. The `/model` picker and completions list the account's rows instead of the pool rows for those models, and `/model <id or alias>` and Ctrl+P choose them as `acct:<id>/<model>`, so the selection and the saved default stay on the account. An alias such as `sonnet` is matched against the account's models first. At startup the saved default account does the same for a bare `--model`, `--models` or `enabledModels` entry.

Models the account does not serve are still listed from the pools and local providers. To leave the account, choose one of those, enter an explicit `pool:<name>/<model>`, or run `/accounts switch`.

## Decision model through an OpenAI API key

OpenAI's Decisions API classifies a state with structured questions, which Credne uses for rating and routing decisions. It accepts only an OpenAI API key, not a ChatGPT sign-in. An OpenAI API-key account in the broker can provide a `gpt-6-luna` classifier without exposing its key to Credne.

Each of these appears in `ctx.modelRegistry.getAvailableOfType("classifier")` and works with `classify()`:

| Provider | Classifier | Served by |
| --- | --- | --- |
| `acct:<id>` of an OpenAI API key | `gpt-6-luna` | That key, never another account. |
| `pool:openai` | `gpt-6-luna` | An enabled OpenAI API key that lists `gpt-6-luna`. |

An account or pool offers the classifier only when an enabled OpenAI API key lists `gpt-6-luna` in its models. ChatGPT subscriptions, Claude accounts, `pool:codex`, `pool:claude` and `pool:all` do not offer it. The classifier copies its cost and limits from the built-in `openai` entry, so session costs use the same Decisions rate (input tokens only). The key's own OpenAI project is billed.

Requests use the same loopback connection and per-run token as chat, and the same System One wire as Jev (below). Pi posts to `/credne/v1/route/<target>/systemone` with `"model": "gpt-6-luna"`. The broker's oh-my-pi runtime answers it as a System One judgment and sends it to OpenAI's Decisions API with the account's key. A target that is not an OpenAI API key is refused and nothing is sent. The footer is not updated by a classification, because `pool:openai` may serve it with another key than the chat.

The classifier is registered with the other models of the account from the catalog (`catalog.json`), so it is there at startup. The catalog refreshes when the broker is running at session start and after `/accounts` actions. Rebuild and restart the broker after updating (see Setup): a broker from before this change answers the route with HTTP 404, and a catalog written by an earlier version, which named Decisions as the API, is rebuilt.

## Jev (TypeSafe) accounts

Jev is TypeSafe's classifier model. Credne uses it to rate delegated tasks for the [subagent tier classifier](subagents.md#tier-classifier), ahead of `gpt-6-luna`. Add a TypeSafe API key with `/accounts add jev` (or `/accounts add typesafe`): name the account, then paste the key. The broker checks the key against TypeSafe's model list before it stores the account.

A TypeSafe account has no chat models, so it never adds models to a model list or to `pool:all`. It offers the Jev models its key lists as classifiers, which appear in `ctx.modelRegistry.getAvailableOfType("classifier")` and work with `classify()`:

| Provider | Classifier | Served by |
| --- | --- | --- |
| `acct:<id>` of a TypeSafe key | The Jev models the key lists, for example `jev-latest` | That key, never another account. |
| `pool:typesafe` | The same models | An enabled TypeSafe key. |

Requests use the same loopback connection and per-run token as chat. Pi posts to `/credne/v1/route/<target>/systemone`, and the broker's oh-my-pi runtime forwards the System One request to TypeSafe with the account's key, including the `TypeSafe-Danger-Zone-Images` header that image input needs. The classifier copies its limits and input types from the built-in `typesafe` entry, which prices it at zero.

Jev is part of the intended setup, but Credne works without it. At session start in interactive mode, once Credne has refreshed the account list from the running broker, it shows one warning if no enabled TypeSafe account exists: `No Jev account. Add one with /accounts add jev; decisions fall back to gpt-6-luna or the session model.` The warning is shown once per Credne process. It never prompts or blocks. Without a Jev account, an OpenAI API key that lists `gpt-6-luna` rates tasks; with neither, the session's chat model does.

## Commands

| Command | Effect |
| --- | --- |
| `/accounts` | Open the accounts and pools panel with live usage and session cost estimates. |
| `/accounts status` | Show whether this session uses a pinned account or a pool, and which provider and model it uses. |
| `/accounts list` | Same as `/accounts`. |
| `/accounts switch [account]` | Switch this session and remember the account or pool for new sessions. The current model stays if the account offers it. Other running sessions are not affected. |
| `/accounts default [account]` | Same as `/accounts switch`. |
| `/accounts add [kind]` | Add an account. See "Adding accounts". |
| `/accounts remove [account]` | Remove a broker-managed account and delete its stored credential. Interactive mode asks for confirmation. |
| `/accounts enable\|disable [account]` | Turn an account on or off without removing it. |
| `/accounts reset [account]` | Clear the broker's cooldown for an account, for example after its usage window has reset. |
| `/models [account]` | List the models of this session's provider. With an account name, list that account's models instead, and choose one to switch this session to it. |

Selections in `/accounts`, `/models`, and `/model`, including model cycling, remember the model and account for the next new session across projects. Resuming an existing session restores that session's recorded selection; an explicit CLI model or project configuration can override the saved default.

The singular `/account` command is no longer registered. All account commands and completions are under `/accounts`.

### Panel controls

Accounts and pools are listed on the left. The right pane shows the highlighted row's identity, state, quota and session costs. On narrow terminals the details move below the list. The current session and saved default are marked separately when they differ.

- Click a row or use Up/Down to inspect it without switching. Enter uses that account and makes it the default for new sessions, keeping the current model if possible. `Ctrl+L` chooses a specific model instead.
- Press Space to mark accounts without changing the payer. Use the toolbar above the list to add an account, select all or clear the selection, enable, disable, or delete. Tab focuses the toolbar, arrows choose an action, and Enter runs it. Tab returns to the list. Pools, cached offline entries, and accounts managed in `config.yaml` cannot be marked for bulk changes.
- Delete asks for confirmation and names the accounts whose stored credentials will be removed. Cancelling keeps the marks. If only some deletions succeed, the remaining failed accounts stay marked for retry. Disable an account instead to keep its credentials.
- `Ctrl+O` opens individual account management, including clearing a cooldown. `Ctrl+R` refreshes usage. PageUp/PageDown scroll details; Escape closes without switching.

The shortcuts are configurable in [keybindings.json](keybindings.md). Loading usage is cancelled on selection changes or close; late responses cannot replace another account's details.

### Usage and session costs

Claude and ChatGPT Codex subscriptions show each provider-reported quota window (for example `5-hour` or `7-day`) as a bold label, a solid bar filled to the used share with its percent used, and the time until reset with the reset time in your local timezone. API keys and other accounts without reported usage show an explicit reason. Missing quota data or a failed provider request is unavailable, never 0% used. Clear cooldown only resets broker routing state; it does not reset your subscription allowance.

Provider-reported credits are separate from session cost estimates. Claude extra-usage values retain the provider's credit units; Codex credit balances retain provider credits. They are not converted into subscription charges.

The panel sums the current session's recorded assistant-message costs for the selected pinned account: input, output, cache read, cache write, and total. These dollar values are **API-rate estimates, not billed subscription charges**, and do not measure subscription quota. Missing catalog prices can produce zero recorded estimates; this does not imply free usage. The figures cover recorded assistant responses in this session, including its branches, not all-time usage or background requests.

Responses on any pool are shown separately as **unattributed pool totals**, excluded from every individual account total. The footer's last-serving-account header is not stored with each reply, so it is not used to assign pool costs to an account.

An account can be named by part of its label, email or id. If exactly one account matches, the command uses it. If several match, Pi shows a list to choose from. Without interactive prompts, name the account exactly.

Restart broker, found in `/accounts`, stops the shared broker. This reloads `config.yaml` (see "Configuration file" below). The broker is shared, so every Pi process is affected: a request in progress is interrupted, and the next request in any session starts a new broker. Use it only when the configuration file changed.

## Footer

The footer shows the account of the current session:

- On a pinned account: `account: Claude · you@example.com (Max)`.
- On a pool: `account: All accounts pool (3 accounts) -> Claude · work key (API key)`. The name after the arrow is the account that served the last request, so it changes as the pool moves a conversation. Before the broker identifies a serving account for the pool in this session, the arrow is not shown.

## Switching accounts mid-session

The conversation history is kept when you switch accounts, and the next request continues it. Credne sends the whole history, including earlier reasoning with its signatures, and oh-my-pi decides what the target can accept. Providers sign or encrypt reasoning for the account and model that produced it, so another account or model cannot replay it as is. oh-my-pi then replays that reasoning as plain text or leaves it out. Visible text, tool calls and tool results are kept unchanged. Inside a pool the same rule applies when the conversation moves to another account or an account rejects reasoning from another account.

oh-my-pi recognizes its own earlier turns by the provider and API it resolved for the model, for example `anthropic` and `anthropic-messages`. The broker reports both with each account's model list, and Credne keeps them in `catalog.json` for each account and for each pool model whose accounts all agree. Earlier turns carry them, so a turn of a Claude account keeps its signed reasoning when the next request goes to the same model on that account or on `pool:claude`. A turn whose identity Credne does not know replays its reasoning as plain text: an account that was removed, a `pool:all` model that a ChatGPT subscription and an OpenAI key both serve, or a catalog written before the broker reported them.

## Configuration file

Accounts defined in `~/.pi/agent/accounts/config.yaml`, under `api-keys`, appear in the list as API-key accounts. The extension cannot disable, enable or remove them, because the file is their source of truth. Edit the file and choose `Restart broker` in `/accounts` to apply changes. The daemon reads the file only at startup. See `broker/README.md` for the configuration format and supported routing options.

## Security

The daemon keeps account credentials beneath `~/.pi/agent/accounts` and writes its managed account metadata to `omp-accounts.json`. On upgrade it can import accounts from `api-accounts.json` without rewriting that file. See `broker/README.md` for the storage layout. Credne authenticates to the daemon with a per-run loopback token, which stops working when the daemon restarts. It does not use provider credentials directly.

Pi's `read`, `edit` and `write` tools cannot access the accounts directory. Shell commands run as your user and can read it, as they can read [`auth.json`](configuration.md#agent-directory). Treat the accounts directory the same way you treat `auth.json`.
