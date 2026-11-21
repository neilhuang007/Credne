# credne-broker

A shared account broker for the harness. It embeds the [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) Go SDK (MIT) as a private loopback service that owns provider credentials and executes each request for the account or pool the harness names. Sessions, prompts, tools and the agent loop stay in the harness.

The user-facing guide is [Multiple Accounts](../packages/coding-agent/docs/accounts.md). This file describes the broker itself: its routes, guarantees, storage and build.

## Why

Pi stores one credential per provider. Several accounts of the same provider need separate credentials, and each terminal should be able to choose which one it uses. Without a shared broker, every terminal would run its own token refresh and keep its own copy of each credential.

Example: terminal 1 uses `claude-work` with Claude Opus, terminal 2 uses `claude-personal`, and terminal 3 uses `pool:claude`, which balances over both. All three talk to one broker process. If `claude-personal` hits its rate limit, terminal 2 receives the 429 with `Retry-After`. It is not moved to `claude-work`, because a pinned account never falls back. Terminal 3 is served by whichever Claude account still has capacity.

CLIProxyAPI already implements provider OAuth, token refresh, cooldowns, quota tracking, retries, Claude Code and Codex client emulation, and protocol adaptation. The broker reuses that code instead of reimplementing providers, and limits it to what the harness needs.

## Architecture

```
pi (N terminals)                                  credne-broker (1 per user home)
  acct:<id>      ── loopback HTTP, token ──►  /credne/v1/route/a.<b64 id>/...    pinned account
  pool:<name>    ── loopback HTTP, token ──►  /credne/v1/route/p.<name>/...      CLIProxyAPI selection
  /accounts, /logins, ... ─────────────────►  /credne/v1/accounts, /logins, ...
                                                 │
                                                 └─ cliproxy.Service (embedded SDK)
                                                      coreauth.Manager: selection, refresh, cooldown
                                                      provider executors: claude, codex, claude-api, ...
                                                      management v8 handlers: OAuth, credentials
```

Each account is a Pi provider named `acct:<id>`. Pools are the other kind of Pi provider: `pool:all` covers every enabled account, and `pool:<family>` (for example `pool:claude` or `pool:codex`) covers the enabled accounts of one model family. A family is a group of accounts that serve the same models. Claude subscriptions, Claude API-credit accounts and Claude API keys all belong to the `claude` family. Pools are created whenever a family has at least one enabled account, so a pool exists even with a single account and its name stays valid as accounts are added.

| Pi provider | Route target | Behavior |
| --- | --- | --- |
| `acct:<id>` | `a.<b64 auth id>` | Pinned to one account. A failure is returned to the caller and never rerouted. |
| `pool:all` | `p.all` | Any enabled account that serves the requested model, across families. |
| `pool:<family>` | `p.<family>` | Any enabled account of the family that serves the requested model. |

Pools do not force a provider. CLIProxyAPI selects among every account that lists the requested model, so a Claude model in `pool:all` is served only by Claude accounts, because no ChatGPT account lists it.

Pi sends requests with its own native adapters: `anthropic-messages` for Claude, `openai-responses` for Codex, and `openai-completions` for other families, which CLIProxyAPI translates. The broker executes each request in the protocol it arrived in, so no capability is lost to a common intermediate format. CLIProxyAPI only adapts the payload to the selected account's upstream, for example Responses to the ChatGPT Codex backend, or Claude Code request emulation for Claude subscriptions.

### Reused from CLIProxyAPI unchanged

The broker depends on `github.com/router-for-me/CLIProxyAPI/v8` as a pinned Go module and imports only public `sdk/` packages. There is no fork.

| Need | CLIProxyAPI component |
| --- | --- |
| Executors, refresh loop, cooldowns, retries, watcher | `sdk/cliproxy` `Service` |
| Pinned execution | `sdk/api/handlers` `ExecuteProtocolStreamWithAuthManager` / `ExecuteProtocolWithAuthManager` with `ForcedProvider` and `WithPinnedAuthID` |
| Which account served a pool request | `handlers.WithSelectedAuthIDCallback` |
| OAuth login (URL, callback forwarder, status, cancel), disable, delete, cooldown reset | v8 management handlers, called in-process |
| Model discovery per account | `cliproxy.GlobalModelRegistry()` |
| Subscription credential storage | CLIProxyAPI file store in `<home>/auths` |
| Gate and routes | `sdk/api.WithMiddleware`, `sdk/api.WithRouterConfigurator` |

### Added by the broker

The broker adds five parts around the reused code. Each is described in its own section below.

The runtime configuration (`internal/broker/config.go`) forces a private loopback service: bound to `127.0.0.1` on a random port, with no plugins, no LAN discovery, no pprof, no TLS, no request logs, and management reachable only in-process. A user `config.yaml` may set routing, retries and config-file API keys, but enforced values always win and are checked after loading.

The gate (`gate.go`) is a middleware in front of every CLIProxyAPI route. It requires the per-run token, rejects foreign `Host` headers, and allows only `/credne/v1/*` plus the tokenless OAuth callback paths. CLIProxyAPI's own public `/v1/*`, `/v0` and `/v8` routes are unreachable from outside.

The broker API (`broker.go`, `execute.go`, `accounts.go`, `apiaccounts.go`) adds the routes listed below, a single-instance lock, a discovery file, idle shutdown and an optional per-account concurrency limit.

The official-API executor `claude-api` (`anthropic.go`) serves Anthropic API keys and API-credit accounts. Section "Claude API accounts" explains why it exists.

The `openai-api` executor (`openai.go`) sends API key requests directly to the official OpenAI Responses or Chat Completions endpoint. It uses Bearer authentication and never enters Codex subscription login. `pool:openai` selects only OpenAI API key accounts; `pool:codex` selects Codex subscriptions. The combined `pool:all` can use either. The harness lists chat models present in both the key's model access and its OpenAI catalog.

The reasoning continuity logic (`reasoning.go`) keeps a conversation working when it moves from one account to another. Section "Reasoning continuity across accounts" explains it.

## Account kinds

Every account has a family and a kind. The kind decides how the account authenticates and which executor sends its requests.

| Account | Pi entry | Broker `kind` | Credential storage | Executor |
| --- | --- | --- | --- | --- |
| Claude subscription | `/accounts add claude-subscription` | `oauth` (provider `claude`) | `<home>/auths` | CLIProxyAPI Claude executor (Claude Code request emulation) |
| Claude API credits | `/accounts add claude-api-credits` | `api-credits` (provider `claude-api`) | `<home>/ant` (ant profile) | `claude-api` |
| Claude API key | `/accounts add claude-api-key` | `api-key` (provider `claude-api`) | `<home>/api-accounts.json` | `claude-api` |
| ChatGPT subscription | `/accounts add codex` | `oauth` (provider `codex`) | `<home>/auths` | CLIProxyAPI Codex executor ("Sign in with ChatGPT") |
| OpenAI API key | `/accounts add openai-api-key` | `api-key` (provider `openai-api`) | `<home>/api-accounts.json` | `openai-api` |
| Config-file API key | `api-keys` in `<home>/config.yaml` | `api-key` | `config.yaml` | CLIProxyAPI |

Config-file accounts are read-only through the broker API. Disable, enable and delete return 409 for them, and the user edits `config.yaml` and restarts the broker instead. Clearing a cooldown still works on them. Accounts added through the broker are stored by the broker itself, so their secrets never enter CLIProxyAPI's store.

### Duplicate accounts

The same account cannot be added twice through the same method. Different methods for one person stay allowed, for example a Claude subscription next to API credits. Messages are written for users, and the harness shows them as-is.

| Method | Counted as a duplicate | Answer |
| --- | --- | --- |
| API key | Name already used | 409 `An API key account named <name> already exists.` |
| API key | Same key in the broker store or in `config.yaml` | 409 `This API key is already added as <label or id>.` Checked before the key is validated against the API. |
| API credits | Name already used, or a sign-in under that name still running | 409 at login start, before `ant` runs. `ant` keeps one profile per name, so a second login would overwrite the first account's tokens. |
| API credits | Same Console organization (`organization_uuid` from `ant auth print-credentials`) under another name | The login ends with `status: error` and `This Claude Console organization (<org name>) is already added as <name>.` The new profile is signed out with `ant auth logout`. The existing profile is never touched. |
| Subscription (Claude, ChatGPT) | Signing in to an account that is already added | The login ends with `status: error` and `<email or id> is already added as a <Claude\|ChatGPT> subscription. Its sign-in was renewed; no account was added.` |

The final name, key and organization check for broker-managed accounts runs under the store lock (`apiAccounts.add`), so two concurrent adds cannot both pass. The checks before it only fail fast.

CLIProxyAPI names a subscription credential after the signed-in identity, so a repeated sign-in rewrites the existing credential instead of adding a row. The broker cannot stop that rewrite, because the credential is already saved when the login ends. The tokens are renewed and the account keeps its `disabled` setting, so the broker only reports the login as a duplicate. It records the existing accounts and their credential versions when a login starts (`loginbaseline.go`) and compares them when the login ends. Codex reports the credential it wrote, so the broker checks that id against the recorded set. Claude does not report it, so the broker treats a login that added no account but rewrote an existing credential as the duplicate. The first answer is kept, so repeated status polls agree.

The official CLI binaries (`claude`, `codex`) are not supported as backends. Each CLI owns its own agent loop and tools, so it cannot stand in for a model endpoint under Pi's loop. The broker uses the provider's API or the client emulation that CLIProxyAPI already implements.

Provider terms differ between these kinds. Anthropic's Claude Code legal page states that subscription OAuth is intended for Claude Code and Anthropic's native apps, and that products built on Claude should use API keys. Choose account kinds accordingly.

## Claude API accounts

CLIProxyAPI's Claude executor is built for Claude subscriptions. It treats every OAuth token as a Claude Code login and rewrites requests to look like Claude Code. API-credit logins from `ant` produce tokens with the same prefix (`sk-ant-oat`), but they are plain API credentials, and the rewrite would be wrong for them.

Example: a Pi request for `claude-sonnet-4-5` on an API-credit account reaches CLIProxyAPI's Claude executor. The executor sees an OAuth token and emulates Claude Code, so the request no longer matches the body Pi sent, and it is treated as a subscription login. Routing it through the `claude-api` executor avoids this. That executor sends the Messages body unchanged to `https://api.anthropic.com/v1/messages` (or the `--anthropic-base-url` value). Requests carry `X-Api-Key` for API keys. API-credit tokens use `Authorization: Bearer` with `anthropic-beta: oauth-2025-04-20`. CLIProxyAPI still selects, pools, cools down and retries these accounts, because they are registered as runtime auths with the same executor interface.

The executor accepts only Anthropic Messages requests. It also forwards the `Anthropic-*` headers and `User-Agent` that Pi sends. It turns a 400 response that says the credit balance is too low into a 402 with `Retry-After: 3600`. The account then rests for one hour, and a pool moves on to another account in the meantime. Credits refresh per billing cycle, so the hour is a retry interval, not a reset time.

### API-credit sign-in through ant

API-credit accounts sign in with Anthropic's official `ant` CLI, which opens the Claude Console in the browser and returns an access token that it refreshes when needed. The broker pins the release `ant` 2.9.0. If `CREDNE_ANT` is set, that binary is used as is and nothing is downloaded. Otherwise the broker downloads the release archive for the current platform into `<home>/bin` on first use. The archive's SHA-256 is compiled into the broker (`ant.go`), so a download is verified against a value the broker carries, not one fetched beside the archive. A mismatch aborts the install. Supported platforms are Linux (386, amd64, arm64, armv6), macOS (amd64, arm64) and Windows (386, amd64, arm64).

The broker runs `ant` with `ANTHROPIC_CONFIG_DIR=<home>/ant`, so its profiles are separate from any `ant` profiles the user has. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are blanked for these calls, because an inherited key would take precedence over the profile. Tokens are cached in memory per profile and refreshed three minutes before expiry. Calls for one profile are serialized, because `ant` rotates the refresh token on each refresh.

## Routing

A pinned route (`a.<key>`) passes `WithPinnedAuthID` and `ForcedProvider` to CLIProxyAPI. Its selector then considers only that account. If the account is missing, disabled, cooling down or failing, the request fails with the upstream status or with `auth_not_found`. Pinned routes never use the reasoning rewrite described below, because the account never changes within a pinned conversation.

A pool route (`p.<name>`) passes no pin. CLIProxyAPI chooses among the enabled accounts that serve the model. The default strategy is `round-robin`, and `routing.session-affinity` is `true`, so a conversation stays on one account while that account is usable. The broker keys a conversation on a session header when one is present: `X-Session-Affinity`, `Session-Id` or `X-Session-Id`. The extension enables the `X-Session-Affinity` header for Claude models. Without a session header, every request is balanced independently.

Failover within a pool is bounded. `routing.retry.request-retry` is 1, so one extra selection round follows the first, and `max-retry-interval` is 15 seconds, so a cooldown longer than that is not waited out. Pi's own retry policy applies on top.

Every response names the account that served it in the `X-Credne-Account` header, base64url encoded as the account key. For pinned routes it is always the pinned account. For pools it is CLIProxyAPI's selection. The extension uses this header for the footer line that shows the serving account.

## Reasoning continuity across accounts

Reasoning is the model's private thinking. Providers protect it so it can be replayed: Anthropic signs thinking blocks, and OpenAI encrypts reasoning items. The signature or encryption is valid only for the account that produced it, so replaying it to another account fails.

### The problem

Example trace on `pool:claude`:

1. Account A serves turn 1 and returns a thinking block with a signature.
2. Account A reaches its rate limit, so the pool sends turn 2 to account B.
3. Pi replays turn 1 including the thinking block. Pi still sees one provider and one model, so it keeps the signature.
4. Account B rejects the request with a 400 error about an invalid signature, and the conversation stops.

Pinned accounts do not have this problem, because switching accounts changes the Pi provider name and Pi itself summarizes earlier reasoning. The problem occurs only inside a pool, where the provider name stays the same.

### The fix

The broker replaces replayed reasoning with a short labeled text summary. The label is `[Reasoning summary from an earlier turn, not shown to the user]`, and it is the same string Pi uses when it changes accounts itself (`REASONING_SUMMARY_LABEL` in `packages/ai`). The label tells the model that the text is earlier private reasoning, so it does not continue it as part of its visible reply. Each summary is capped at 1500 characters. Visible text, tool calls and tool results are not changed. Redacted thinking is dropped, because it has no readable text.

The broker applies the rewrite in two cases. Proactively, before sending, when the account that served the conversation's previous request is no longer selectable (disabled, cooling down, or out of quota). Reactively, when an account rejects a pool request with a 400 whose message names an invalid encrypted content or thinking signature. In the reactive case the broker rewrites the body and retries once. A second rejection is returned as is.

For Anthropic requests, a thinking block that answers an in-flight tool result has a special rule. While thinking is on, Anthropic requires the assistant turn that the tool result answers to start with its thinking block. If the rewrite removes that block, the broker sets `thinking` to `disabled` for that one request, so the request is accepted. For Responses requests, each reasoning item becomes an assistant message holding its summary text, or is removed when it has no summary.

## Home directory layout

The home directory defaults to `$PI_CODING_AGENT_DIR/accounts`, or `~/.pi/agent/accounts`. Its contents are:

| Path | Contents | Written by |
| --- | --- | --- |
| `broker.json` | Discovery record: URL, per-run token, PIDs and versions. Removed on clean exit. | Broker |
| `broker.lock` | OS lock that keeps one broker per home. | Broker |
| `broker.log` | Broker log. | Broker process output |
| `config.yaml` | Optional user configuration (routing, retries, config-file API keys). Never modified by the broker. | User |
| `runtime/config.yaml` | Generated CLIProxyAPI configuration with the enforced settings applied. | Broker |
| `auths/` | OAuth credentials for subscription accounts. | CLIProxyAPI |
| `api-accounts.json` | Broker-managed API-key and API-credit accounts, including API keys in plain text, owner-only. | Broker |
| `ant/` | Profiles of the `ant` CLI, including refresh tokens (`ANTHROPIC_CONFIG_DIR`). | `ant` |
| `bin/ant` (or `ant.exe`) | Downloaded `ant` release, unless `CREDNE_ANT` is set. | Broker |
| `catalog.json` | Account and model catalog for the extension. Contains no secrets. | Pi extension |

## IPC contract (v1)

The base URL and token come from `<home>/broker.json`, written atomically with owner-only permissions after the broker answers its own health check. Every request carries `Authorization: Bearer <token>` or `x-api-key: <token>`. Account keys are base64url (no padding) of the CLIProxyAPI auth id.

| Method and path | Purpose |
| --- | --- |
| `GET /credne/v1/health` | Liveness, versions, process id, start time, account count |
| `POST /credne/v1/shutdown` | Stop the broker for all harness processes |
| `GET /credne/v1/accounts` | Accounts: id, key, provider, kind, source, label, email, plan, status, disabled, quota and cooldown, last error, model count. Never credentials. |
| `GET /credne/v1/accounts/{key}/models` | Models the account can serve |
| `GET /credne/v1/accounts/{key}/usage` | Normalized live subscription quota windows and supported provider-reported credits, or an explicit unavailable/unsupported reason. Never credentials or raw upstream bodies. |
| `POST /credne/v1/accounts/{key}/disable`, `/enable` | Toggle an account |
| `POST /credne/v1/accounts/{key}/reset` | Clear cooldown and quota state |
| `DELETE /credne/v1/accounts/{key}` | Remove a subscription account and its stored credential, or a broker-managed API account. For API-credit accounts, also runs `ant auth logout`. |
| `POST /credne/v1/api-keys` `{provider, name, key}` | Add a provider API key. `provider` accepts `claude`, `anthropic`, or `openai`. The broker lists models with the key before storing it. Duplicate names or keys return 409. |
| `POST /credne/v1/logins` `{provider, name}` | Start a login. `provider` is `claude`, `codex` or `claude-api-credits` (which needs `name`). Returns `{state, url, flow, userCode}`. Subscription logins start CLIProxyAPI's local callback listener; API-credit logins start `ant`. An API-credit name that is taken returns 409. |
| `GET /credne/v1/logins/{state}` | `{status: wait\|ok\|error, error, account}`. A login that only renewed an existing account, or that signed in to an organization already added, ends as `error` with an explanation. |
| `POST /credne/v1/logins/{state}/callback` `{redirectUrl}` | Complete a login manually, for remote or headless sessions |
| `DELETE /credne/v1/logins/{state}` | Cancel a login |
| `POST /credne/v1/route/{target}/v1/messages` | Anthropic Messages, native |
| `POST /credne/v1/route/{target}/responses` | OpenAI Responses, native |
| `POST /credne/v1/route/{target}/chat/completions` | Chat Completions, translated by CLIProxyAPI for providers without a native Pi adapter |
| `POST /credne/v1/route/{target}/decisions` | OpenAI Decisions API (`POST /v1/decisions`), forwarded unchanged. Only OpenAI API-key accounts and `p.openai` serve it; see "Decisions API" |

`{target}` is `a.<key>` for a pinned account or `p.<name>` for a pool. Responses are SSE in the request's protocol. Errors use the protocol's own envelope (Anthropic `{"type":"error","error":{...}}`, OpenAI `{"error":{...}}`). They carry the upstream status and `Retry-After`, and they name the account, for example `account a@example.com (claude): rate limited`.

## Decisions API

OpenAI's Decisions API (`POST /v1/decisions`, model `gpt-6-luna`) classifies a state with structured questions. It accepts only an OpenAI API key; OpenAI rejects Sign in with ChatGPT tokens on this route. CLIProxyAPI v8.0.70 has no support for it (and none for TypeSafe or System One), and it is not a chat protocol, so `decisions.go` does not go through CLIProxyAPI's request execution. It reads the request body, picks an account, and sends the body to `<openai base URL>/v1/decisions` with `AuthManager.HttpRequest`, which lets the registered `openai-api` executor set the account's `Authorization` header. The upstream status and body come back unchanged, including errors; only `Content-Type`, `Retry-After` and `X-Request-Id` are passed on, plus `X-Credne-Account` with the serving account.

| Target | Result |
| --- | --- |
| `a.<key>` of an OpenAI API-key account | Served by that account and never rerouted. A missing account is 404, a disabled one 403. |
| `a.<key>` of any other account, such as a ChatGPT subscription | 400, nothing is sent upstream. |
| `p.openai` | `AuthManager.SelectAuth` picks an enabled OpenAI API-key account whose model list has the requested model, as for chat. None is 503. |
| any other pool | 400. |

A Decisions failure is not recorded in the account's cooldown and quota state, so it never cools the account for chat. A pinned route ignores that state; `p.openai` skips accounts that are cooling. A pinned account's concurrency limit applies. Covered by `TestDecisionsRoute`.

## Live subscription usage

`usage.go` queries only `https://api.anthropic.com/api/oauth/usage` for Claude OAuth subscriptions and `https://chatgpt.com/backend-api/wham/usage` for Codex subscriptions. CLIProxyAPI v8 has no built-in live quota facade; the broker does not call plugin-only or removed management quota endpoints. API-key/API-credit accounts and other providers return `unsupported` with a reason without making a request.

Requests use `AuthManager.NewHttpRequest` and `HttpRequest` with the selected auth, preserving executor credentials, proxy routing and provider transport. Claude requests include `anthropic-beta: oauth-2025-04-20`; Codex requests include the selected `Chatgpt-Account-Id` when present. A request-scoped transport guard allows only the fixed GET destination and suppresses redirects. Requests time out after 10 seconds, response bodies are bounded to 256 KiB, and errors expose only static reasons or HTTP status, not provider bodies or transport diagnostics.

The response has `status: available|unavailable|unsupported`, a `reason` for non-available results, `windows: [{label, usedPercent, resetAt?}]`, and `credits: [{label, amount?, unit, unlimited?}]`. Missing percentages are omitted rather than fabricated as zero; missing reset times stay missing. Claude extra-usage figures retain provider credit units, and Codex balances retain provider credits; the broker does not infer currency conversions or billed subscription charges. Only allowlisted fields are returned. The account panel displays resets in local time.

Quota windows and credits are provider subscription data, not estimates from session tokens. The harness separately sums recorded `AssistantMessage.usage.cost` for the selected pinned provider and labels it as session API-rate estimates, never subscription billing. Pool response costs remain separately labeled unattributed; the current serving account is not used to guess historical attribution.

## Guarantees

**Pinning.** A pinned route passes `WithPinnedAuthID` and `ForcedProvider`. CLIProxyAPI's selector then considers only that account. A missing, cooling or failed account returns an error and is never replaced. Pools are separate routes, so load balancing cannot override a pin. Covered by `TestBroker/pinned_*`.

**Continuation state on account switch.** A pinned switch changes the Pi provider, so Pi summarizes earlier reasoning itself, as described in `packages/ai`. Inside a pool the broker performs the same rewrite (see "Reasoning continuity across accounts"). Anthropic message threads are disabled for broker models, because they are server-side state bound to one account. Covered by `packages/coding-agent/test/accounts-extension.test.ts` ("switching accounts keeps history and replays the previous account's reasoning as a summary") and by `TestBroker/a_pool_replaces_reasoning_another_account_rejects_with_a_summary_and_retries`.

**Credential isolation.**
- Subscription tokens live in `<home>/auths`. API keys live in `<home>/api-accounts.json`, and API-credit refresh tokens live in `<home>/ant`. All are owner-only. Credentials also exist in broker memory, where the `ant` access tokens are cached.
- The account API is built field by field from CLIProxyAPI's auth records, so credential storage and metadata are never serialized.
- Pi holds only the per-run broker token, which is useless outside loopback and changes on every start. The gate strips `Authorization`, `x-api-key` and cookie headers before CLIProxyAPI sees a request, and the executor injects the account's own credential.
- Management routes run with a random per-run secret that nothing outside the process knows. The broker token serves as the localhost-only management password, and the gate admits management paths only for in-process calls.
- Broker logs go to `<home>/broker.log`. CLIProxyAPI masks keys in its logs, and debug logging is off unless `--debug` is passed.
- Pi's file tools (`read`, `edit`, `write`) are blocked from the broker home. Shell tools run as the same OS user and could still read it, as they can read Pi's `auth.json`. Strict isolation needs the broker under a separate OS user or a sandboxed shell.
- Trust boundary: the OS user. Every harness process of that user can use every account through the broker. Per-session capability tokens are a possible extension.

## Failure handling

| Situation | Behavior |
| --- | --- |
| Pinned account rate-limited or out of quota | Upstream status (429) and `Retry-After` returned to Pi. CLIProxyAPI cools the account. Pi's retry policy decides. No other account is used. `/accounts` shows "cooling down until ...". |
| Pinned API-credit or API-key account with no credits | 402 with `Retry-After: 3600`, returned to Pi. The account rests for one hour. No other account is used. |
| Pinned account disabled or removed | 403 or 404 naming the account. |
| Pool account fails | CLIProxyAPI tries the next eligible account in the same request, within the retry limits above. |
| Pool reasoning rejected by the new account | The broker rewrites the reasoning as summaries and retries once. |
| Expired OAuth token | CLIProxyAPI refreshes it in the background and on 401. |
| `ant` not installed and download fails | The request fails with `install ant 2.9.0: ...`. Set `CREDNE_ANT` to a local `ant` binary to avoid the download. |
| Client disconnects or Pi aborts | The request context is cancelled, and the upstream request is closed. |
| Broker stopped, idle-exited or crashed | Pi's next request finds no healthy broker and starts one. The OS lock keeps one broker per home. |
| Concurrent starts from several terminals | One wins the lock. The others exit with status 0, and clients wait for the new discovery record. |
| Too many requests on one account | Optional `--max-concurrency-per-account N` queues pinned requests until a slot frees or the client disconnects. |

## Build and run

Requires Go 1.26.10 or newer.

```bash
cd broker
go build -ldflags "-s -w -X main.version=0.1.0" -o ~/.pi/agent/bin/credne-broker ./cmd/credne-broker   # .exe on Windows
go test ./...
```

Pi finds the binary through `PI_ACCOUNTS_BROKER` first, then the `bin` directory next to the Pi package, then `~/.pi/agent/bin`, then `PATH`. It starts the broker on demand with `--home` set to the accounts directory, and the broker runs detached, so it outlives the Pi process that started it.

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--home` | `$PI_CODING_AGENT_DIR/accounts` or `~/.pi/agent/accounts` | Broker home (see the layout table). |
| `--idle-timeout` | `30m` | Stop after this long without API requests. `0` keeps the broker running until stopped. |
| `--max-concurrency-per-account` | `0` | Maximum in-flight requests per pinned account. `0` means unlimited. |
| `--anthropic-base-url` | `https://api.anthropic.com` | Endpoint for API-key and API-credit accounts. Used for proxies and tests. |
| `--openai-base-url` | `https://api.openai.com` | Official API endpoint for OpenAI API keys. |
| `--debug` | off | Debug logging. Tokens are never logged. |
| `--version` | | Print the version and exit. |

Environment variables: `PI_ACCOUNTS_BROKER` (Pi: broker binary location), `CREDNE_ANT` (broker: path to an `ant` binary, skipping the download), and `PI_CODING_AGENT_DIR` (default home).

Manual start, for example to keep the broker running without Pi:

```bash
credne-broker --home ~/.pi/agent/accounts --idle-timeout 0 --max-concurrency-per-account 0
```

The broker uses about 45 MB of memory when idle.

### Tests

- `go test ./...` runs the broker against fake provider upstreams with the real CLIProxyAPI executors. It covers pinning, no fallback, pool failover, cancellation, framing, the gate, the login facade, the `claude-api` executor, the `ant` installer (with a fake `ant` in `testdata/fakeant`) and reasoning rewrites.
- `packages/coding-agent/test/accounts-extension.test.ts` runs the Pi extension against a fake broker.
- `packages/coding-agent/test/accounts-broker-e2e.test.ts` runs Pi's adapters through the real broker binary. It is skipped unless `PI_ACCOUNTS_BROKER` points at a build. Run it after every CLIProxyAPI upgrade.

## Upgrading CLIProxyAPI

```bash
go get github.com/router-for-me/CLIProxyAPI/v8@<tag> && go mod tidy && go test ./...
```

Keep the `replace github.com/MoeForge/moego` line in `go.mod` in sync with upstream's `go.mod`. Go does not apply a dependency's `replace` directives, so the broker repeats the one that CLIProxyAPI needs. `verifyRuntimeConfig` fails startup if an upstream configuration change stops the enforced settings from applying.

## License

credne-broker links CLIProxyAPI, distributed under the MIT license. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Binary distributions must include that notice.
