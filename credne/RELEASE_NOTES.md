# Credne 0.1.5 — Windows x64

0.1.5 is the first published release with the oh-my-pi (OMP) account broker. It includes everything prepared for 0.1.4, which was never published.

- The Credne CLI stays on Node.js. A Bun-compiled service built on `@oh-my-pi/pi-ai` replaces the Go/CLIProxyAPI account broker. It can import legacy broker-managed API keys and supported subscription sign-ins without overwriting the old records.
- OMP now builds and sends every broker request. Credne passes its conversation to the broker in OMP's own format, and OMP applies the Claude Code request profile, sign-in, token refresh and prompt caching. The broker only chooses the account and watches the answer for failover. This fixes Claude subscription requests that failed with "provider returned HTTP 502", which also made pools fall back to billed API keys.
- Use `/accounts add` for Claude and ChatGPT subscriptions and Anthropic and OpenAI API keys. **Other providers** lists only the OMP methods Credne can enroll and route, including Google API keys and xAI device sign-in. Cloud credential chains, native CLI adapters, and some sign-ins are not supported. Key validation may incur a small charge.
- `/model` lists models separately from accounts and accepts aliases such as `/model sonnet`. Pooled chat tries eligible subscriptions before ordinary API keys, even if a key served the last turn, and subagents of a pooled session go back through the pool. The pool can fall back to a billed API key. Use `/accounts switch` to pin an account if you want an error instead of fallback.
- A pinned account keeps every model it serves: `/model`, autocomplete, Ctrl+P and startup choose that account's copy of a model. Choosing a model the account does not serve leaves the pin.
- Added Jev (TypeSafe) accounts with `/accounts add jev`. Subagent tier decisions use Jev first, then `gpt-6-luna` from an OpenAI API key. Credne warns once at startup when no Jev account exists.
- The bundled `worker` runs `claude-opus-5-5` at `xhigh` reasoning. The tier classifier records every task it does not rate with a reason, and a blank `model`, `tier` or `reasoningEffort` from the model counts as not passed.
- Removed hosted web search for broker accounts.

## Upgrade from a 0.1.4 build

If you built and installed 0.1.4 from source, choose `/accounts` → **Restart broker** after installing 0.1.5. The running 0.1.4 broker does not have the route the 0.1.5 CLI sends requests to.

## Upgrade from the Go broker

Finish active requests and sign-ins, then close all but one old Credne session. In that session choose `/accounts` → **Restart broker** to stop the shared broker. Close the last old session without sending another request. If Credne still reports a previous broker PID, verify that it belongs to the old `credne-broker` before stopping that process. Do not remove accounts or delete the accounts directory; it contains saved credentials and settings.

Local `claude-sub:` accounts need a fresh sign-in with `/accounts add claude-subscription`. Use `/accounts switch` if you want to pin the new account. The old credential file stays intact. For Claude Console billing, add an Anthropic API key; Console browser sign-in through `ant` is no longer supported.

## Install on Windows x64

Install Node.js 22.19 or newer. Install the Credne archive from PowerShell or Command Prompt:

```shell
curl.exe -fL https://github.com/neilhuang007/Credne/releases/download/0.1.5/credne-0.1.5-windows-x64.tgz -o credne-0.1.5-windows-x64.tgz
npm.cmd install --global --ignore-scripts .\credne-0.1.5-windows-x64.tgz
credne.cmd --version
credne.cmd
```

`credne.cmd --version` should print `0.1.5`. The archive includes the compiled broker, SQLite, and the provider catalog; you do not need Bun or Go to run it. Keep the packaged `bin/pi_natives.*.node` files beside `credne-broker` for locking and credential storage. For other platforms, follow the [tagged source instructions](https://github.com/neilhuang007/Credne/blob/0.1.5/README.md#build-credne-from-the-015-tag), which require Node.js 22.19 or newer and Bun 1.4.4 or newer.

# Credne 0.1.3 (historical)

This release archive still contains the original Go broker.

- After a provider error such as “no credits remaining,” switch to a funded account or top up the current one, then run `/continue`. Credne retries the pending turn with its original prompt and attachments.
- Switching models or accounts keeps your chosen reasoning effort unless you configured an explicit level for the destination. A model with fewer supported levels uses a compatible level without overwriting your preference.

## Install on Windows x64

Install Node.js 22.19 or newer, then run these commands from any directory. The package includes the account broker and runtime dependencies.

```shell
curl.exe -fL https://github.com/neilhuang007/Credne/releases/download/0.1.3/credne-0.1.3-windows-x64.tgz -o credne-0.1.3-windows-x64.tgz
npm.cmd install --global --ignore-scripts .\credne-0.1.3-windows-x64.tgz
credne.cmd --version
credne.cmd
```

`credne.cmd --version` should print `0.1.3`. Install [Git for Windows](https://git-scm.com/download/win) if you need Bash for shell commands. Existing accounts and settings are kept. For a first install, use `/accounts add` inside Credne.

On macOS or Linux, follow the [source installation instructions for 0.1.3](https://github.com/neilhuang007/Credne/blob/0.1.3/README.md#credne) to build the broker for your platform.
