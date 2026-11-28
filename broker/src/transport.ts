// Observes OMP's upstream answers, shares Codex cache routing, and bounds opt-in cache refreshes.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { parseJsonBody } from "@oh-my-pi/pi-ai/error";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import { OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import { isSubscriptionUsageLimit } from "../../packages/ai/src/utils/usage-limit.ts";
import { type Account, boundedText, isChatSubscription } from "./accounts.ts";
import { object, text } from "./wire.ts";

/** One try of a request on one account. The transport reports what it sees; the gateway decides what to do about it. */
export interface Attempt {
	account: Account;
	/** The model OMP serves for this attempt; the gateway picked it together with the account. */
	model: Model<Api>;
	codexCacheAffinity?: string;
	/** A cache refresh gets one outbound fetch, regardless of OMP retry or recovery paths. */
	cacheRefresh?: "ready" | "sent";
	/** Whether the transport may cut the attempt short so the pool can move on to its next account. */
	failover: boolean;
	controller: AbortController;
	signal: AbortSignal;
	/** Status and retry hint of the last upstream answer; a request that failed to complete reads as 502. */
	status?: number;
	retryAfter?: string;
	subscriptionLimit?: boolean;
	/** Why the attempt failed when no provider status explains it. */
	failure?: string;
	/** True once the transport aborted the attempt because of a failover status. */
	cut: boolean;
	/** True once an answer stands or the attempt was cut; later answers neither cut nor change the decision. */
	isDecided: boolean;
	/** Settles with the decision, or when the request is aborted. */
	decided: PromiseWithResolvers<void>;
}

const attempts = new AsyncLocalStorage<Attempt>();
const creditLimit = 256 * 1024;

/** Creates the attempt record for one try; `signal` is the caller's and ends it with the request. */
export function newAttempt(account: Account, model: Model<Api>, failover: boolean, signal: AbortSignal): Attempt {
	const controller = new AbortController();
	const attempt: Attempt = {
		account,
		model,
		failover,
		controller,
		signal: AbortSignal.any([signal, controller.signal]),
		cut: false,
		isDecided: false,
		decided: Promise.withResolvers<void>(),
	};
	// An aborted request will never be decided by an answer; whoever waits for the decision must not wait for one.
	if (attempt.signal.aborted) attempt.decided.resolve();
	else attempt.signal.addEventListener("abort", () => attempt.decided.resolve(), { once: true });
	return attempt;
}

/** Runs `run` so every provider request OMP sends inside it reports to `attempt`. */
export function runAttempt<T>(attempt: Attempt, run: () => T): T {
	return attempts.run(attempt, run);
}

/** The attempt the running provider request belongs to. */
export function currentAttempt(): Attempt {
	const attempt = attempts.getStore();
	if (!attempt) throw new Error("Missing account request context.");
	return attempt;
}

/** Statuses after which another account may serve the request: limits, billing, auth and server failures. */
export function isFailoverStatus(status: number): boolean {
	return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

/**
 * OMP's own transport choice for a model when no `fetch` is supplied (utils/transport-fetch.ts): Claude Code's TLS
 * profile for Anthropic Messages, plain fetch for everything else. OMP layers the User-Agent, extra CA and proxy
 * handling above whatever it is given, so the broker only has to name the same base.
 */
export function defaultTransport(model: Model<Api>): FetchImpl {
	return model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : globalThis.fetch;
}

/**
 * The `fetch` for an account's router. Codex uses the session header for cache routing, but OMP's pi-native
 * gateway does not accept its server-only `parentSessionId`. Share just that header on opted-in worker calls.
 */
export function observingFetch(): FetchImpl {
	return async (input, init) => {
		const attempt = currentAttempt();
		if (attempt.cacheRefresh === "sent") {
			const error = new Error("Cache refresh cannot retry the provider request.");
			attempt.controller.abort(error);
			throw error;
		}
		if (attempt.cacheRefresh === "ready") {
			attempt.signal.throwIfAborted();
			attempt.cacheRefresh = "sent";
			const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
			init = {
				...init,
				signal: signal ? AbortSignal.any([signal, attempt.signal]) : attempt.signal,
				redirect: "error",
			};
		}
		let response: Response;
		try {
			if (attempt.codexCacheAffinity) {
				const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
				if (headers.has(OPENAI_HEADERS.SESSION_ID)) {
					headers.set(OPENAI_HEADERS.SESSION_ID, attempt.codexCacheAffinity);
					init = { ...init, headers };
				}
			}
			response = await defaultTransport(attempt.model)(input, init);
		} catch (error) {
			// An abort is the caller's or the broker's own; anything else means the provider never answered.
			if (!attempt.signal.aborted) failAttempt(attempt, "provider request failed");
			throw error;
		}
		await observe(attempt, response);
		return response;
	};
}

function failAttempt(attempt: Attempt, failure: string): void {
	attempt.status = 502;
	attempt.retryAfter = undefined;
	attempt.subscriptionLimit = false;
	attempt.failure = failure;
	decide(attempt);
}

async function observe(attempt: Attempt, response: Response): Promise<void> {
	attempt.status = response.status;
	attempt.retryAfter = response.headers.get("retry-after") ?? undefined;
	attempt.failure = undefined;
	attempt.subscriptionLimit = false;
	if (response.status === 429 && isChatSubscription(attempt.account)) {
		const detail = await boundedText(response.clone(), creditLimit).catch(() => "");
		const envelope = parseJsonBody(detail);
		const error = object(envelope?.error ?? envelope);
		const message = text(error.message) ?? (envelope ? "" : detail);
		const code = text(error.code) ?? text(error.type) ?? "";
		if (isSubscriptionUsageLimit(`${code}: ${message}`, response.headers)) {
			attempt.subscriptionLimit = true;
			attempt.failure = "Subscription usage limit reached.";
			const reset =
				attempt.model.api === "anthropic-messages"
					? Number(response.headers.get("anthropic-ratelimit-unified-reset"))
					: error.resets_at;
			if (typeof reset === "number" && reset * 1000 > Date.now() && reset * 1000 <= 8.64e15)
				attempt.failure += ` Resets at ${new Date(reset * 1000).toISOString()}.`;
		}
	}
	// Anthropic answers an empty credit balance with a 400. It is billing, not a malformed request, so it benches the
	// account like a 402. The clone leaves OMP's copy of the body unread.
	if (response.status === 400 && (await creditExhausted(response.clone()))) {
		attempt.status = 402;
		attempt.retryAfter = "3600";
	}
	decide(attempt);
}

async function creditExhausted(response: Response): Promise<boolean> {
	const detail = await boundedText(response, creditLimit).catch(() => "");
	return /credit balance.*too low|insufficient.*credit/i.test(detail);
}

function decide(attempt: Attempt): void {
	const status = attempt.status!;
	if (attempt.isDecided) return;
	// An ordinary OMP request can recover from auth failure; a cache refresh cannot retry.
	if (!attempt.cacheRefresh && (status === 401 || status === 403)) return;
	attempt.isDecided = true;
	if (
		(attempt.cacheRefresh && status >= 400) ||
		attempt.subscriptionLimit ||
		(attempt.failover && isFailoverStatus(status))
	) {
		attempt.cut = true;
		attempt.controller.abort();
	}
	attempt.decided.resolve();
}
