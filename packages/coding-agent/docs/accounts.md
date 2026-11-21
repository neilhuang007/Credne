# Multiple Accounts

The built-in `accounts` extension connects several accounts per provider, for example two Claude subscriptions, a Claude API key and a ChatGPT subscription. Each session chooses which account it uses, and two terminals can use two different accounts at the same time. Claude Pro, Max and Team subscriptions are signed in and served by Credne itself: it keeps their tokens and sends their requests straight to Anthropic. Every other account (ChatGPT subscriptions, Claude API credits and API keys, OpenAI API keys) uses one shared Bun daemon, `credne-broker`, backed by [oh-my-pi AI](https://github.com/can1357/oh-my-pi/tree/main/packages/ai). Pi keeps sessions, prompts, tools and the agent loop. The daemon design is described in `broker/README.md` in the repository.

## Setup

Build the daemon with Bun 1.4.4 or newer and put it in Pi's bin directory or on `PATH`:

```bash
npm --prefix broker run build
mkdir -p ~/.pi/agent/bin
cp broker/dist/* ~/.pi/agent/bin/
```

Pi discovers the daemon through `broker.json` in the accounts directory. If none is running, Pi starts it detached. Concurrent starts share one daemon, and it outlives the Pi process that started it. The daemon stops after 30 minutes without requests and starts again on the next one. Set `PI_ACCOUNTS_BROKER` to use a binary elsewhere. Installed Credne distributions include the executable and do not need Bun installed. A setup with only Claude subscriptions never starts the daemon.

Stop a previous-version broker before starting this version. Credne reports its process ID instead of reusing the previous backend or starting a second daemon beside it.

With no accounts configured, the extension registers no providers. Open `/accounts` to add one, or run `/accounts add`.

## Adding accounts

Run `/accounts add` and choose `Claude account` or `ChatGPT account`. The next menu lists the available login methods. Choose by how you pay for the models:

| Account | Way | What you do |
| --- | --- | --- |
| Claude | `Subscription (Pro, Max, Team sign-in)` | Sign in with your claude.ai account in the browser. Credne stores and refreshes the sign-in itself; see [Claude subscriptions](#claude-subscriptions). |
| Claude | `API credits (monthly credits of Max, Ultra, Team plans, Claude Console sign-in)` | Name the account, then sign in to a Claude Console organization in the browser. Usage draws on that organization's API credits. |
| Claude | `API key (Anthropic Console key)` | Name the account, then paste an Anthropic API key. |
| ChatGPT | Subscription | Sign in with your ChatGPT account in the browser. |
| ChatGPT | `API key (OpenAI API credits)` | Name the account, then paste an OpenAI API key. Requests use the official OpenAI API with that project's API billing. |

Escape in the method menu returns to the family menu; Escape there cancels. `/accounts add claude` and `/accounts add chatgpt` open their respective menus. Use `/accounts add openai-api-key` for an OpenAI API key, `/accounts add codex` for a ChatGPT subscription, or `/accounts add claude-subscription`, `claude-api-credits`, or `claude-api-key` for a Claude method.

OpenAI API keys are registered as `openai-api` accounts with kind `api-key`. They use the official OpenAI API and never authenticate through Codex. Their family pool is `pool:openai`; ChatGPT subscription accounts stay in `pool:codex`.

The same account cannot be added twice the same way. The broker rejects a second account with the same API key (including keys in `config.yaml`) or the same name, and an API-credit sign-in to a Console organization that is already added; the new `ant` sign-in is then signed out. Signing in again to a Claude subscription that is already added (the same Claude account and organization) renews its sign-in, keeps its `disabled` setting and reports that no account was added; the same login in two organizations is two accounts. Signing in again to a ChatGPT subscription does the same. Adding the same person in two different ways, for example a subscription and API credits, is allowed: they are separate accounts with separate limits.

For browser sign-in, Pi opens the page and also shows the link, so you can open it yourself. The redirect is normally received automatically. If the browser shows an error after sign-in, or Pi runs on another machine than the browser, copy the full redirect URL (or the code the page shows) from the browser and paste it into the prompt that Pi shows. For a Claude subscription the first prompt offers the browser login or pasting a code. Sign-in times out after five minutes.

The API-key prompt shows the key while you type, because extension dialogs have no masked input. The broker checks the key by listing its models before it stores the account, so an invalid key is rejected and nothing is saved.

The first account you add also becomes the default for new sessions, unless a default model is already configured. The default is the combined pool `pool:all`, described below.

## Claude subscriptions

A Claude subscription is a local account. `/accounts add claude-subscription` runs Anthropic's OAuth login in Credne and stores the result in `~/.pi/agent/accounts/claude-subscriptions.json`, one entry per account. Credne refreshes an access token shortly before it expires, under a lock on that file, so several Credne processes never use the same rotating refresh token twice. Requests go straight to `api.anthropic.com` with the account's token, shaped like Claude Code requests. The broker never sees these tokens.

Each account is a provider named `claude-sub:<id>`, where `<id>` is eight hex digits of a hash of the Claude account and organization, followed by the local part of the email address when known, for example `claude-sub:1a2b3c4d-you`. The models are the built-in Anthropic models. `/accounts` lists, enables, disables and removes these accounts like any other; removing one deletes its stored sign-in.

The panel's usage view asks Anthropic's usage endpoint for the account's windows and shows the `5-hour` and `7-day` windows, the model-scoped weekly caps that are reported (for example `7-day Sonnet`) and the extra-usage credits. It also asks the profile endpoint for the plan, which becomes part of the account's name (for example `Max 5x`). Every response's rate-limit headers update the same windows while you work, and pools use them to choose an account (see Pools).

### Moving subscriptions from the broker

Earlier versions kept Claude subscriptions in the broker. When a session starts, Credne moves every `claude-*.json` file in `~/.pi/agent/accounts/auths` to the local store: it first writes the account (tokens, organization, device id, `disabled`) into `claude-subscriptions.json`, and only then removes the broker's copy, through the broker when one is running and by deleting the file otherwise. The two sides therefore never refresh the same refresh token. The move is repeatable: an account the local store already has is not overwritten, and a removal that failed is retried at the next start. No token is printed.

## Subscription web search

Ask Credne to “search the web for the current Node.js LTS release and cite the release page.” The built-in `web_search` tool sends only its query to hosted web search. It follows Claude Code's WebSearch design: a separate request on the subscription's model runs the provider's hosted search (up to 8 searches on Claude) and briefly summarizes the results. The tool returns each search's links and that summary, and the main model cites the links it uses. Pass `allowed_domains` or `blocked_domains` to restrict results; Claude filters them at the provider, while ChatGPT search is told the restriction and its links are filtered locally. Add a subscription once with `/accounts add codex` or `/accounts add claude-subscription`. Searches consume provider usage and require a model and plan with hosted search enabled.

A session on a Claude subscription (`claude-sub:<id>`) searches with that account and model. A session on `pool:claude` or `pool:all` with a Claude model searches on the local Claude subscriptions that offer the model, the one that answered last first. A subscription at its usage limit passes the search to the next one; when all are at their limit, Credne reports it. From a non-Claude model, or when no Claude subscription is available, search uses a broker subscription (ChatGPT first). If the search provider rejects the request for another reason, Credne reports the error rather than retrying it on a different billing route. API-key accounts, Claude Console credits, and public search engines are never automatic fallbacks.

On Claude, the search is a request on the subscription's model through Credne's model registry, so it goes out like any other request of that account, with Anthropic's hosted `web_search_20250305` tool added. ChatGPT searches call the provider's hosted tool through the account broker. This avoids a second login, a Claude bridge model, or sharing credentials with an external plugin. If you prefer a community extension, one that registers `web_search` replaces the built-in. For a separate keyless service, configure it explicitly using [MCP](mcp.md). The bundled explorer and deep-research (`crazy`) profiles include `web_search`; add the tool to `tools:` in a custom profile to enable it there.

## Accounts and providers

Each account appears as its own provider: `claude-sub:<id>` for a Claude subscription and `acct:<id>` for a broker account. For example, `--model claude-sub:1a2b3c4d-you/claude-opus-4-8` or `--model acct:claude-api-1a2b3c4d-you@example.com/claude-sonnet-4-5` starts a session on one account. Accounts also appear in `/model`, where choosing one saves it as the default for new sessions, as any other model does.

The accounts list shows each account with its state and model count:

```
Claude · you@example.com (Max)     ready           12 models
Claude · work key (API key)        cooling down until 14:05   12 models
ChatGPT Codex · you@example.com (Plus)   disabled   7 models
```

Each account name shows its family (Claude or ChatGPT Codex), its label or email, and its plan or kind. The state line of a broker account is one of `ready`, `cooling down until ...`, `quota exceeded`, `unavailable`, `error`, or `disabled`. A Claude subscription shows `ready`, `limit reached until ...` while a usage window that applies is used up or a request reported a limit, or `disabled`.

## Pools

A pool is a provider that spreads requests over several accounts, choosing which enabled account that offers the requested model serves each request. There is one pool per model family and one combined pool. `pool:claude` and `pool:all` are routed by Credne itself, in the process, and their requests go to the local Claude subscriptions or to the broker's accounts directly. `pool:codex` and `pool:openai` are provided by the broker:

| Pool | Provider | Contents |
| --- | --- | --- |
| All accounts | `pool:all` | Every enabled account, of any family: Claude subscriptions first, then the broker's accounts. This is the default for new sessions after the first account is added. |
| Claude | `pool:claude` | Enabled Claude subscriptions, then Claude API-credit accounts and Claude API keys. |
| ChatGPT Codex | `pool:codex` | Enabled ChatGPT subscriptions. |
| OpenAI API | `pool:openai` | Enabled OpenAI API key accounts. |

A pool exists as soon as one enabled account belongs to its family, so `pool:claude` is listed even with a single Claude account. Pool models are the union of the models of its accounts. When a model is listed by more than one account, a request for it can be served by any of them.

`pool:claude` and `pool:all` pick the account for each request in this order: Claude subscriptions, then the broker's Claude API accounts; in `pool:all` the broker's other accounts serve the models only they offer. Among subscriptions the pool follows how oh-my-pi ranks OAuth accounts:

- A conversation stays on the account that answered last while that account can serve the request and its prompt cache can still be warm (the last answer is less than an hour old), so provider-side caches and reasoning state stay valid. An API account that has the conversation yields as soon as a subscription can serve again.
- Otherwise Credne asks Anthropic's usage endpoint for the windows of accounts whose usage is unknown or older than five minutes (waiting at most five seconds), and ranks the subscriptions. An account whose allowance for the model is spent ranks last. An account whose 5-hour window is at least 85% used ranks behind cooler ones. Accounts with known usage rank before accounts without. Then the account whose remaining weekly quota must be used fastest to avoid expiring at its reset comes first, which also means the account with the most remaining capacity when resets coincide, then the 5-hour window the same way. The listing order breaks ties.
- An account is blocked while a window that applies to the request is used up, until its reset, and after a request reported a limit. A limit reported without a reset time blocks for a minute. A Fable or Mythos limit blocks only those models, other limits block the whole account. A successful response lifts a block, and so does a usage report that shows the account healthy.
- A retry after a rate limit (HTTP 429) or a usage-limit failure blocks the failed account and moves the request to the next one. Per-minute token throttles are not usage limits and stay on the account. When every account is blocked, a retry waits up to five seconds for the account that frees up first; otherwise that account gets the request and reports its own limit.

The pool's state is kept in memory by each Credne process. A worker started by the subagent tool is pinned to the account its parent last used and does not rotate. The footer shows which account served the last request (see below).

A broker pool (`pool:codex`, `pool:openai`) keeps a conversation on one account while that account is usable. If the account hits a limit, the broker moves the next request to another account in the pool.

## Pinned accounts

A session on `claude-sub:<id>` or `acct:<id>` is pinned to one account. Every request uses that account. When it is rate-limited, out of quota or rejected, Pi reports the error with the account name and the provider's retry time, and it never moves the session to another account. Use a pool when you want failover, and a pinned account when you need a specific account.

## Commands

| Command | Effect |
| --- | --- |
| `/accounts` | Open the accounts and pools panel with live usage and session cost estimates. |
| `/accounts status` | Show whether this session uses a pinned account or a pool, and which provider and model it uses. |
| `/accounts list` | Same as `/accounts`. |
| `/accounts switch [account]` | Switch this session and remember the account or pool for new sessions. The current model stays if the account offers it. Other running sessions are not affected. |
| `/accounts default [account]` | Same as `/accounts switch`. |
| `/accounts add [kind]` | Add an account. See "Adding accounts". |
| `/accounts remove [account]` | Remove an account and delete its stored credential after confirmation. For a Claude subscription this deletes its entry in `claude-subscriptions.json`. |
| `/accounts enable\|disable [account]` | Turn an account on or off without removing it. |
| `/accounts reset [account]` | Clear an account's cooldown and quota state, for example after you know its usage window has reset. For a Claude subscription this forgets the blocks and windows Credne holds for it. |
| `/models [account]` | List the models of this session's provider. With an account name, list that account's models instead, and choose one to switch this session to it. |

Selections in `/accounts`, `/models`, and `/model`, including model cycling, remember the model and account for the next new session across projects. Resuming an existing session restores that session's recorded selection; an explicit CLI model or project configuration can override the saved default.

The singular `/account` command is no longer registered. All account commands and completions are under `/accounts`.

### Panel controls

- Up/Down browse accounts and pools. The active provider is marked `● active`.
- Enter uses the selected provider immediately, keeping the current model when available, otherwise selecting its first model. There is no second "Use" menu.
- Click a row to select it and inspect its details without switching. Enter confirms.
- `Ctrl+O` opens management (enable/disable, clear cooldown, remove). `Ctrl+L` chooses a model. Returning from either keeps the selected provider highlighted.
- `Ctrl+R` refreshes the selected account's live usage. PageUp/PageDown scroll its details on short terminals. Escape cancels without switching.
- `+ Add account` and `Restart broker` are navigable rows.

These controls use `tui.select.*`, `app.accounts.manage`, `app.accounts.model`, and `app.accounts.refresh` in [keybindings.json](keybindings.md). Loading usage is cancelled on selection changes or close; late responses cannot replace another account's details.

### Usage and session costs

Claude and ChatGPT Codex subscriptions show each provider-reported quota window (for example `5-hour` or `7-day`) as a bold label, a solid bar filled to the used share with its percent used, and the time until reset with the reset time in your local timezone. API-key, API-credit, and other unsupported account kinds show an explicit unsupported reason. Missing quota data or a failed provider request is unavailable, never 0% used. Clear cooldown only resets broker routing state; it does not reset your subscription allowance.

Provider-reported credits are separate from session cost estimates. Claude extra-usage values retain the provider's credit units; Codex credit balances retain provider credits. They are not converted into subscription charges.

The panel sums the current session's recorded assistant-message costs for the selected pinned account: input, output, cache read, cache write, and total. These dollar values are **API-rate estimates, not billed subscription charges**, and do not measure subscription quota. Missing catalog prices can produce zero recorded estimates; this does not imply free usage. The figures cover recorded assistant responses in this session, including its branches, not all-time usage or background requests.

A response that `pool:claude` or `pool:all` routed is recorded with the account that served it, so it counts in that account's total. Broker pool responses (`pool:codex`, `pool:openai`) are shown separately as **unattributed pool totals**, excluded from every individual account total. The footer's last-serving-account header does not reliably identify each persisted session response, so it is not used to assign broker pool costs to an account.

An account can be named by part of its label, email or id. If exactly one account matches, the command uses it. If several match, Pi shows a list to choose from. Without interactive prompts, name the account exactly.

Restart broker, found in `/accounts`, stops the shared broker. This reloads `config.yaml` (see "Configuration file" below). The broker is shared, so every Pi process is affected: a request in progress is interrupted, and the next request in any session starts a new broker. Use it only when the configuration file changed.

## Footer

The footer shows the account of the current session:

- On a pinned account: `account: Claude · you@example.com (Max)`.
- On a pool: `account: All accounts pool (3 accounts) -> Claude · work key (API key)`. The name after the arrow is the account that served the last request, so it changes as the pool moves a conversation. For `pool:claude` and `pool:all` it comes from the latest answer in the session. Before the first request the arrow is not shown.

## Switching accounts mid-session

The conversation history is kept when you switch accounts, and the next request continues it. Earlier reasoning is handled differently from visible text. Providers sign or encrypt reasoning for the account that produced it, so the new account cannot accept it as is. Pi replaces that reasoning with a short summary that starts with this label:

```
[Reasoning summary from an earlier turn, not shown to the user]
```

The label marks the summary as earlier private reasoning, so the model does not treat it as part of its visible reply. Each summary is limited to about 1500 characters. Visible text, tool calls and tool results are kept unchanged. Reasoning the provider marks as redacted is dropped, because it has no readable text.

This applies in two places. Switching a session between accounts, and moving a conversation between accounts inside `pool:claude` or `pool:all`, is handled by Pi. Inside a broker pool, the broker makes the same replacement when the account that served the previous request can no longer serve the conversation, and when an account rejects reasoning from another account. In the second case the broker retries the request once, so the conversation continues without an error.

## Configuration file

Accounts defined in `~/.pi/agent/accounts/config.yaml`, under `api-keys`, appear in the list as API-key accounts. The extension cannot disable, enable or remove them, because the file is their source of truth. Edit the file and choose `Restart broker` in `/accounts` to apply changes. The daemon reads the file only at startup. See `broker/README.md` for the configuration format and supported routing options.

## Security

Credentials stay beneath `~/.pi/agent/accounts`. Local Claude subscription logins remain in `claude-subscriptions.json`; the daemon stores its account credentials separately, and Claude Console sign-in state stays in `ant`. See `broker/README.md` for the daemon's storage layout. Credential files are readable only by your user. The daemon holds its credentials in memory while it runs; Credne holds local Claude subscription tokens only as long as a request needs them. For daemon requests, Pi holds only a per-run loopback token, which stops working when the daemon restarts.

Pi's `read`, `edit` and `write` tools cannot access the accounts directory. Shell commands run as your user and can read it, as they can read [`auth.json`](configuration.md#agent-directory). Treat the accounts directory the same way you treat `auth.json`.
