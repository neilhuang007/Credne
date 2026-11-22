// The broker's only seam into OMP's provider requests: it watches upstream answers and changes nothing.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import { type Account, boundedText } from "./accounts.ts";

/** One try of a request on one account. The transport reports what it sees; the gateway decides what to do about it. */
export interface Attempt {
	account: Account;
	/** The model OMP serves for this attempt; the gateway picked it together with the account. */
	model: Model<Api>;
	/** Whether the transport may cut the attempt short so the pool can move on to its next account. */
	failover: boolean;
	controller: AbortController;
	signal: AbortSignal;
	/** Status and retry hint of the last upstream answer; a request that failed to complete reads as 502. */
	status?: number;
	retryAfter?: string;
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
 * The `fetch` for an account's router. It calls OMP's default transport with the request exactly as OMP built it,
 * returns the answer untouched, and records the status and retry hint for the running attempt.
 */
export function observingFetch(): FetchImpl {
	return async (input, init) => {
		const attempt = currentAttempt();
		let response: Response;
		try {
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
	attempt.failure = failure;
	decide(attempt);
}

async function observe(attempt: Attempt, response: Response): Promise<void> {
	attempt.status = response.status;
	attempt.retryAfter = response.headers.get("retry-after") ?? undefined;
	attempt.failure = undefined;
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
	// OMP refreshes the credential after a 401 or 403 and retries; only the end of the attempt shows whether it worked.
	if (status === 401 || status === 403) return;
	attempt.isDecided = true;
	if (attempt.failover && isFailoverStatus(status)) {
		attempt.cut = true;
		attempt.controller.abort();
	}
	attempt.decided.resolve();
}
