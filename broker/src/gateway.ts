import type { Api, AuthCredential, Model } from "@oh-my-pi/pi-ai";
import { normalizeClientSessionKey } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { type AuthGatewayRouter, createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway/server";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import { type Account, type Accounts, accountKey, classifierAccount, HttpError, recordFailure } from "./accounts.ts";
import { KeyRoute } from "./key-route.ts";
import { holdUntil, relay } from "./relay.ts";
import { SessionLocks } from "./session-lock.ts";
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

/** A pi-native request: the broker reads what it routes by, and its bytes reach OMP unchanged. */
interface PiNativeRequest {
	bytes: ArrayBuffer;
	modelId: string;
	/** The id OMP resolves the request's credentials under and keys its provider state by. */
	sessionId: string;
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

export function protocolError(status: number, message: string, key?: string, retryAfter?: string): Response {
	const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
	if (key) headers["x-credne-account"] = key;
	if (retryAfter) headers["retry-after"] = retryAfter;
	const type = status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : "api_error";
	return Response.json({ error: { type, message } }, { status, headers });
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
		return this.piStream(request, target);
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
	 * gateway-token caller: the original bytes and headers, no scoped client. The broker only chooses the account
	 * and watches the provider's answers (see `transport.ts`); OMP builds, signs and sends the provider request.
	 */
	private async piStream(request: Request, target: string): Promise<Response> {
		const call = await readPiStream(request);
		const pin = target.startsWith("a.");
		if (!pin && !target.startsWith("p.")) throw new HttpError(404, "route target not found");
		const pool = decodeURIComponent(target.slice(2));
		const { modelId, sessionId } = call.wire;
		let candidates = pin
			? [this.accounts.get(target.slice(2))]
			: [...this.accounts.accounts.values()].filter((account) => pool === "all" || account.family === pool);
		candidates = candidates.filter((account) => !classifierAccount(account) && findModel(account, modelId));
		if (pin && candidates[0]?.record.disabled)
			return protocolError(403, "Pinned account is disabled.", target.slice(2));
		const sessionKey = `${target}\0${sessionId}`;
		if (!pin) {
			candidates = this.orderPool(candidates, this.sessions.get(sessionKey));
			if (pool === "all") {
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
					last ??= protocolError(
						account.lastStatus ?? 429,
						`account ${account.record.name} (${account.family}): cooling down`,
						key,
						String(Math.ceil((account.cooldown - Date.now()) / 1000)),
					);
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
				if (outcome.accepted && !pin) this.remember(sessionKey, account.record.id);
				return outcome.response;
			}
			if (!attempted) break;
		}
		return last ?? protocolError(503, "No account is currently available.");
	}

	private async tryAccount(
		account: Account,
		credential: AuthCredential,
		call: PiStreamCall,
		failover: boolean,
	): Promise<Outcome> {
		const model = findModel(account, call.wire.modelId)!;
		const release = await this.acquire(account, call.request.signal);
		const unlock = this.locks.hold(account, credential, call.wire.sessionId);
		const attempt = newAttempt(account, model, failover, call.request.signal);
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			if (attempt.status !== undefined && attempt.status >= 400)
				recordFailure(account, attempt.status, attempt.retryAfter);
			unlock();
			release();
		};
		try {
			return await this.drive(attempt, call, close);
		} catch {
			call.request.signal.throwIfAborted();
			if (attempt.status === undefined || attempt.status < 400) {
				attempt.status = 502;
				attempt.failure ??= "provider request failed";
			}
			return failure(attempt, close);
		}
	}

	private async drive(attempt: Attempt, call: PiStreamCall, close: () => void): Promise<Outcome> {
		const { account } = attempt;
		const routed = runAttempt(attempt, () =>
			this.router(account).route(
				new Request(piStreamUrl, {
					method: "POST",
					headers: call.headers,
					body: call.wire.bytes,
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
		if (!attempt.failover) return served(attempt, response, relay(reader, { chunks: [], ended: false }, close));
		const held = await holdUntil(reader, attempt.decided.promise);
		// OMP ended the stream without an answer that stands: the provider showed only an auth status, or nothing.
		if (held.ended && attempt.status === undefined) attempt.failure = "request ended before reaching the provider";
		const status = attempt.status ?? 502;
		if (attempt.cut || (held.ended && isFailoverStatus(status))) {
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

/** Reads what the broker routes a pi-native request by; the caller's headers and bytes are kept as they are. */
async function readPiStream(request: Request): Promise<PiStreamCall> {
	const bytes = await request.arrayBuffer();
	let body: Record<string, unknown>;
	try {
		body = object(JSON.parse(new TextDecoder().decode(bytes)));
	} catch {
		throw new HttpError(400, "Invalid JSON body.");
	}
	const modelId = text(body.modelId);
	if (!modelId) throw new HttpError(400, "modelId is required");
	// The id is the credential lock's key and the pool's affinity key; OMP would derive one the broker cannot know.
	const sessionId = normalizeClientSessionKey(text(object(body.options).sessionId));
	if (sessionId === undefined) throw new HttpError(400, "options.sessionId is required");
	const headers = new Headers(request.headers);
	for (const name of brokerHeaders) headers.delete(name);
	return { request, headers, wire: { bytes, modelId, sessionId, streaming: body.stream !== false } };
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
		),
	};
}
