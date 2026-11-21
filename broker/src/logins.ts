import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AuthStorage, isSameOAuthAccount, setUnpausedProviders } from "@oh-my-pi/pi-ai";
import {
	type Account,
	type AccountRecord,
	type Accounts,
	HttpError,
	normalizeName,
	publicAccount,
} from "./accounts.ts";
import { text, type WireObject } from "./wire.ts";

interface Login {
	state: string;
	provider: string;
	name?: string;
	url: string;
	status: "wait" | "ok" | "error";
	error?: string;
	account?: Account;
	cancel: () => void;
	callback: (value: string) => Promise<void>;
	done?: Promise<void>;
}
export class Logins {
	readonly pending = new Map<string, Login>();
	constructor(private readonly accounts: Accounts) {}
	async start(input: WireObject, signal: AbortSignal): Promise<WireObject> {
		const provider = text(input.provider)?.trim().toLowerCase();
		if (!provider || !["codex", "claude", "claude-api-credits"].includes(provider))
			throw new HttpError(400, "provider must be claude, codex or claude-api-credits");
		const state = randomBytes(24).toString("hex");
		const abort = new AbortController();
		const login: Login = {
			state,
			provider,
			url: "",
			status: "wait",
			cancel: () => abort.abort(),
			callback: async () => {
				throw new HttpError(409, "Login callback is not ready.");
			},
		};
		if (provider === "claude-api-credits") {
			const name = normalizeName(input.name);
			login.name = name;
			this.accounts.duplicate({ id: `claude-api-credits-${name}`, name, kind: "api-credits", createdAt: "" });
			if ([...this.pending.values()].some((other) => other.name === name && other.status === "wait"))
				throw new HttpError(
					409,
					`An API credits sign-in named ${name} is already in progress. Finish or cancel it first.`,
				);
			this.pending.set(state, login);
			try {
				const profile = `credne-${name}`;
				const ant = await this.accounts.ant.startLogin(profile, signal);
				login.url = ant.url;
				login.cancel = ant.cancel;
				login.callback = async (value) => {
					try {
						await ant.callback(value);
					} catch {
						throw new HttpError(400, "Callback does not match this pending Console sign-in.");
					}
				};
				login.done = ant.done
					.then(async () => {
						const credentials = await this.accounts.ant.credentials(profile);
						const record: AccountRecord = {
							id: `claude-api-credits-${name}`,
							provider: "claude-api",
							kind: "api-credits",
							name,
							profile,
							email: credentials.account_email,
							organization: credentials.organization_name,
							organizationUuid: credentials.organization_uuid,
							createdAt: new Date().toISOString(),
						};
						try {
							this.accounts.duplicate(record);
							record.models = await this.accounts.listModels(record, credentials.access_token);
							await this.accounts.locked(async () => {
								this.accounts.duplicate(record);
								login.account = await this.accounts.register(record);
								await this.accounts.save();
								login.status = "ok";
							});
						} catch (error) {
							await this.accounts.ant.logout(profile).catch(() => {});
							throw error;
						}
					})
					.catch((error) => {
						login.status = "error";
						login.error =
							error instanceof HttpError ? error.message : "Claude Console sign-in failed. Try again.";
					});
			} catch {
				this.pending.delete(state);
				throw new HttpError(502, "Claude Console sign-in could not start. Check ant or CREDNE_ANT.");
			}
		} else {
			const nativeProvider = provider === "codex" ? "openai-codex" : "anthropic";
			// An explicit legacy broker login remains callable, but local Claude subscriptions are not imported.
			if (provider === "claude") setUnpausedProviders(["anthropic"]);
			const path = join(this.accounts.options.home, "credentials", `login-${state}.db`);
			const storage = await AuthStorage.create(path, { usageProviderResolver: () => undefined });
			const ready = Promise.withResolvers<string>(),
				manual = Promise.withResolvers<string>();
			void manual.promise.catch(() => {});
			const deadline = setTimeout(() => abort.abort(), 15 * 60 * 1000);
			abort.signal.addEventListener(
				"abort",
				() => {
					manual.reject(new Error("cancelled"));
					ready.reject(new Error("cancelled"));
				},
				{ once: true },
			);
			login.callback = async (value) => {
				if (login.status !== "wait" || abort.signal.aborted)
					throw new HttpError(409, "Login is no longer pending.");
				let callback: URL, authorize: URL;
				try {
					callback = new URL(value);
					authorize = new URL(login.url);
				} catch {
					throw new HttpError(400, "Expected the complete redirect URL from the browser.");
				}
				const redirect = authorize.searchParams.get("redirect_uri");
				const expectedState = authorize.searchParams.get("state");
				if (!redirect) throw new HttpError(400, "This login does not accept a redirect URL.");
				const expected = new URL(redirect);
				if (
					callback.origin !== expected.origin ||
					callback.pathname !== expected.pathname ||
					(expectedState && callback.searchParams.get("state") !== expectedState) ||
					!callback.searchParams.get("code")
				)
					throw new HttpError(400, "Login callback does not match this sign-in.");
				manual.resolve(value);
			};
			this.pending.set(state, login);
			login.done = storage.oauth
				.login(nativeProvider, {
					signal: abort.signal,
					onAuth: (info) => {
						login.url = info.url;
						ready.resolve(info.url);
					},
					onPrompt: (prompt) => (prompt.riskAcknowledgement ? Promise.resolve("yes") : manual.promise),
					onManualCodeInput: () => manual.promise,
				})
				.then(async (identity) => {
					const credential = storage.credentials.get(nativeProvider);
					if (!identity || !credential || credential.type !== "oauth")
						throw new Error("No subscription credential.");
					await this.accounts.locked(async () => {
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
						const identityId = credential.accountId ?? credential.email;
						if (!identityId) throw new Error("No subscription identity.");
						const record: AccountRecord = {
							id: `${provider}-${Buffer.from(identityId).toString("base64url")}.json`,
							provider,
							name: credential.email ?? identityId,
							kind: "oauth",
							email: credential.email,
							plan: credential.orgName,
							createdAt: new Date().toISOString(),
						};
						login.account = await this.accounts.register(record, credential);
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
					ready.reject(new Error("Sign-in failed."));
				})
				.finally(async () => {
					clearTimeout(deadline);
					storage.close();
					for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
				});
			const disconnected = Promise.withResolvers<never>();
			const onDisconnect = () => {
				abort.abort();
				disconnected.reject(new Error("cancelled"));
			};
			signal.addEventListener("abort", onDisconnect, { once: true });
			try {
				signal.throwIfAborted();
				await Promise.race([ready.promise, disconnected.promise]);
			} catch {
				abort.abort();
				throw new HttpError(502, "Subscription sign-in could not start.");
			} finally {
				signal.removeEventListener("abort", onDisconnect);
			}
		}
		return { state, url: login.url, flow: "browser" };
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
