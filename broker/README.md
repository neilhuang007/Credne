# credne-broker

Credne keeps its CLI and agent loop on Node. One Bun daemon per accounts home owns shared provider credentials and requests. It uses the unmodified `@oh-my-pi/pi-ai` 19.0.0 auth storage, OAuth providers, model catalog, and auth gateway.

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
| `--debug` | off | Log daemon lifecycle metadata; never provider bodies or credentials |
| `--version` | | Print broker version |

Base URLs support local fake upstreams. Config accounts can set `base-url` independently.

## Shared daemon lifecycle

The daemon binds `127.0.0.1` on an OS-selected port. It publishes owner-only discovery atomically after its health check succeeds. Each run creates a new bearer token.

An atomic per-home lock serializes concurrent starts. Losing processes exit successfully so clients attach to the winner. A heartbeat supports crash recovery. A live-owner record prevents a delayed heartbeat from creating a second core beside a stalled daemon. Live but unhealthy discovered processes require an explicit stop or retry. Startup never kills another process.

Idle shutdown waits for HTTP response bodies, upstream streams, and pending logins to finish. Disconnects cancel upstream requests. Stopping one CLI does not stop the daemon. Authenticated `POST /credne/v1/shutdown` stops it for all clients.

Before upgrading an already running legacy broker, stop it explicitly. Health identifies this backend with `backend: "oh-my-pi"`. Neither the new client nor daemon silently starts beside a live legacy process.

## Accounts and routing

| Public provider | Kind | Authentication |
| --- | --- | --- |
| `codex` | `oauth` | ChatGPT browser login through pi-ai |
| `claude` | `oauth` | Claude subscription login through OMP |
| `claude-api` | `api-key` | Anthropic API key |
| `openai-api` | `api-key` | OpenAI API key |

To move from a local `claude-sub:` account, sign in again with `/accounts add claude-subscription` and select the new account in `/model`. Credne leaves the old local credentials on disk. Console credit profiles are not OMP credentials; use an Anthropic API key for API billing.

Each account has its own pi-ai SQLite auth store and gateway router inside the shared daemon. Each store contains only that account. Pinned routes cannot select siblings, including inside pi-ai authentication retries.

`acct:<id>` addresses `a.<base64url id>`. A missing, disabled, cooling, or rejected pinned account fails without fallback.

`pool:all` addresses `p.all`. Family pools are `p.claude`, `p.codex`, and `p.openai`. Pools use only enabled accounts that list the model. Claude keys and subscriptions share a family. OpenAI API billing and ChatGPT subscriptions remain separate families.

For a Claude model, `p.claude` and `p.all` prefer an available subscription over an API key, even if a key served the previous turn. The broker uses the configured strategy and session affinity within each group. A pool can fall back to a paid API key; pin a subscription to rule out that charge. The default strategy is round-robin. The broker recognizes `X-Session-Affinity`, `Session-Id`, and `X-Session-Id`. Pools can select another eligible account on a pre-emission failure. Rate limits, insufficient credits, and temporary unavailability create cooldowns. `X-Credne-Account` identifies the selected account with its base64url key.

On pool account changes, signed Anthropic thinking and encrypted OpenAI reasoning become bounded, labeled summaries. Redacted reasoning is removed. Visible text, tool calls, and results remain. A thinking-signature rejection receives one rewritten retry. Anthropic thinking is disabled for an in-flight tool-result turn if its required thinking block was removed.

Requests use pi-ai's gateway and providers. A transport bridge restores native hosted-search definitions and non-streaming results that the generic codec drops. It retains Codex `web_search_call.action.sources` and Anthropic `web_search_tool_result` output.

### Account management

API keys are validated through the provider model endpoint before storage. Duplicate names and keys return 409. Final duplicate checks and writes are serialized.

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

`openai` and legacy `codex` groups use the same structure. Only routing and API-account fields are read. Configuration cannot expose a listener or management route.

## IPC v1

Read URL, token, and PID from `<home>/broker.json`. Supply `Authorization: Bearer <token>` or `x-api-key: <token>`. Account keys are base64url encodings of IDs.

| Method and path under `/credne/v1` | Result |
| --- | --- |
| `GET /health` | Backend, versions, PID, start time, account count |
| `POST /shutdown` | Stop shared daemon |
| `GET /accounts` | Credential-free account descriptions |
| `GET /accounts/{key}/models` | Account model descriptions |
| `GET /accounts/{key}/usage` | Normalized live subscription windows and credits |
| `POST /accounts/{key}/disable`, `/enable` | Change account state |
| `POST /accounts/{key}/reset` | Clear cooldown |
| `DELETE /accounts/{key}` | Remove account and credential |
| `POST /api-keys` `{provider,name,key}` | Validate/add key; provider is `claude`, `anthropic`, or `openai` |
| `POST /logins` `{provider}` | Start `codex` or `claude` login. If OMP returns `riskWarning` instead of a browser URL, display it and wait for the user's decision. |
| `POST /logins/{state}/acknowledge` `{"answer":"yes"}` | Continue only after the user accepts the displayed warning. If they decline, cancel with `DELETE /logins/{state}`. |
| `GET /logins/{state}` | `wait`, `ok`, or `error`; optional account/error |
| `POST /logins/{state}/callback` `{redirectUrl}` | Submit complete browser redirect |
| `DELETE /logins/{state}` | Cancel login |
| `POST /route/{target}/v1/messages` | Anthropic Messages |
| `POST /route/{target}/responses` | OpenAI Responses |
| `POST /route/{target}/chat/completions` | Chat Completions |
| `POST /route/{target}/decisions` | OpenAI Decisions, for a pinned OpenAI API key or `p.openai` only |

Decisions requests use the selected account’s OpenAI API key from OMP. The broker forwards the request body unchanged to `/v1/decisions` and passes the status, body, content type, request ID, and retry hint back to the client. Subscription accounts cannot serve this endpoint. A failed classification does not put the account on cooldown for chat.

Inference supports streaming and non-streaming. Errors use the request protocol envelope and retain provider status and `Retry-After`, without raw upstream bodies.

Live usage calls only Anthropic OAuth usage or ChatGPT WHAM usage. Redirects are refused, requests time out after ten seconds, and bodies are capped at 256 KiB. Only allowlisted quota windows and credits are returned. Missing values remain missing. API keys return an explicit unsupported reason. Session token cost is not subscription billing.

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

The gate rejects foreign Host and Origin values. Only broker routes and validated pending OAuth callbacks are exposed. Caller authorization, keys, and cookies are stripped before dispatch. The selected account supplies its credential. Provider errors and logs do not expose credential bodies through IPC.

The trust boundary is the OS user. Shell tools and other applications under that user can read private storage. Stronger isolation requires separate OS users or sandboxing.

## Tests and upgrades

`bun test test` uses isolated homes and local fake upstreams with the real pi-ai gateway/provider stack. Tests cover pinning, pools, reasoning, hosted search, gate security, duplicate adds, OAuth callbacks, usage, and separate-process singleton/crash recovery.

Node-side account tests remain in `packages/coding-agent/test`. Set `PI_ACCOUNTS_BROKER` to the compiled executable for broker end-to-end tests.

After upgrading pi-ai, run broker checks/tests, compile, then run Node adapter end-to-end tests. Inspect hosted-tool codecs and auth retry behavior before changing the version.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled software notices.
