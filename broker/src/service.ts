import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { Accounts, atomicJson, boundedText, HttpError, publicAccount, publicModels } from "./accounts.ts";
import { decisionsError } from "./decisions.ts";
import { Gateway, protocolError } from "./gateway.ts";
import { Logins } from "./logins.ts";
import { publicProviders } from "./providers.ts";
import { fetchAccountUsage } from "./usage.ts";
import { object, text } from "./wire.ts";

export interface BrokerOptions {
	home: string;
	idleTimeout?: number;
	maxConcurrency?: number;
	anthropicBaseUrl?: string;
	openaiBaseUrl?: string;
	version?: string;
}
export interface BrokerState {
	schema: number;
	pid: number;
	url: string;
	token: string;
	brokerVersion: string;
	upstreamVersion: string;
	backend: "oh-my-pi";
	startedAt: string;
}
export interface BrokerHandle {
	state: BrokerState;
	closed: Promise<void>;
	close(): Promise<void>;
}
function equal(left: string, right: string): boolean {
	const a = Buffer.from(left),
		b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}
async function managementBody(request: Request): Promise<Record<string, unknown>> {
	try {
		return object(await request.json());
	} catch {
		throw new HttpError(400, "Invalid JSON body.");
	}
}
function processAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
async function liveOwner(home: string): Promise<boolean> {
	try {
		return processAlive(object(JSON.parse(await readFile(join(home, "broker.owner.json"), "utf8"))).pid);
	} catch {
		return false;
	}
}
async function runningDiscovery(home: string): Promise<boolean> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(join(home, "broker.json"), "utf8"));
	} catch {
		return false;
	}
	const record = object(value),
		url = text(record.url),
		token = text(record.token);
	if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || !token) return false;
	try {
		const response = await fetch(`${url}/credne/v1/health`, {
			headers: { authorization: `Bearer ${token}` },
			redirect: "error",
			signal: AbortSignal.timeout(1000),
		});
		if (!response.ok) {
			await response.body?.cancel();
			if (processAlive(record.pid))
				throw new HttpError(
					409,
					"A broker process is still running but not healthy. Retry or stop it before starting another daemon.",
				);
			return false;
		}
		const health = object(JSON.parse(await boundedText(response, 16384)));
		if (health.backend !== "oh-my-pi")
			throw new HttpError(
				409,
				"A legacy broker is running. Stop the previous broker PID before starting the new broker.",
			);
		return true;
	} catch (error) {
		if (error instanceof HttpError) throw error;
		if (processAlive(record.pid))
			throw new HttpError(
				409,
				"A broker process is still running but not responding. Retry or stop it before starting another daemon.",
			);
		return false;
	}
}
export async function startBroker(options: BrokerOptions): Promise<BrokerHandle | undefined> {
	const home = resolve(options.home);
	await mkdir(home, { recursive: true, mode: 0o700 });
	await chmod(home, 0o700);
	if (await runningDiscovery(home)) return undefined;
	if (await liveOwner(home)) return undefined;
	let unlock: () => Promise<void>;
	try {
		unlock = await lock(home, {
			lockfilePath: join(home, "broker.lock.d"),
			realpath: true,
			stale: 5000,
			update: 1000,
			retries: { retries: 6, minTimeout: 1000, maxTimeout: 1000, randomize: false },
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined;
		throw error;
	}
	if (await liveOwner(home)) {
		await unlock();
		return undefined;
	}
	await chmod(join(home, "broker.lock.d"), 0o700);
	let accounts: Accounts | undefined, gateway: Gateway | undefined, logins: Logins | undefined;
	let server: Bun.Server<undefined> | undefined;
	let timer: Timer | undefined;
	let stopping: Promise<void> | undefined;
	const finished = Promise.withResolvers<void>();
	const state: BrokerState = {
		schema: 1,
		pid: process.pid,
		url: "",
		token: `cbk_${randomBytes(32).toString("hex")}`,
		brokerVersion: options.version ?? process.env.CREDNE_BROKER_VERSION ?? "0.1.3",
		upstreamVersion: "19.0.0",
		backend: "oh-my-pi",
		startedAt: new Date().toISOString(),
	};
	await atomicJson(join(home, "broker.owner.json"), { pid: state.pid, token: state.token });
	let inFlight = 0,
		lastActivity = Date.now();
	const abort = new AbortController();
	const close = (): Promise<void> => {
		stopping ??= (async () => {
			clearInterval(timer);
			abort.abort();
			await logins?.close();
			gateway?.close();
			await server?.stop(true);
			accounts?.close();
			try {
				const current = object(JSON.parse(await readFile(join(home, "broker.json"), "utf8")));
				if (current.token === state.token) await rm(join(home, "broker.json"), { force: true });
			} catch {
				/* No successor discovery is removed. */
			}
			try {
				const current = object(JSON.parse(await readFile(join(home, "broker.owner.json"), "utf8")));
				if (current.token === state.token) await rm(join(home, "broker.owner.json"), { force: true });
			} catch {
				/* Another owner's record is retained. */
			}
			await unlock();
			finished.resolve();
		})();
		return stopping;
	};
	try {
		// The lock was contended: a live legacy owner must still not be bypassed.
		if (await runningDiscovery(home)) {
			await close();
			return undefined;
		}
		accounts = new Accounts({
			home,
			anthropicBaseUrl: options.anthropicBaseUrl ?? "https://api.anthropic.com",
			openaiBaseUrl: options.openaiBaseUrl ?? "https://api.openai.com",
		});
		await accounts.load();
		gateway = new Gateway(accounts, options.maxConcurrency ?? 0);
		logins = new Logins(accounts);
		const store = accounts,
			routes = gateway,
			loginApi = logins;
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			maxRequestBodySize: 16 * 1024 * 1024,
			async fetch(incoming): Promise<Response> {
				const url = new URL(incoming.url),
					host = incoming.headers.get("host")?.toLowerCase();
				const port = new URL(state.url).port;
				if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
					return Response.json({ error: "forbidden host" }, { status: 403 });
				const origin = incoming.headers.get("origin");
				if (origin && origin !== state.url && origin !== `http://localhost:${port}`)
					return Response.json({ error: "forbidden origin" }, { status: 403 });
				if (
					incoming.method === "GET" &&
					["/callback", "/codex/callback", "/anthropic/callback"].includes(url.pathname)
				) {
					const stateParam = url.searchParams.get("state");
					for (const login of loginApi.pending.values()) {
						if (login.flow !== "browser" || !login.url || login.status !== "wait") continue;
						const authorize = new URL(login.url);
						if (!stateParam || authorize.searchParams.get("state") !== stateParam) continue;
						const redirect = authorize.searchParams.get("redirect_uri");
						if (!redirect) continue;
						const callback = new URL(redirect);
						callback.search = url.search;
						try {
							login.callback(callback.href);
							return new Response("Sign-in received. Return to Credne.");
						} catch {
							break;
						}
					}
					return Response.json({ error: "invalid login callback" }, { status: 400 });
				}
				const authorization = incoming.headers.get("authorization") ?? "";
				const token =
					/^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() ?? incoming.headers.get("x-api-key") ?? "";
				if (!equal(token, state.token))
					return Response.json({ error: "missing or invalid broker token" }, { status: 401 });
				if (!url.pathname.startsWith("/credne/v1/")) return Response.json({ error: "not found" }, { status: 404 });
				lastActivity = Date.now();
				inFlight++;
				let bodyOwnsActivity = false;
				const done = () => {
					inFlight--;
					lastActivity = Date.now();
				};
				try {
					const request = new Request(incoming, { signal: AbortSignal.any([incoming.signal, abort.signal]) });
					const path = url.pathname.slice("/credne/v1".length);
					let response: Response;
					if (request.method === "GET" && path === "/health")
						response = Response.json({ ok: true, ...state, token: undefined, accounts: store.accounts.size });
					else if (request.method === "POST" && path === "/shutdown") {
						setTimeout(() => void close(), 10);
						response = Response.json({ ok: true });
					} else if (request.method === "GET" && path === "/providers")
						response = Response.json({ providers: publicProviders() });
					else if (request.method === "GET" && path === "/accounts")
						response = Response.json({
							accounts: [...store.accounts.values()]
								.map(publicAccount)
								.sort((a, b) => String(a.id).localeCompare(String(b.id))),
						});
					else if (request.method === "POST" && path === "/api-keys")
						response = Response.json({
							account: publicAccount(await store.addKey(await managementBody(request), request.signal)),
						});
					else if (request.method === "POST" && path === "/logins")
						response = Response.json(await loginApi.start(await managementBody(request), request.signal));
					else {
						const accountMatch = /^\/accounts\/([A-Za-z0-9_-]+)(?:\/(models|usage|disable|enable|reset))?$/.exec(
							path,
						);
						const loginMatch = /^\/logins\/([A-Za-z0-9_-]+)(?:\/(callback|acknowledge))?$/.exec(path);
						const routeMatch =
							/^\/route\/([^/]+)(\/v1\/messages|\/responses|\/chat\/completions|\/decisions)$/.exec(path);
						if (accountMatch) {
							const account = store.get(accountMatch[1]);
							const action = accountMatch[2];
							if (request.method === "GET" && action === "models")
								response = Response.json({ models: publicModels(account) });
							else if (request.method === "GET" && action === "usage")
								response = Response.json(
									await fetchAccountUsage(
										{ kind: account.record.kind, provider: account.record.provider ?? "" },
										() => store.credential(account, request.signal),
										request.signal,
									),
								);
							else if (request.method === "POST" && action && ["disable", "enable", "reset"].includes(action)) {
								await store.mutate(account, action);
								response = Response.json({ account: publicAccount(account) });
							} else if (request.method === "DELETE" && !action) {
								await store.mutate(account, "delete");
								response = Response.json({ ok: true });
							} else throw new HttpError(404, "not found");
						} else if (loginMatch) {
							if (request.method === "GET" && !loginMatch[2])
								response = Response.json(loginApi.status(loginMatch[1]));
							else if (request.method === "DELETE" && !loginMatch[2]) {
								await loginApi.cancel(loginMatch[1]);
								response = Response.json({ ok: true });
							} else if (request.method === "POST" && loginMatch[2] === "callback") {
								const redirectUrl = text((await managementBody(request)).redirectUrl);
								if (!redirectUrl) throw new HttpError(400, "redirectUrl is required");
								loginApi.get(loginMatch[1]).callback(redirectUrl);
								response = Response.json({ ok: true });
							} else if (request.method === "POST" && loginMatch[2] === "acknowledge") {
								const { answer } = await managementBody(request);
								response = Response.json(await loginApi.acknowledge(loginMatch[1], answer, request.signal));
							} else throw new HttpError(404, "not found");
						} else if (routeMatch && request.method === "POST")
							response = await routes.execute(request, routeMatch[1], routeMatch[2]);
						else throw new HttpError(404, "not found");
					}
					const headers = new Headers(response.headers);
					headers.set("cache-control", "no-store");
					if (!response.body) return new Response(null, { status: response.status, headers });
					const reader = response.body.getReader();
					bodyOwnsActivity = true;
					let settled = false;
					const finish = () => {
						if (!settled) {
							settled = true;
							done();
						}
					};
					return new Response(
						new ReadableStream<Uint8Array>({
							async pull(controller) {
								try {
									const next = await reader.read();
									if (next.done) {
										reader.releaseLock();
										finish();
										controller.close();
									} else controller.enqueue(next.value);
								} catch (error) {
									finish();
									controller.error(error);
								}
							},
							async cancel(reason) {
								try {
									await reader.cancel(reason);
								} finally {
									finish();
								}
							},
						}),
						{ status: response.status, headers },
					);
				} catch (error) {
					const status = error instanceof HttpError ? error.status : incoming.signal.aborted ? 499 : 500;
					const message =
						error instanceof HttpError
							? error.message
							: status === 499
								? "Request cancelled."
								: "Broker request failed.";
					if (url.pathname.includes("/route/")) {
						if (url.pathname.endsWith("/decisions")) return decisionsError(status, message);
						return protocolError(
							status,
							message,
							url.pathname.endsWith("/v1/messages")
								? "anthropic"
								: url.pathname.endsWith("/responses")
									? "responses"
									: "chat",
						);
					}
					return Response.json({ error: message }, { status });
				} finally {
					if (!bodyOwnsActivity) done();
				}
			},
			error: () => Response.json({ error: "Broker request failed." }, { status: 500 }),
		});
		state.url = `http://127.0.0.1:${server.port}`;
		const healthy = await fetch(`${state.url}/credne/v1/health`, {
			headers: { authorization: `Bearer ${state.token}` },
			redirect: "error",
		});
		await healthy.body?.cancel();
		if (!healthy.ok) throw new Error("Broker health check failed.");
		await atomicJson(join(home, "broker.json"), state);
		const idle = options.idleTimeout ?? 30 * 60 * 1000;
		if (idle > 0)
			timer = setInterval(
				() => {
					if (
						inFlight === 0 &&
						![...loginApi.pending.values()].some((login) => login.status === "wait") &&
						Date.now() - lastActivity >= idle
					)
						void close();
				},
				Math.max(10, Math.min(60000, idle / 4)),
			);
		return { state, close, closed: finished.promise };
	} catch (error) {
		await close();
		throw error;
	}
}
