import { AsyncLocalStorage } from "node:async_hooks";
import { type Api, type FetchImpl, type Model, resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai";
import { type AuthGatewayRouter, createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway/server";
import { wrapFetchForCch } from "@oh-my-pi/pi-ai/providers/anthropic";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import { type Account, type Accounts, accountKey, boundedText, HttpError } from "./accounts.ts";
import { Decisions } from "./decisions.ts";
import { hasReasoningError, rewriteReasoning } from "./reasoning.ts";
import { array, object, text, type WireObject } from "./wire.ts";

// Provider diagnostics may contain upstream error bodies. The public broker logs only its lifecycle.
setTransports({ file: false, console: false });
type Protocol = "anthropic" | "responses" | "chat";
type StreamRead = { done: false; value: Uint8Array } | { done: true; value?: Uint8Array };
interface Attempt {
	account: Account;
	body: WireObject;
	protocol: Protocol;
	signal: AbortSignal;
	status?: number;
	retryAfter?: string;
	reasoningRejected?: boolean;
	native?: Promise<WireObject>;
	hosted: boolean;
	ready: PromiseWithResolvers<void>;
	headersReady: boolean;
	controller: AbortController;
}
const context = new AsyncLocalStorage<Attempt>();
export function protocolError(
	status: number,
	message: string,
	protocol: Protocol,
	key?: string,
	retryAfter?: string,
): Response {
	const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
	if (key) headers["x-credne-account"] = key;
	if (retryAfter) headers["retry-after"] = retryAfter;
	const error = {
		type: status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : "api_error",
		message,
	};
	return Response.json(protocol === "anthropic" ? { type: "error", error } : { error }, { status, headers });
}
function hostedTools(body: WireObject): boolean {
	return array(body.tools).some((tool) =>
		["web_search", "web_search_preview", "web_search_20250305", "web_search_20260209"].includes(
			String(object(tool).type),
		),
	);
}
async function nativeResult(response: Response, protocol: Protocol): Promise<WireObject> {
	const raw = await boundedText(response, 16 * 1024 * 1024);
	if (!response.headers.get("content-type")?.includes("text/event-stream")) return object(JSON.parse(raw));
	let result: WireObject = {};
	const blocks = new Map<number, WireObject>();
	const output = new Map<number, WireObject>();
	for (const frame of raw.split(/\r?\n\r?\n/)) {
		const data = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") continue;
		let event: WireObject;
		try {
			event = object(JSON.parse(data));
		} catch {
			continue;
		}
		if (protocol === "anthropic") {
			if (event.type === "message_start") result = { ...object(event.message) };
			const index = typeof event.index === "number" ? event.index : -1;
			if (event.type === "content_block_start") blocks.set(index, { ...object(event.content_block) });
			if (event.type === "content_block_delta") {
				const block = blocks.get(index),
					delta = object(event.delta);
				if (block && typeof delta.text === "string") block.text = `${text(block.text) ?? ""}${delta.text}`;
				if (block && typeof delta.thinking === "string")
					block.thinking = `${text(block.thinking) ?? ""}${delta.thinking}`;
				if (block && typeof delta.signature === "string")
					block.signature = `${text(block.signature) ?? ""}${delta.signature}`;
				if (block && typeof delta.partial_json === "string")
					block._json = `${text(block._json) ?? ""}${delta.partial_json}`;
			}
			if (event.type === "message_delta") {
				result = { ...result, ...object(event.delta) };
				result.usage = { ...object(result.usage), ...object(event.usage) };
			}
		} else {
			if (event.type === "response.output_item.done" && typeof event.output_index === "number")
				output.set(event.output_index, object(event.item));
			if (["response.completed", "response.done", "response.incomplete"].includes(String(event.type)))
				result = object(event.response);
		}
	}
	if (protocol === "anthropic")
		result.content = [...blocks.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, block]) => {
				const { _json, ...content } = block;
				if (typeof _json === "string") {
					try {
						content.input = JSON.parse(_json);
					} catch {
						/* The provider parser rejects malformed tool input separately. */
					}
				}
				return content;
			});
	else if (!Array.isArray(result.output) || !result.output.length)
		result.output = [...output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
	return result;
}

function* cacheBlocks(body: WireObject): Generator<WireObject> {
	for (const field of ["tools", "system"]) for (const block of array(body[field])) yield object(block);
	for (const message of array(body.messages)) for (const block of array(object(message).content)) yield object(block);
}

function restoreCacheControls(body: WireObject, markers: WireObject[]): void {
	const blocks = [...cacheBlocks(body)];
	let start = 0;
	const selected: WireObject[] = [];
	for (const marker of markers) {
		const index = blocks.findIndex((block, index) => {
			if (index < start || block.type !== marker.type) return false;
			for (const field of ["text", "thinking", "name", "id", "tool_use_id"]) {
				if (typeof marker[field] !== "string") continue;
				return field === "name"
					? text(block.name)?.toLowerCase() === marker[field].toLowerCase()
					: block[field] === marker[field];
			}
			const image = object(marker.source),
				target = object(block.source);
			return image.data !== undefined
				? target.data === image.data
				: image.url !== undefined && target.url === image.url;
		});
		if (index < 0) throw new Error("Cannot preserve the requested cache boundary.");
		selected.push(blocks[index]);
		start = index + 1;
	}
	// Replace automatic markers, rather than adding to them and exceeding Anthropic's four slots.
	delete body.cache_control;
	for (const block of blocks) delete block.cache_control;
	for (let index = 0; index < markers.length; index++) selected[index].cache_control = markers[index].cache_control;
}

async function providerBody(request: Request, attempt: Attempt): Promise<BodyInit> {
	const { account, body: source, protocol } = attempt;
	const anthropic = protocol === "anthropic" && account.provider === "anthropic";
	if (anthropic && account.record.kind === "api-key") {
		// Preserve native Anthropic fields and explicit cache boundaries for API keys.
		return JSON.stringify({ ...source, stream: true });
	}
	const markers = anthropic ? [...cacheBlocks(source)].filter((block) => block.cache_control !== undefined) : [];
	// Keep OMP's exact bytes (including its billing attestation and compression) unless a native field needs restoring.
	if (!attempt.hosted && !markers.length) return request.arrayBuffer();
	const raw = await request.arrayBuffer();
	const bytes = request.headers.get("content-encoding") === "gzip" ? Bun.gunzipSync(new Uint8Array(raw)) : raw;
	const body = object(JSON.parse(new TextDecoder().decode(bytes)));
	if (attempt.hosted) {
		for (const field of ["tools", "tool_choice", "include"])
			if (source[field] !== undefined) body[field] = source[field];
	}
	if (markers.length) restoreCacheControls(body, markers);
	// OMP signed the body before this transport seam; a rewritten body must be signed again.
	if (anthropic) {
		const billing = object(array(body.system)[0]);
		if (text(billing.text)?.startsWith("x-anthropic-billing-header:"))
			billing.text = String(billing.text).replace(/\bcch=[0-9a-f]{5}\b/, "cch=00000");
	}
	return JSON.stringify(body);
}

export class Gateway {
	private readonly decisions: Decisions;
	private readonly routers = new Map<string, { account: Account; router: AuthGatewayRouter }>();
	private readonly sessions = new Map<string, string>();
	private readonly inFlight = new Map<string, number>();
	private readonly queues = new Map<string, Set<() => void>>();
	private cursor = 0;
	constructor(
		private readonly accounts: Accounts,
		private readonly maxConcurrency: number,
	) {
		this.decisions = new Decisions(accounts, (account, signal) => this.acquire(account, signal));
	}
	private router(account: Account): AuthGatewayRouter {
		const cached = this.routers.get(account.record.id);
		if (cached?.account === account) return cached.router;
		cached?.router.close();
		const attest: FetchImpl = wrapFetchForCch((input, init) => fetch(input, init));
		const transport: FetchImpl = async (input, init) => {
			const attempt = context.getStore();
			if (!attempt || attempt.account !== account) throw new Error("Missing account request context.");
			try {
				const request = new Request(input, init);
				const headers = new Headers(request.headers);
				for (const name of ["cookie", "cookie2", "proxy-authorization", "x-api-key", "authorization"])
					headers.delete(name);
				for (const [name, value] of Object.entries(account.record.headers ?? {})) headers.set(name, value);
				// Legacy Claude accounts treated an explicit base as the path before /v1/messages.
				const url =
					account.record.source === "config" &&
					account.record.id.startsWith("claude:apikey:") &&
					account.record.baseUrl
						? `${account.record.baseUrl}/v1/messages?beta=true`
						: request.url;
				let credential = await this.accounts.credential(account, attempt.signal);
				const body = await providerBody(request, attempt);
				if (typeof body === "string") {
					headers.delete("content-encoding");
					headers.delete("content-length");
				}
				const send = account.provider === "anthropic" && account.record.kind === "oauth" ? attest : fetch;
				let response: Response;
				for (let authAttempt = 0; ; authAttempt++) {
					if (account.provider === "anthropic" && account.record.kind === "api-key")
						headers.set("x-api-key", credential.token);
					else headers.set("authorization", `Bearer ${credential.token}`);
					if (account.provider === "openai-codex" && credential.accountId)
						headers.set("chatgpt-account-id", credential.accountId);
					response = await send(url, {
						...init,
						method: request.method,
						headers,
						body,
						signal: request.signal,
						redirect: "error",
					});
					if (response.status !== 401 || authAttempt > 0 || account.record.kind === "api-key") break;
					try {
						const refreshed = await account.storage.oauth.access(account.provider, undefined, {
							signal: attempt.signal,
							forceRefresh: true,
							refreshReason: "auth-recovery",
							rejectedAccessToken: credential.token,
						});
						if (!refreshed) break;
						await response.body?.cancel();
						credential = { token: refreshed.accessToken, accountId: refreshed.accountId };
					} catch {
						// Failed recovery must report the original rejection, not a different account.
						break;
					}
				}
				attempt.status = response.status;
				attempt.retryAfter = response.headers.get("retry-after") ?? undefined;
				if (!response.ok) {
					const detail = await boundedText(response, 256 * 1024);
					attempt.reasoningRejected = hasReasoningError(response.status, detail);
					if (response.status === 400 && /credit balance.*too low|insufficient.*credit/i.test(detail)) {
						attempt.status = 402;
						attempt.retryAfter = "3600";
					}
					const safe = `Provider returned HTTP ${attempt.status}.`;
					attempt.headersReady = true;
					attempt.ready.resolve();
					attempt.controller.abort(); // The broker, not a provider-local retry sleep, owns failover.
					return protocolError(attempt.status, safe, attempt.protocol, undefined, attempt.retryAfter);
				}
				if (attempt.hosted && attempt.body.stream === false) {
					const [provider, native] = response.body!.tee();
					attempt.native = nativeResult(new Response(native, { headers: response.headers }), attempt.protocol);
					attempt.headersReady = true;
					attempt.ready.resolve();
					return new Response(provider, { status: response.status, headers: response.headers });
				}
				attempt.headersReady = true;
				attempt.ready.resolve();
				return response;
			} catch {
				attempt.status = 502;
				attempt.headersReady = true;
				attempt.ready.resolve();
				attempt.controller.abort();
				throw new Error("Provider request failed.");
			}
		};
		const router = createAuthGatewayRouter({
			storage: account.storage,
			fetch: transport,
			resolveModel: (id, options) => {
				const model = account.models.find((model) => model.id === id || `${model.provider}/${model.id}` === id);
				if (!model) return undefined;
				// OpenAI API keys support both wire protocols. Keep Responses native when requested.
				return account.provider === "openai" && options?.api === "openai-completions"
					? { ...model, api: "openai-completions" }
					: model;
			},
		});
		this.routers.set(account.record.id, { account, router });
		return router;
	}
	private async acquire(account: Account, signal: AbortSignal): Promise<() => void> {
		const id = account.record.id;
		while (this.maxConcurrency > 0 && (this.inFlight.get(id) ?? 0) >= this.maxConcurrency) {
			signal.throwIfAborted();
			const waiter = Promise.withResolvers<void>();
			const queue = this.queues.get(id) ?? new Set<() => void>();
			this.queues.set(id, queue);
			const wake = () => waiter.resolve();
			const abort = () => waiter.reject(signal.reason);
			queue.add(wake);
			signal.addEventListener("abort", abort, { once: true });
			try {
				await waiter.promise;
			} finally {
				queue.delete(wake);
				signal.removeEventListener("abort", abort);
			}
		}
		signal.throwIfAborted();
		this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.inFlight.set(id, (this.inFlight.get(id) ?? 1) - 1);
			for (const wake of this.queues.get(id) ?? []) wake();
		};
	}
	private orderPool(candidates: Account[], pool: string, previous?: string): Account[] {
		const enabled = candidates.filter((account) => !account.record.disabled);
		const index = enabled.length && this.accounts.routing.strategy !== "fill-first" ? this.cursor++ : 0;
		const order = (accounts: Account[]): Account[] => {
			if (accounts.length < 2) return accounts;
			const start = index % accounts.length;
			const ordered = start ? [...accounts.slice(start), ...accounts.slice(0, start)] : accounts;
			if (previous && this.accounts.routing.affinity)
				ordered.sort((a, b) => Number(b.record.id === previous) - Number(a.record.id === previous));
			return ordered;
		};
		if (pool !== "claude" && pool !== "all") return order(enabled);

		// Affinity may pick a sibling with a warm cache, but must not keep billing an API key
		// once a Claude subscription can serve the model again. Cooldown and retry still apply.
		const subscriptions: Account[] = [];
		const remaining: Account[] = [];
		for (const account of enabled) {
			const group = account.family === "claude" && account.record.kind === "oauth" ? subscriptions : remaining;
			group.push(account);
		}
		return [...order(subscriptions), ...order(remaining)];
	}
	async execute(request: Request, target: string, path: string): Promise<Response> {
		if (path === "/decisions") return this.decisions.execute(request, target);
		const protocol: Protocol = path === "/v1/messages" ? "anthropic" : path === "/responses" ? "responses" : "chat";
		let body: WireObject;
		try {
			body = object(await request.json());
		} catch {
			throw new HttpError(400, "Invalid JSON body.");
		}
		if (typeof body.model !== "string") throw new HttpError(400, "model is required");
		const pin = target.startsWith("a.");
		if (!pin && !target.startsWith("p.")) throw new HttpError(404, "route target not found");
		const pool = decodeURIComponent(target.slice(2));
		let candidates = pin
			? [this.accounts.get(target.slice(2))]
			: [...this.accounts.accounts.values()].filter((account) => pool === "all" || account.family === pool);
		candidates = candidates.filter((account) => account.models.some((model) => model.id === body.model));
		if (pin && candidates[0]?.record.disabled)
			return protocolError(403, "Pinned account is disabled.", protocol, target.slice(2));
		const session = ["x-session-affinity", "session-id", "x-session-id"]
			.map((name) => request.headers.get(name)?.trim())
			.find(Boolean);
		const sessionKey = session ? `${target}\0${session}` : undefined;
		const previous = sessionKey ? this.sessions.get(sessionKey) : undefined;
		if (!pin) candidates = this.orderPool(candidates, pool, previous);
		if (!candidates.length)
			return protocolError(
				404,
				"No enabled account serves this model.",
				protocol,
				pin ? target.slice(2) : undefined,
			);
		let last: Response | undefined;
		// A selection round visits every sibling; request-retry adds rounds, not accounts.
		const rounds = pin ? 1 : this.accounts.routing.retries + 1;
		for (let round = 0; round < rounds; round++) {
			let attempted = false;
			for (const account of candidates) {
				const key = accountKey(account.record.id);
				if (account.cooldown > Date.now()) {
					last ??= protocolError(
						account.lastStatus ?? 429,
						`account ${account.record.name} (${account.family}): cooling down`,
						protocol,
						key,
						String(Math.ceil((account.cooldown - Date.now()) / 1000)),
					);
					if (pin) return last;
					continue;
				}
				attempted = true;
				let payload = !pin && previous && previous !== account.record.id ? rewriteReasoning(body, protocol) : body;
				for (let reasoningRetry = 0; reasoningRetry < 2; reasoningRetry++) {
					const release = await this.acquire(account, request.signal);
					let lease: symbol | undefined;
					const scope = `credne-${crypto.randomUUID()}`;
					const headers = new Headers(request.headers);
					for (const name of [
						"authorization",
						"x-api-key",
						"cookie",
						"cookie2",
						"proxy-authorization",
						"host",
						"origin",
						"accept-encoding",
					])
						headers.delete(name);
					if (session) headers.set("x-prompt-cache-key", session);
					const credential = account.storage.credentials.get(account.provider);
					if (credential?.type === "oauth") {
						const identity = resolveCredentialIdentityKey(account.provider, credential);
						lease = account.storage.sessions.restrict(account.provider, scope, identity ? [identity] : []);
					}
					const controller = new AbortController();
					const attempt: Attempt = {
						account,
						body: payload,
						protocol,
						signal: AbortSignal.any([request.signal, controller.signal]),
						hosted: hostedTools(payload),
						ready: Promise.withResolvers<void>(),
						headersReady: false,
						controller,
					};
					const client = lease
						? {
								name: key,
								limitsModels: false,
								allows: (_model: Model<Api>) => true,
								credentialSessionId: () => scope,
								retain: () => () => {},
							}
						: undefined;
					// Hosted definitions have no generic JSON-schema tool equivalent. Keep them out of the codec;
					// the provider transport restores the original native definitions before the real request.
					const gatewayBody = attempt.hosted
						? {
								...payload,
								tools: array(payload.tools).filter(
									(tool) => !String(object(tool).type).startsWith("web_search"),
								),
								tool_choice: undefined,
							}
						: payload;
					let response: Response;
					try {
						const routePath = path.startsWith("/v1/") ? path : `/v1${path}`;
						response = await context.run(attempt, () =>
							this.router(account).route(
								new Request(`http://gateway${routePath}`, {
									method: "POST",
									headers,
									body: JSON.stringify(gatewayBody),
									signal: attempt.signal,
								}),
								"loopback",
								client,
							),
						);
						// Anthropic emits a synthetic start before fetch. Buffer those frames until the
						// actual transport response, or a terminal preflight failure, decides HTTP status.
						if (payload.stream === true && response.ok && response.body) {
							const reader = response.body.getReader();
							const buffered: Uint8Array[] = [];
							let pending: Promise<StreamRead> | undefined;
							let ended = false;
							while (!attempt.headersReady) {
								pending ??= reader.read();
								const next = await Promise.race([attempt.ready.promise.then(() => undefined), pending]);
								if (next === undefined) break;
								pending = undefined;
								if (next.done) {
									ended = true;
									attempt.status ??= 502;
									break;
								}
								buffered.push(next.value);
							}
							const stream = new ReadableStream<Uint8Array>({
								start(controller) {
									for (const chunk of buffered) controller.enqueue(chunk);
									if (ended) {
										controller.close();
										reader.releaseLock();
										release();
									}
								},
								async pull(controller) {
									if (ended) return;
									try {
										const next = await (pending ?? reader.read());
										pending = undefined;
										if (next.done) {
											ended = true;
											controller.close();
											reader.releaseLock();
											release();
										} else controller.enqueue(next.value);
									} catch (error) {
										ended = true;
										release();
										controller.error(error);
									}
								},
								async cancel(reason) {
									if (ended) return;
									ended = true;
									try {
										await reader.cancel(reason);
									} finally {
										reader.releaseLock();
										release();
									}
								},
							});
							response = new Response(stream, { status: response.status, headers: response.headers });
						}
					} catch {
						release();
						if (lease) account.storage.sessions.unrestrict(account.provider, scope, lease);
						request.signal.throwIfAborted();
						response = protocolError(
							attempt.status ?? 502,
							`account ${account.record.name} (${account.family}): provider request failed`,
							protocol,
							key,
							attempt.retryAfter,
						);
					}
					const status = attempt.status && attempt.status >= 400 ? attempt.status : response.status;
					if (status >= 400) {
						await response.body?.cancel();
						release();
						if (lease) account.storage.sessions.unrestrict(account.provider, scope, lease);
						if (!pin && reasoningRetry === 0 && attempt.reasoningRejected) {
							payload = rewriteReasoning(payload, protocol);
							continue;
						}
						account.lastStatus = status;
						if ([429, 402, 503].includes(status)) {
							const seconds = Number(attempt.retryAfter);
							const date = Date.parse(attempt.retryAfter ?? "");
							account.cooldown =
								Number.isFinite(seconds) && seconds > 0
									? Date.now() + seconds * 1000
									: Number.isFinite(date)
										? date
										: Date.now() + (status === 402 ? 3600000 : 60000);
						}
						last = protocolError(
							status,
							`account ${account.record.name} (${account.family}): provider returned HTTP ${status}`,
							protocol,
							key,
							attempt.retryAfter,
						);
						if (pin || ![401, 402, 403, 429, 500, 502, 503, 504].includes(status)) return last;
						break;
					}
					if (attempt.native) {
						try {
							const native = await attempt.native;
							await response.body?.cancel();
							response = Response.json(native);
						} catch {
							release();
							if (lease) account.storage.sessions.unrestrict(account.provider, scope, lease);
							return protocolError(502, "Provider returned invalid hosted tool output.", protocol, key);
						}
					}
					if (payload.stream !== true) {
						release();
						if (lease) account.storage.sessions.unrestrict(account.provider, scope, lease);
					} else if (lease) {
						const original = response.body!.getReader();
						const finish = () => {
							account.storage.sessions.unrestrict(account.provider, scope, lease!);
						};
						response = new Response(
							new ReadableStream({
								async pull(controller) {
									try {
										const next = await original.read();
										if (next.done) {
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
										await original.cancel(reason);
									} finally {
										finish();
									}
								},
							}),
							{ headers: response.headers },
						);
					}
					if (sessionKey) {
						if (this.sessions.size >= 10000) this.sessions.delete(this.sessions.keys().next().value!);
						this.sessions.set(sessionKey, account.record.id);
					}
					const resultHeaders = new Headers(response.headers);
					resultHeaders.set("x-credne-account", key);
					resultHeaders.set("cache-control", "no-store");
					return new Response(response.body, { status: response.status, headers: resultHeaders });
				}
			}
			if (!attempted) break;
		}
		return last ?? protocolError(503, "No account is currently available.", protocol);
	}
	close(): void {
		for (const { router } of this.routers.values()) router.close();
		this.routers.clear();
	}
}
