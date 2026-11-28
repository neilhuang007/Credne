import type { Api, AuthCredential, Model } from "@oh-my-pi/pi-ai";
import { normalizeClientSessionKey } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { type AuthGatewayRouter, createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway/server";
import { prewarmModelConnection } from "@oh-my-pi/pi-ai/providers/connection-prewarm";
import { resolveCacheRetention } from "@oh-my-pi/pi-ai/utils";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import {
	type Account,
	type Accounts,
	accountKey,
	classifierAccount,
	cooldownStatuses,
	HttpError,
	isChatSubscription,
	recordFailure,
} from "./accounts.ts";
import { KeyRoute } from "./key-route.ts";
import { SearchProviderError } from "./omp-search/types.ts";
import { holdUntil, relay } from "./relay.ts";
import { readSearchRequest, searchModels, searchOnModel } from "./search.ts";
import { SessionLocks } from "./session-lock.ts";
import { projectToolTimeline } from "./tool-timeline.ts";
import { type Attempt, currentAttempt, isFailoverStatus, newAttempt, observingFetch, runAttempt } from "./transport.ts";
import { object, text } from "./wire.ts";

// Provider diagnostics may contain upstream error bodies. The public broker logs only its lifecycle.
setTransports({ file: false, console: false });

const piStreamUrl = "http://gateway/v1/pi/stream";
const systemOneUrl = "http://gateway/v1/systemone";
// The broker's own credential and the connection's framing are the broker's business; the rest reaches OMP as sent.
const brokerHeaders = [
	"authorization",
	"x-api-key",
	"host",
	"content-length",
	"connection",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
];

/** A pi-native request with original bytes for every account that cannot apply the optional projection. */
interface PiNativeRequest {
	bytes: ArrayBuffer;
	toolTimelineBody?: Record<string, unknown>;
	modelId: string;
	/** The id OMP resolves the request's credentials under and keys its provider state by. */
	sessionId: string;
	cacheAffinity?: { kind: "openai" | "anthropic"; key: string };
	mode: "chat" | "cache-refresh";
	streaming: boolean;
}

/** One request to the pool or pinned account, shared by its attempts. */
interface PiStreamCall {
	request: Request;
	wire: PiNativeRequest;
	headers: Headers;
}

/** An attempt either answered, or failed in a way that lets the pool try its next account. */
type Outcome = { kind: "served"; response: Response; accepted: boolean } | { kind: "failed"; response: Response };

export function protocolError(
	status: number,
	message: string,
	key?: string,
	retryAfter?: string,
	errorType?: string,
): Response {
	const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
	if (key) headers["x-credne-account"] = key;
	if (retryAfter) headers["retry-after"] = retryAfter;
	const type = status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : "api_error";
	return Response.json({ error: { type: errorType ?? type, message } }, { status, headers });
}

export class Gateway {
	private readonly systemOne: KeyRoute;
	private readonly routers = new Map<string, { account: Account; router: AuthGatewayRouter }>();
	private readonly sessions = new Map<string, string>();
	private readonly locks = new SessionLocks();
	private readonly inFlight = new Map<string, number>();
	private readonly queues = new Map<string, Set<() => void>>();
	private cursor = 0;
	constructor(
		private readonly accounts: Accounts,
		private readonly maxConcurrency: number,
	) {
		this.systemOne = new KeyRoute(accounts, (account, signal) => this.acquire(account, signal), {
			api: "System One API",
			families: [
				{ provider: "typesafe", pool: "typesafe", vendor: "TypeSafe", failover: true },
				// The key is shared with chat, so a failed classification never cools the account.
				{ provider: "openai-api", pool: "openai", vendor: "OpenAI", failover: false },
			],
			serve: (request, account, body, model, failover) => this.judge(request, account, body, model, failover),
		});
	}

	async execute(request: Request, target: string, path: string): Promise<Response> {
		if (path === "/systemone") return this.systemOne.execute(request, target);
		if (path === "/search") return this.search(request, target);
		if (path === "/prewarm") return this.prewarm(request, target);
		return this.piStream(request, target, path === "/pi/cache-refresh" ? "cache-refresh" : "chat");
	}

	/**
	 * Warms the provider connection of every enabled account the target would route the model to, as OMP's coding
	 * agent does at startup, on a model change and while the user types. OMP sends a credential-less HEAD through its
	 * default transport, the one the account's real requests end in, so the next turn reuses the socket; it throttles
	 * per origin and never throws. No credential, lock, concurrency slot or pool turn is taken, and the answer does not
	 * wait for the network.
	 */
	private async prewarm(request: Request, target: string): Promise<Response> {
		const { modelId } = modelRequest(await request.arrayBuffer());
		const accounts = await this.servingAccounts(target, modelId);
		const models = new Set<Model<Api>>();
		for (const account of accounts) if (!account.record.disabled) models.add(findModel(account, modelId)!);
		for (const model of models) void prewarmModelConnection(model);
		return new Response(null, { status: 204 });
	}

	/**
	 * Hosted web search on one pinned subscription, sent by OMP's own search providers (see `search.ts`). The session is
	 * held on the account's credential like a chat request, so OMP cannot fall back to an environment key. A failure on
	 * the search swap model falls through to the session model, as in OMP; a usage limit benches the account.
	 */
	private async search(request: Request, target: string): Promise<Response> {
		if (!target.startsWith("a.")) throw new HttpError(404, "Hosted web search runs on a pinned account route.");
		const key = target.slice(2);
		const account = this.accounts.get(key);
		const search = await readSearchRequest(request);
		if (account.record.disabled) return protocolError(403, "Pinned account is disabled.", key);
		if (account.record.kind !== "oauth")
			return protocolError(400, "Hosted web search needs a Claude or ChatGPT subscription account.", key);
		if (account.cooldown > Date.now()) {
			return cooldownError(account);
		}
		await account.discovering;
		const sessionModel = findModel(account, search.modelId);
		if (!sessionModel) return protocolError(404, "The account does not serve this model.", key);
		const models = searchModels(account, sessionModel);
		if (!models.length) return protocolError(400, `${sessionModel.id} has no hosted web search.`, key);
		const credential = account.storage.credentials.get(account.provider);
		if (!credential) return protocolError(401, "The selected account has no saved credential.", key);
		const release = await this.acquire(account, request.signal);
		const unlock = this.locks.hold(account, credential, search.sessionId);
		try {
			let failure: { status: number; message: string } | undefined;
			for (const model of models) {
				try {
					const result = await searchOnModel(account, model, search, request.signal);
					return Response.json(result, { headers: { "x-credne-account": key, "cache-control": "no-store" } });
				} catch (error) {
					request.signal.throwIfAborted();
					const status = error instanceof SearchProviderError ? (error.status ?? 502) : 502;
					failure = { status, message: error instanceof Error ? error.message : "search failed" };
				}
			}
			const { status, message } = failure!;
			if (cooldownStatuses.includes(status)) recordFailure(account, status);
			const detail = message.replace(/[\s\p{Cc}]+/gu, " ").slice(0, 500);
			return protocolError(status, `account ${account.record.name} (${account.family}): ${detail}`, key);
		} finally {
			unlock();
			release();
		}
	}

	/** Answers a System One request through OMP's own `/v1/systemone` route, which reads the account's key and speaks its judge's wire. */
	private async judge(
		request: Request,
		account: Account,
		body: ArrayBuffer,
		modelId: string,
		failover: boolean,
	): Promise<Response> {
		const model = account.judges.find((entry) => entry.id === modelId);
		if (!model) return protocolError(404, `Unknown model: ${modelId}`);
		const attempt = newAttempt(account, model, failover, request.signal);
		const routed = runAttempt(attempt, () =>
			this.router(account).route(
				new Request(systemOneUrl, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
					signal: attempt.signal,
				}),
				"loopback",
			),
		);
		// OMP sleeps before it gives up on a failed answer, and a failover must not wait that out. The cut request
		// finishes unobserved.
		const answered = failover
			? await Promise.race([routed, attempt.decided.promise.then(() => undefined)])
			: await routed;
		const response = attempt.cut ? undefined : (answered ?? (await routed));
		// OMP's own refusals (invalid body, no credential) never reach the transport and pass through.
		if (response && (!attempt.status || attempt.status < 400)) return response;
		const status = attempt.status ?? response?.status ?? 502;
		return protocolError(
			status,
			`account ${account.record.name} (${account.family}): ${attempt.failure ?? `provider returned HTTP ${status}`}`,
			undefined,
			attempt.retryAfter,
		);
	}

	/**
	 * Hands a pi-native request to OMP's router exactly as OMP's own gateway server would receive it from a
	 * gateway-token caller: the original headers and usually the original bytes. An opted-in tool timeline is
	 * projected only for the selected OpenAI route; OMP still builds, signs and sends the provider request.
	 */
	private async piStream(request: Request, target: string, mode: PiNativeRequest["mode"]): Promise<Response> {
		const call = await readPiStream(request, mode);
		const pin = target.startsWith("a.");
		if (mode === "cache-refresh" && !pin) return protocolError(400, "Cache refresh requires a pinned account.");
		const { modelId, sessionId, cacheAffinity } = call.wire;
		let candidates = await this.servingAccounts(target, modelId);
		if (pin && candidates[0]?.record.disabled)
			return protocolError(403, "Pinned account is disabled.", target.slice(2));
		const sessionKey = `${target}\0${sessionId}`;
		const prefixKey = cacheAffinity && `prefix\0${cacheAffinity.kind}\0${target}\0${modelId}\0${cacheAffinity.key}`;
		if (!pin) {
			const preferred = this.sessions.get(sessionKey) ?? (prefixKey && this.sessions.get(prefixKey));
			candidates = this.orderPool(candidates, preferred);
			if (decodeURIComponent(target.slice(2)) === "all") {
				const families = new Set(
					candidates.map(({ family }) =>
						family === "codex" ? "openai" : family === "xai-oauth" ? "xai" : family,
					),
				);
				if (families.size > 1)
					return protocolError(409, "Different providers use this model ID. Select a provider pool.");
			}
		}
		if (!candidates.length)
			return protocolError(404, "No enabled account serves this model.", pin ? target.slice(2) : undefined);
		let last: Response | undefined;
		// A selection round visits every sibling; request-retry adds rounds, not accounts.
		const rounds = pin ? 1 : this.accounts.routing.retries + 1;
		for (let round = 0; round < rounds; round++) {
			let attempted = false;
			for (const [index, account] of candidates.entries()) {
				const key = accountKey(account.record.id);
				if (account.cooldown > Date.now()) {
					last ??= cooldownError(account);
					if (pin) return last;
					continue;
				}
				attempted = true;
				const credential = account.storage.credentials.get(account.provider);
				if (!credential) {
					last = protocolError(401, "The selected account has no saved credential.", key);
					if (pin) return last;
					continue;
				}
				// A cut attempt hands over to a sibling. Without an available one, or in the last slot of the last round,
				// OMP's own retries and recovery run to the end instead.
				const sibling = candidates.some((other) => other !== account && other.cooldown <= Date.now());
				const failover = !pin && sibling && !(round === rounds - 1 && index === candidates.length - 1);
				const outcome = await this.tryAccount(account, credential, call, failover);
				if (outcome.kind === "failed") {
					last = outcome.response;
					continue;
				}
				if (outcome.accepted && !pin) {
					this.remember(sessionKey, account.record.id);
					if (
						cacheAffinity &&
						prefixKey &&
						(cacheAffinity.kind === "openai" || findModel(account, modelId)?.api === "anthropic-messages")
					)
						this.remember(prefixKey, account.record.id);
				}
				return outcome.response;
			}
			if (!attempted) break;
		}
		return last ?? protocolError(503, "No account is currently available.");
	}

	/** The chat accounts a pinned (`a.<key>`) or pool (`p.<name>`) target names that list the model, disabled included. */
	private async servingAccounts(target: string, modelId: string): Promise<Account[]> {
		const pin = target.startsWith("a.");
		if (!pin && !target.startsWith("p.")) throw new HttpError(404, "route target not found");
		const pool = decodeURIComponent(target.slice(2));
		const accounts = pin
			? [this.accounts.get(target.slice(2))]
			: [...this.accounts.accounts.values()].filter((account) => pool === "all" || account.family === pool);
		// A subscription still reading its model list may serve a model its bundled list lacks; choosing before the read
		// lands would send the request to an API key.
		await Promise.all(accounts.map((account) => account.discovering));
		return accounts.filter((account) => !classifierAccount(account) && findModel(account, modelId));
	}

	private async tryAccount(
		account: Account,
		credential: AuthCredential,
		call: PiStreamCall,
		failover: boolean,
	): Promise<Outcome> {
		const model = findModel(account, call.wire.modelId)!;
		const cacheRefresh = call.wire.mode === "cache-refresh";
		if (cacheRefresh && (model.provider !== "anthropic" || model.api !== "anthropic-messages")) {
			return { kind: "served", response: protocolError(400, "Cache refresh requires Claude."), accepted: false };
		}
		// A refresh cannot afford to wait for a slot: the entry may expire while queued. `acquire` reserves
		// the available slot synchronously before it returns, so chat still uses the same admission path.
		if (
			cacheRefresh &&
			this.maxConcurrency > 0 &&
			(this.inFlight.get(account.record.id) ?? 0) >= this.maxConcurrency
		) {
			return {
				kind: "served",
				response: protocolError(503, "Cache refresh skipped: account is busy."),
				accepted: false,
			};
		}
		const release = await this.acquire(account, call.request.signal);
		const unlock = this.locks.hold(account, credential, call.wire.sessionId);
		const attempt = newAttempt(account, model, failover, call.request.signal);
		if (cacheRefresh) attempt.cacheRefresh = "ready";
		const cacheAffinity = call.wire.cacheAffinity;
		if (model.api === "openai-codex-responses" && cacheAffinity?.kind === "openai")
			attempt.codexCacheAffinity = cacheAffinity.key;
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			const status = attempt.status;
			// A keepalive's transport/server failure should not block real chat. Actual limits and billing still apply.
			if (status !== undefined && status >= 400 && (!cacheRefresh || status === 429 || status === 402)) {
				recordFailure(account, status, attempt.retryAfter, attempt.subscriptionLimit);
			}
			unlock();
			release();
		};
		try {
			return await this.drive(attempt, call, close);
		} catch {
			if (call.request.signal.aborted) {
				close();
				call.request.signal.throwIfAborted();
			}
			if (attempt.status === undefined || attempt.status < 400) {
				attempt.status = 502;
				attempt.failure ??= "provider request failed";
			}
			return failure(attempt, close);
		}
	}

	private async drive(attempt: Attempt, call: PiStreamCall, close: () => void): Promise<Outcome> {
		const { account, model } = attempt;
		const { bytes, toolTimelineBody } = call.wire;
		const projected = toolTimelineBody && projectToolTimeline(toolTimelineBody, model);
		const routed = runAttempt(attempt, () =>
			this.router(account).route(
				new Request(piStreamUrl, {
					method: "POST",
					headers: call.headers,
					body: projected ?? bytes,
					signal: attempt.signal,
				}),
				"loopback",
			),
		);
		// A non-streaming answer arrives with the finished turn; the transport's decision must not wait for it.
		const answered = attempt.failover
			? await Promise.race([routed, attempt.decided.promise.then(() => undefined)])
			: await routed;
		if (attempt.cut) {
			await answered?.body?.cancel();
			return failure(attempt, close);
		}
		const response = answered ?? (await routed);
		if (!response.ok) return this.routerRefusal(attempt, response, close);
		if (!call.wire.streaming) {
			close();
			return served(attempt, response, response.body);
		}
		const reader = response.body!.getReader();
		if (!attempt.failover && !attempt.cacheRefresh && !isChatSubscription(account))
			return served(attempt, response, relay(reader, { chunks: [], ended: false }, close));
		const held = await holdUntil(reader, attempt.decided.promise);
		// OMP ended the stream without an answer that stands: the provider showed only an auth status, or nothing.
		if (held.ended && attempt.status === undefined) attempt.failure = "request ended before reaching the provider";
		const status = attempt.status ?? 502;
		if (attempt.cut || (attempt.failover && held.ended && isFailoverStatus(status))) {
			await reader.cancel();
			return failure(attempt, close, status);
		}
		return served(attempt, response, relay(reader, held, close));
	}

	/** OMP's own answer without a stream: a refusal before the provider was asked, or the classified failure of a finished turn. */
	private async routerRefusal(attempt: Attempt, response: Response, close: () => void): Promise<Outcome> {
		const status = attempt.status !== undefined && attempt.status >= 400 ? attempt.status : response.status;
		attempt.status = status;
		if (!attempt.failover || !isFailoverStatus(status)) {
			close();
			return served(attempt, response, response.body, false);
		}
		await response.body?.cancel();
		return failure(attempt, close, status);
	}

	private router(account: Account): AuthGatewayRouter {
		const cached = this.routers.get(account.record.id);
		if (cached?.account === account) return cached.router;
		cached?.router.close();
		const router = createAuthGatewayRouter({
			storage: account.storage,
			fetch: observingFetch(),
			// The broker picked this attempt's account and model before asking OMP, so OMP serves exactly that model.
			resolveModel: () => currentAttempt().model,
		});
		this.routers.set(account.record.id, { account, router });
		return router;
	}

	private remember(sessionKey: string, accountId: string): void {
		if (this.sessions.size >= 10000) this.sessions.delete(this.sessions.keys().next().value!);
		this.sessions.set(sessionKey, accountId);
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

	private orderPool(candidates: Account[], previous?: string): Account[] {
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

		const subscriptions: Account[] = [];
		const remaining: Account[] = [];
		for (const account of enabled) {
			const group = account.storage.credentials.hasSubscription(account.provider) ? subscriptions : remaining;
			group.push(account);
		}
		return [...order(subscriptions), ...order(remaining)];
	}

	close(): void {
		for (const { router } of this.routers.values()) router.close();
		this.routers.clear();
	}
}

/** Reads routing fields and retains the decoded body only when a tool timeline needs it. */
async function readPiStream(request: Request, mode: PiNativeRequest["mode"]): Promise<PiStreamCall> {
	const bytes = await request.arrayBuffer();
	const { body, modelId } = modelRequest(bytes);
	// The id is the credential lock's key and the pool's affinity key; OMP would derive one the broker cannot know.
	const options = object(body.options);
	const sessionId = normalizeClientSessionKey(text(options.sessionId));
	if (sessionId === undefined) throw new HttpError(400, "options.sessionId is required");
	const streaming = body.stream !== false;
	if (
		mode === "cache-refresh" &&
		(!streaming ||
			options.statefulResponses !== false ||
			options.maxTokens !== 1 ||
			options.reasoning !== undefined ||
			(options.cacheRetention ?? resolveCacheRetention()) === "none")
	) {
		throw new HttpError(
			400,
			"Cache refresh requires a stateless, non-thinking one-token stream with caching enabled.",
		);
	}
	const headers = new Headers(request.headers);
	for (const name of brokerHeaders) headers.delete(name);
	const cacheAffinity = readCacheAffinity(body, options);
	const toolTimelineBody = mode === "chat" && body.toolTimeline !== undefined ? body : undefined;
	return { request, headers, wire: { bytes, modelId, sessionId, cacheAffinity, mode, streaming, toolTimelineBody } };
}

function readCacheAffinity(
	body: Record<string, unknown>,
	options: Record<string, unknown>,
): PiNativeRequest["cacheAffinity"] {
	if ((options.cacheRetention ?? resolveCacheRetention()) === "none") return undefined;
	if (body.cacheAffinity === "anthropic-shared-prefix") {
		// Broker account preference only; the provider's session identity and payload never use this key.
		const key = text(body.cacheAffinityKey);
		return key && /^subagent-[a-f0-9]{48}$/u.test(key) ? { kind: "anthropic", key } : undefined;
	}
	if (body.cacheAffinity === "shared-prefix") {
		const key = text(options.promptCacheKey);
		return key && /^[A-Za-z0-9_-]{1,64}$/u.test(key) ? { kind: "openai", key } : undefined;
	}
	return undefined;
}

/** The JSON object of a route request and the model it names; a malformed body or a missing `modelId` is a 400. */
function modelRequest(bytes: ArrayBuffer): { body: Record<string, unknown>; modelId: string } {
	let body: Record<string, unknown>;
	try {
		body = object(JSON.parse(new TextDecoder().decode(bytes)));
	} catch {
		throw new HttpError(400, "Invalid JSON body.");
	}
	const modelId = text(body.modelId);
	if (!modelId) throw new HttpError(400, "modelId is required");
	return { body, modelId };
}

/** The account's model for a bare or `provider/id` model ID, as OMP's pi-native client names it. */
function findModel(account: Account, modelId: string): Model<Api> | undefined {
	return account.models.find((model) => model.id === modelId || `${model.provider}/${model.id}` === modelId);
}

/** An answer for the caller. `accepted` says the provider answered it successfully, which is what pool affinity follows. */
function served(attempt: Attempt, response: Response, body: BodyInit | null, accepted?: boolean): Outcome {
	const headers = new Headers(response.headers);
	headers.set("x-credne-account", accountKey(attempt.account.record.id));
	headers.set("cache-control", "no-store");
	return {
		kind: "served",
		response: new Response(body, { status: response.status, headers }),
		accepted: accepted ?? (attempt.status === undefined || attempt.status < 400),
	};
}

function cooldownError(account: Account): Response {
	return protocolError(
		account.lastStatus ?? 429,
		`account ${account.record.name} (${account.family}): ${account.subscriptionLimit ? "Subscription usage limit reached." : "cooling down"}`,
		accountKey(account.record.id),
		String(Math.ceil((account.cooldown - Date.now()) / 1000)),
		account.subscriptionLimit ? "usage_limit_reached" : undefined,
	);
}

/** The attempt ended in a way that lets the pool try its next account; the last one's error is what the caller gets if none does. */
function failure(attempt: Attempt, close: () => void, status = attempt.status ?? 502): Outcome {
	attempt.status = status;
	close();
	const { account } = attempt;
	return {
		kind: "failed",
		response: protocolError(
			status,
			`account ${account.record.name} (${account.family}): ${attempt.failure ?? `provider returned HTTP ${status}`}`,
			accountKey(account.record.id),
			attempt.retryAfter,
			attempt.subscriptionLimit ? "usage_limit_reached" : undefined,
		),
	};
}
