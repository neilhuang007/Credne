# Unreleased

- Replace the Go account broker with a Bun-compiled service built on `@oh-my-pi/pi-ai`. The Credne CLI stays on Node.js.
- Source builds require Node.js 22.19 or newer and Bun 1.4.4 or newer. Installed packages include the broker runtime; users do not need Bun or Go.
- Build packages on the target platform and architecture with `npm ci --ignore-scripts`, `npm run build`, and `node credne/scripts/build.mjs`.
- Keep the packaged `bin/pi_natives.*.node` files beside `credne-broker`. The broker uses these native assets for locking and credential storage. SQLite and the provider catalog are included in the compiled runtime.

The 0.1.3 installation instructions below refer to the existing release archive, which still contains the original Go broker.

# Credne 0.1.3

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
