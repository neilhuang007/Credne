import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AuthStorage, isSameOAuthAccount, resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai";
import { type Account, type Accounts, HttpError, publicAccount } from "./accounts.ts";
import { text, type WireObject } from "./wire.ts";

type StartResult = { kind: "ready" } | { kind: "warning"; warning: string } | { kind: "failed" };

interface Login {
	state: string;
	url: string;
	status: "wait" | "ok" | "error";
	error?: string;
	account?: Account;
	acceptRisk?: (answer: string) => void;
	authorization: Promise<StartResult>;
	cancel: () => void;
	callback: (value: string) => void;
	done?: Promise<void>;
}

export class Logins {
	readonly pending = new Map<string, Login>();
	constructor(private readonly accounts: Accounts) {}

	async start(input: WireObject, signal: AbortSignal): Promise<WireObject> {
		const provider = text(input.provider)?.trim().toLowerCase();
		if (provider === "claude-api-credits")
			throw new HttpError(400, "Claude Console sign-in is not supported. Add a Claude API key instead.");
		if (provider !== "codex" && provider !== "claude") throw new HttpError(400, "provider must be claude or codex");
		const nativeProvider = provider === "codex" ? "openai-codex" : "anthropic";
		const state = randomBytes(24).toString("hex");
		const abort = new AbortController();
		const path = join(this.accounts.options.home, "credentials", `login-${state}.db`);
		const storage = await AuthStorage.create(path, { usageProviderResolver: () => undefined });
		const initial = Promise.withResolvers<StartResult>(),
			authorization = Promise.withResolvers<StartResult>(),
			manual = Promise.withResolvers<string>();
		void manual.promise.catch(() => {});
		const deadline = setTimeout(() => abort.abort(), 15 * 60 * 1000);
		abort.signal.addEventListener(
			"abort",
			() => {
				manual.reject(new Error("cancelled"));
				initial.resolve({ kind: "failed" });
				authorization.resolve({ kind: "failed" });
			},
			{ once: true },
		);
		const login: Login = {
			state,
			url: "",
			status: "wait",
			authorization: authorization.promise,
			cancel: () => abort.abort(),
			callback: (value) => {
				if (login.status !== "wait" || abort.signal.aborted || !login.url)
					throw new HttpError(409, "Login callback is not pending.");
				validateCallback(value, login.url);
				manual.resolve(value);
			},
		};
		this.pending.set(state, login);
		login.done = storage.oauth
			.login(nativeProvider, {
				signal: abort.signal,
				onAuth: (info) => {
					login.url = info.url;
					initial.resolve({ kind: "ready" });
					authorization.resolve({ kind: "ready" });
				},
				onPrompt: (prompt) => {
					if (!prompt.riskAcknowledgement) return manual.promise;
					abort.signal.throwIfAborted();
					const consent = Promise.withResolvers<string>();
					login.acceptRisk = consent.resolve;
					initial.resolve({ kind: "warning", warning: prompt.message });
					abort.signal.addEventListener("abort", () => consent.resolve("no"), { once: true });
					return consent.promise;
				},
				onManualCodeInput: () => manual.promise,
			})
			.then(async (identity) => {
				abort.signal.throwIfAborted();
				const credential = storage.credentials.get(nativeProvider);
				if (!identity || !credential || credential.type !== "oauth") throw new Error("No subscription credential.");
				await this.accounts.locked(async () => {
					abort.signal.throwIfAborted();
					const existing = [...this.accounts.accounts.values()].find((account) => {
						const prior = account.storage.credentials.get(account.provider);
						return (
							account.record.provider === provider &&
							prior?.type === "oauth" &&
							isSameOAuthAccount(prior, credential)
						);
					});
					if (existing) {
						await existing.storage.credentials.set(nativeProvider, credential);
						throw new HttpError(
							409,
							`${existing.record.email ?? existing.record.id} is already added as a ${provider === "codex" ? "ChatGPT" : "Claude"} subscription. Its sign-in was renewed; no account was added.`,
						);
					}
					const identityId =
						provider === "claude"
							? resolveCredentialIdentityKey(nativeProvider, credential)
							: (credential.accountId ?? credential.email);
					if (!identityId) throw new Error("No subscription identity.");
					login.account = await this.accounts.register(
						{
							id: `${provider}-${Buffer.from(identityId).toString("base64url")}.json`,
							provider,
							name: credential.email ?? credential.accountId ?? identityId,
							kind: "oauth",
							email: credential.email,
							plan: credential.orgName,
							createdAt: new Date().toISOString(),
						},
						credential,
					);
					await this.accounts.save();
					login.status = "ok";
				});
			})
			.catch((error) => {
				login.status = "error";
				login.error =
					error instanceof HttpError
						? error.message
						: abort.signal.aborted
							? "Sign-in cancelled or expired."
							: "Subscription sign-in failed. Try again.";
				initial.resolve({ kind: "failed" });
				authorization.resolve({ kind: "failed" });
			})
			.finally(async () => {
				clearTimeout(deadline);
				login.acceptRisk = undefined;
				storage.close();
				for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
			});
		try {
			return startResponse(login, await waitForLogin(login, initial.promise, signal));
		} catch (error) {
			await this.cancel(state);
			throw error;
		}
	}

	async acknowledge(state: string, answer: unknown, signal: AbortSignal): Promise<WireObject> {
		const login = this.get(state);
		if (login.status !== "wait" || !login.acceptRisk) throw new HttpError(409, "No login warning is pending.");
		if (answer !== "yes") throw new HttpError(400, 'Answer "yes" only after accepting the displayed risk.');
		const accept = login.acceptRisk;
		login.acceptRisk = undefined;
		accept(answer);
		return startResponse(login, await waitForLogin(login, login.authorization, signal));
	}

	get(state: string): Login {
		const login = this.pending.get(state);
		if (!login) throw new HttpError(404, "login not found");
		return login;
	}

	status(state: string): WireObject {
		const login = this.get(state);
		return {
			status: login.status,
			error: login.error,
			account: login.account ? publicAccount(login.account) : undefined,
		};
	}

	async cancel(state: string): Promise<void> {
		const login = this.get(state);
		login.cancel();
		await login.done;
		this.pending.delete(state);
	}

	async close(): Promise<void> {
		for (const login of this.pending.values()) login.cancel();
		await Promise.all([...this.pending.values()].map((login) => login.done));
	}
}

async function waitForLogin(login: Login, next: Promise<StartResult>, signal: AbortSignal): Promise<StartResult> {
	if (signal.aborted) login.cancel();
	signal.addEventListener("abort", login.cancel, { once: true });
	try {
		return await next;
	} finally {
		signal.removeEventListener("abort", login.cancel);
	}
}

function startResponse(login: Login, result: StartResult): WireObject {
	if (result.kind === "failed") throw new HttpError(502, "Subscription sign-in could not start.");
	return {
		state: login.state,
		url: login.url,
		flow: "browser",
		riskWarning: result.kind === "warning" ? result.warning : undefined,
	};
}

function validateCallback(value: string, authorizationUrl: string): void {
	let callback: URL;
	try {
		callback = new URL(value);
	} catch {
		throw new HttpError(400, "Expected the complete redirect URL from the browser.");
	}
	const authorize = new URL(authorizationUrl);
	const redirect = authorize.searchParams.get("redirect_uri");
	if (!redirect) throw new HttpError(400, "This login does not accept a redirect URL.");
	const expected = new URL(redirect);
	if (
		callback.origin !== expected.origin ||
		callback.pathname !== expected.pathname ||
		callback.searchParams.get("state") !== authorize.searchParams.get("state") ||
		!callback.searchParams.get("code")
	)
		throw new HttpError(400, "Login callback does not match this sign-in.");
}
