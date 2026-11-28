# credne-broker

Credne keeps its CLI and agent loop on Node. One Bun daemon per accounts home owns shared provider credentials and requests. It uses the unmodified `@oh-my-pi/pi-ai` 19.1.0 auth storage, OAuth providers, model catalog, and auth gateway.

All Credne instances discover the same daemon through `broker.json`. They do not start separate provider cores. Chat history, tools, and agent loops remain in each CLI session.

## Build and run

Install workspace dependencies with npm. Source execution and compilation require Bun 1.4.4 or newer:

```sh
npm --prefix broker run start -- --home ~/.pi/agent/accounts
npm --prefix broker run check
npm --prefix broker run test
npm --prefix broker run build
```

The build creates `broker/dist/credne-broker` (`.exe` on Windows) and copies platform `.node` sidecars beside it. Distribute these files together. Bun includes SQLite in the executable. The model catalog is bundled; startup needs no model download.

Credne finds the executable through `PI_ACCOUNTS_BROKER`, its package `bin` directory, `~/.pi/agent/bin`, then `PATH`. It starts the daemon detached when needed.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--home` | `$PI_CODING_AGENT_DIR/accounts` or `~/.pi/agent/accounts` | Shared accounts home |
| `--idle-timeout` | `30m` | Exit after inactivity; `0` disables idle exit |
| `--max-concurrency-per-account` | `0` | In-flight inference limit per account; `0` is unlimited |
| `--anthropic-base-url` | `https://api.anthropic.com` | Anthropic API-key endpoint |
| `--openai-base-url` | `https://api.openai.com` | OpenAI API-key endpoint |
| `--typesafe-base-url` | `https://api.typesafe.ai` | TypeSafe API-key endpoint |
| `--debug` | off | Log daemon lifecycle metadata; never provider bodies or credentials |
| `--version` | | Print broker version |

Base URL overrides apply only to API-key accounts. Subscription requests, including model discovery, use OMP’s provider endpoints. For third-party Claude use, choose an Anthropic Console API key unless Anthropic has authorized your integration; using OMP for sign-in does not grant that authorization.

## Shared daemon lifecycle

The daemon binds `127.0.0.1` on an OS-selected port. It publishes owner-only discovery atomically after its health check succeeds. Each run creates a new bearer token.

An atomic per-home lock serializes concurrent starts. Losing processes exit successfully so clients attach to the winner. A heartbeat supports crash recovery. A live-owner record prevents a delayed heartbeat from creating a second core beside a stalled daemon. Live but unhealthy discovered processes require an explicit stop or retry. Startup never kills another process.

Idle shutdown waits for HTTP response bodies, upstream streams, and pending logins to finish. Disconnects cancel upstream requests. Stopping one CLI does not stop the daemon. Authenticated `POST /credne/v1/shutdown` stops it for all clients.

Before upgrading an already running legacy broker, stop it explicitly. Health identifies this backend with `backend: "oh-my-pi"`. Neither the new client nor daemon silently starts beside a live legacy process.

## Architecture

OMP owns every provider request. The broker chooses the account and observes the outcome.

Problem: a request that the broker reshaped could differ from what OMP itself sends. A rewritten cache marker or a dropped signature would then fail only through the broker, and OMP's own recovery would never see it.

Credne sends OMP pi-native requests to OMP’s auth gateway router. Claude requests always use the client’s original pi-native bytes. The only optional change to the conversation layout is for eligible first-party OpenAI models: the broker can represent newly discovered tools as native `additional_tools` history items instead of adding them to the start of the conversation. All provider-wire conversion remains with OMP. OMP resolves the account's credential and refreshes it on expiry and after a 401, reshapes the context for the provider, signs and compresses Claude requests, retries, and recovers from rejected thinking signatures. Provider bodies and responses pass through unchanged.

The broker's only seam is the router's `fetch`. It calls OMP's own default transport for the model: Claude Code's HTTP/1.1 TLS profile for Anthropic Messages, plain `fetch` for everything else, under OMP's User-Agent, extra CA and proxy layers. It returns the answer untouched and records its status and `Retry-After`. An Anthropic 400 that reports an empty credit balance is recorded as a 402 with a one-hour cooldown; OMP still sees the 400.

Codex uses the `session-id` header for prompt-cache routing. Sibling workers opt in with `cacheAffinity: "shared-prefix"` and an explicit `options.promptCacheKey` in their pi-native request. OMP accepts the cache key in the body but reserves its separate `parentSessionId` affinity option for server-side use. For these requests only, the broker sets the outgoing Codex `session-id` header to the cache key. OMP's credential selection, request ID, thread and continuation state still use the worker's own session. No other header is changed. Claude workers pass a separate broker-only prefix key so the pool can prefer the same account. That key does not become a Claude request option or header.

The prewarm route (`/prewarm` below) mirrors OMP's coding agent, which warms the Anthropic connection at startup, on a model change and while the user types. For each enabled account the target would route the model to, it calls OMP's `prewarmModelConnection`: a credential-less `HEAD` through the same default transport, so the next request reuses the warm socket. It takes no credential, lock or pool turn, and OMP throttles it per origin.

Reasoning, thinking signatures, cache boundaries, hosted search, Claude billing attestation and compression are OMP's. The broker has no codec for the OpenAI or Anthropic wire. Classifiers go through OMP's System One route (`/systemone` below), which serves TypeSafe's Jev and OpenAI's GPT-6 Luna.

## Accounts and routing

| Public provider | Kind | Authentication |
| --- | --- | --- |
| `codex` | `oauth` | ChatGPT browser login through pi-ai |
| `claude` | `oauth` | Claude subscription login through OMP |
| `claude-api` | `api-key` | Anthropic API key |
| `openai-api` | `api-key` | OpenAI API key |
| `typesafe` | `api-key` | TypeSafe API key; classifier models for System One, never chat |

To move from a local `claude-sub:` account, sign in again with `/accounts add claude-subscription` and select the new account in `/model`. Credne leaves the old local credentials on disk. Console credit profiles are not OMP credentials; use an Anthropic API key for API billing.

Each account has its own pi-ai SQLite auth store and gateway router inside the shared daemon. Each store contains only that account. Pinned routes cannot select siblings, including inside pi-ai authentication retries.

`acct:<id>` addresses `a.<base64url id>`. A missing, disabled, cooling, or rejected pinned account fails without fallback.

`pool:all` addresses `p.all`. Family pools are `p.claude`, `p.codex`, and `p.openai`. Pools use only enabled accounts that list the model. A request names its model as `modelId`, either bare (`claude-sonnet-5`) or with OMP's provider (`anthropic/claude-sonnet-5`). TypeSafe accounts are never chat candidates, so they cannot make `p.all` ambiguous. Claude keys and subscriptions share a family. OpenAI API billing and ChatGPT subscriptions remain separate families.

For pooled chat, the broker asks OMP whether each candidate's stored credential is subscription-backed. It tries eligible subscription accounts before ordinary API keys, even if a key served the previous turn. For example, `p.all` prefers a ChatGPT subscription over an OpenAI API key for a GPT model offered by both. The configured strategy and session affinity apply within each group. A pool can fall back to a paid API key; pin a subscription to rule out that charge. The default strategy is round-robin. Affinity follows the request's `options.sessionId`. For a new worker session that opts into shared-prefix routing, affinity first prefers the account that last served that prefix for the same pool and model, subject to the usual priority and failover rules. `X-Credne-Account` identifies the selected account with its base64url key.

### Failover

A pinned request is never cut short. OMP's own retries, token refresh and recovery run to the end, and the broker records the final outcome: a rate limit, an unpaid balance or an unavailable provider (429, 402, 503) puts the account in cooldown, and a pinned request to a cooling account is refused without a call.

A pooled request may be cut short only when another account can take over. The broker aborts the attempt at the first provider answer that is a failover status and tries the next account. That is 429, 402 (including the credit-balance 400), any 5xx, or a request that never got an answer. The caller sees no frame of the abandoned attempt: the broker holds the stream until the transport has seen the provider's answer. A 401 or 403 is different. OMP refreshes the credential and retries, so the broker waits for that: only if OMP gives up with an auth failure does the pool move on. Other 400s never fail over, so OMP's thinking-signature recovery runs on the same account. The last account of the last round, and a pool without an available sibling, run like a pinned account. `request-retry` adds rounds over the candidates.

### Credential lock

Problem: when an OAuth account cannot serve (its credential is blocked after a usage limit, or its refresh failed), OMP's key cascade moves on to the next source, including an `ANTHROPIC_API_KEY` in the broker's environment. A subscription request would be billed to a key nobody chose.

Solution: while a request runs, the broker restricts its session to that account's identity with `sessions.restrict`, and OMP fails the request instead. The restriction must name the exact session id OMP resolves credentials under, so every `/pi/stream` request must carry `options.sessionId`; without it the route answers 400. API-key accounts need no lock, because their key is OMP's runtime override, which the cascade reads first.

### Account management

Beyond the legacy account IDs above, `/providers` lists supported OMP provider IDs and authentication methods. The broker uses OMP's key validator or authenticated catalog descriptor before storing a key. Some validators send a small inference request that may incur a charge. For descriptor-based enrollment the broker intersects the returned model IDs with supported chat models in the bundled catalog. Anthropic and OpenAI keys are checked and listed through the same catalog descriptors, against the account's own base URL: embedding, speech and judge models are left out, model IDs the catalog lacks are kept, and only the provider itself ever sees the key. A validated key is not proof of access to every model. Cloud credential chains, native CLI adapters and sign-ins that need unsupported prompts or host state are not advertised. A TypeSafe key is validated by listing its models with OMP's authenticated TypeSafe discovery; those model names become its `classifier` models. Duplicate names and keys return 409. Final duplicate checks and writes are serialized.

Subscription login supports browser redirects, manual callback submission, status, and cancellation. Callbacks must match the pending redirect destination and state. Signing in to an existing identity renews its credential but reports that no account was added. Its disabled setting remains.

### Read-only user configuration

Edit `config.yaml` and restart to change its accounts. Enable, disable, and delete return 409 for config accounts. Cooldown reset still works.

```yaml
routing:
  strategy: round-robin
  session-affinity: true
  retry:
    request-retry: 1
api-keys:
  claude:
    - name: work
      base-url: https://api.anthropic.com
      models:
        - name: claude-sonnet-4-5
      keys:
        - api-key: YOUR_KEY
```

`openai` and legacy `codex` groups use the same structure. A `codex` key requires its original `base-url`; requests go to `<base-url>/responses`. Claude and Codex configurations in this subset retain their legacy account IDs, including distinct IDs for keys that differ only by routing headers. A key's `headers` or `models` replaces the corresponding group setting. Headers and the base URL are set on the OMP model, so they reach chat requests like any other model header.

The broker accepts literal model names and custom headers that do not override credentials or transport controls. Unsupported options such as a proxy, model alias, provider prefix, or weighted routing stop startup with a diagnostic instead of silently changing which account or upstream serves a request. Back up `config.yaml` before adapting it; the broker does not edit it.

## IPC v1

Read URL, token, and PID from `<home>/broker.json`. Supply `Authorization: Bearer <token>` or `x-api-key: <token>`. Account keys are base64url encodings of IDs.

| Method and path under `/credne/v1` | Result |
| --- | --- |
| `GET /health` | Backend, versions, PID, start time, account count |
| `POST /shutdown` | Stop shared daemon |
| `GET /accounts` | Credential-free account descriptions |
| `GET /accounts/{key}/models` | Account model descriptions: ID, kind, limits, cost, and the OMP `provider` and `api` the account's router resolves the model to |
| `GET /accounts/{key}/usage` | Normalized live subscription windows and credits |
| `POST /accounts/{key}/disable`, `/enable` | Change account state |
| `POST /accounts/{key}/reset` | Clear cooldown |
| `DELETE /accounts/{key}` | Remove account and credential |
| `GET /providers` | List supported provider IDs, names, and enrollment methods. |
| `POST /api-keys` `{provider,name,key}` | Validate and add a key for an advertised API-key provider. |
| `POST /logins` `{provider}` | Start an advertised OAuth flow. Show any `riskWarning` before continuing. Device-code flows supply a verification URL and user code. |
| `POST /logins/{state}/acknowledge` `{"answer":"yes"}` | Continue only after the user accepts the displayed warning. If they decline, cancel with `DELETE /logins/{state}`. |
| `GET /logins/{state}` | `wait`, `ok`, or `error`; optional account/error |
| `POST /logins/{state}/callback` `{redirectUrl}` | Submit complete browser redirect |
| `DELETE /logins/{state}` | Cancel login |
| `POST /route/{target}/pi/stream` | OMP pi-native stream, for any account or pool |
| `POST /route/{target}/pi/cache-refresh` | Optional one-token cache refresh on a pinned Claude account; one upstream attempt, no queue or failover |
| `POST /route/{target}/prewarm` `{modelId}` | Best-effort connection warm-up for the accounts the target would use; 204 at once, 400 without `modelId` |
| `POST /route/{target}/systemone` | System One judgments, for a pinned TypeSafe or OpenAI API key, `p.typesafe` or `p.openai` |

`/pi/stream` accepts `{modelId, context, options, stream}` and `x-omp-*` attribution headers. A Credne client may also send a `toolTimeline` hint: the positions and names of newly active tools. It still includes the complete active definitions in `context.tools`, so older brokers and ineligible routes do not lose tools. The serving model must support `additional_tools`, and the projection must preserve schema semantics and tool-call/result ordering; otherwise the broker uses the original request. Only the broker's `Authorization` and `x-api-key`, `Host` and connection headers are removed before the bytes go to OMP. OMP's router answers as its HTTP server would: an SSE stream of pi-native events ending in `data: [DONE]`, or `{error: {type, message}}` with a status for what it refuses before a provider is asked. A provider failure after the stream began, such as a 429 that OMP gave up on, arrives as OMP's `error` event. Broker-side refusals use the same error envelope with `Retry-After` where known: 400 for a malformed body or a missing `modelId` or `options.sessionId`, 403 for a disabled pinned account, 404 when no enabled account serves the model, 409 when `p.all` would mix providers, 429 for a cooling account.

An older broker rejects the separate cache-refresh path without sending a provider request. The client does not retry it as an ordinary chat request.

System One requests go through OMP's own `/v1/systemone` route with the selected account's key, so OMP validates the body, picks the dialect of the account's judge (TypeSafe's System One, or OpenAI Decisions for GPT-6 Luna), adds the image opt-in header for requests that carry images, and decodes the answers. The response is OMP's `{model, answers, usage}`. OMP's route accepts `noul`, `choice`, and `score` questions only; `box` questions return 422. An OpenAI key serves `gpt-6-luna` when it lists that model. Pools are `p.typesafe` and `p.openai`. For TypeSafe, a failover status (401, 402, 403, 429 or any 5xx) moves a pool on to its next account, and 429, 402 and 503 also put the account in cooldown. An OpenAI key is shared with chat, so a failed classification neither cools it nor moves the pool. Other statuses pass through without cooldown, and errors carry the status and `Retry-After` without raw provider bodies. OMP sends no model headers on this route, so configured routing headers do not apply to it.

Live usage is OMP's own: its usage providers read the account's Claude or ChatGPT subscription windows with its credential, base URL, timeouts and five-minute cache. The broker maps OMP's limits to windows (percent limits) and credits (every other unit); values it cannot show are left out and missing values stay missing. API keys and providers without a usage endpoint return an explicit unsupported reason. Session token cost is not subscription billing.

## Storage and security

| Path | Contents |
| --- | --- |
| `broker.json` | Per-run discovery and token |
| `broker.lock.d`, `broker.owner.json` | Singleton lock and owner |
| `omp-accounts.json` | OMP broker account metadata; provider secrets are stored separately |
| `api-accounts.json` | Legacy Go broker metadata and API keys; kept for rollback |
| `credentials/<base64url id>.db` | pi-ai credentials and refresh state |
| `auths/` | Subscription files from the legacy Go broker |
| `config.yaml` | User configuration |
| `broker.log` | Lifecycle output captured by launcher |

Storage directories and credentials are owner-only. Existing Codex and managed API-account IDs remain stable. During the initial migration, the broker imports legacy managed API keys and Claude and Codex subscription files without replacing the Go broker's records. It leaves former Console credit profiles on disk, but does not list or route those accounts.

The gate rejects foreign Host and Origin values. Only broker routes and validated pending OAuth callbacks are exposed. The broker's own token is removed before dispatch, and OMP forwards only its allow-listed request headers, never cookies or caller credentials. The selected account supplies its credential. Logs never contain provider bodies or credentials. A provider's error message reaches the caller inside OMP's error event, as it does from OMP's own gateway.

The trust boundary is the OS user. Shell tools and other applications under that user can read private storage. Stronger isolation requires separate OS users or sandboxing.

## Tests and upgrades

`bun test test` uses isolated homes and local fake upstreams with the real pi-ai gateway/provider stack. Tests compare what a fake provider receives through the broker with what OMP's own router sends for the same request, and cover pinning, pools, failover, the credential lock, gate security, duplicate adds, enrollment, OAuth callbacks, usage, System One, and separate-process singleton/crash recovery. Claude's default transport only dials HTTPS hosts itself, and hands any other URL to `fetch`, which is how the fakes are reached.

Node-side account tests remain in `packages/coding-agent/test`. Set `PI_ACCOUNTS_BROKER` to the compiled executable for broker end-to-end tests.

After upgrading pi-ai, run broker checks/tests, compile, then run Node adapter end-to-end tests. Inspect the pi-native route, the gateway's caller trust (`auth-gateway/caller-options.ts`) and the default transport choice (`utils/transport-fetch.ts`) before changing the version.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled software notices.
