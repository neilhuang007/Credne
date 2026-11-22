// Selects an API-key account for the System One route, pinned or pooled; `serve` then asks OMP to answer for it.
import { type Account, type Accounts, accountKey, HttpError, recordFailure } from "./accounts.ts";
import { isFailoverStatus } from "./transport.ts";
import { object, text } from "./wire.ts";

/** One kind of account System One reaches, the pool that addresses it, and how its limits are treated. */
export interface KeyFamily {
	/** `record.provider` of the accounts. */
	provider: string;
	/** Pool addressed as `p.<pool>`. */
	pool: string;
	/** Provider name as errors give it. */
	vendor: string;
	/** Whether a rate-limited, unpaid or failing account is cooled down and its pool moves on to the next account. */
	failover: boolean;
}

export interface KeyRouteSpec {
	/** API name as errors give it. */
	api: string;
	families: KeyFamily[];
	/** Asks OMP to answer for the selected account; `failover` lets the attempt be cut for the pool's next account. */
	serve(request: Request, account: Account, body: ArrayBuffer, model: string, failover: boolean): Promise<Response>;
}

export class KeyRoute {
	private cursor = 0;

	constructor(
		private readonly accounts: Accounts,
		private readonly acquire: (account: Account, signal: AbortSignal) => Promise<() => void>,
		private readonly spec: KeyRouteSpec,
	) {}

	async execute(request: Request, target: string): Promise<Response> {
		const route = /^(a|p)\.(.+)$/.exec(target);
		if (!route) throw new HttpError(400, "invalid route target");
		const [, kind, name] = route;
		const pin = kind === "a";
		if (pin && (!/^[\w-]+$/.test(name) || Buffer.from(name, "base64url").toString("base64url") !== name))
			throw new HttpError(400, "invalid account key");
		const body = await request.arrayBuffer();
		const model = requestModel(body);
		return pin ? this.executePinned(request, name, body, model) : this.executePooled(request, name, body, model);
	}

	private async executePinned(request: Request, key: string, body: ArrayBuffer, model: string): Promise<Response> {
		const account = this.accounts.get(key);
		const label = `account ${account.record.name}`;
		if (account.record.disabled) throw new HttpError(403, `${label} is disabled`);
		const family = this.familyOf(account);
		if (!family) {
			const vendors = this.spec.families.map(({ vendor }) => vendor);
			throw new HttpError(
				400,
				`${label} is not a ${vendors.join(" or ")} API-key account; the ${this.spec.api} accepts ${vendors.join(" and ")} API keys only`,
			);
		}
		const release = await this.acquire(account, request.signal);
		try {
			// OMP's own retries and recovery run to the end for a pinned account.
			const response = await this.send(request, account, family, body, model, false);
			if (!response.body) {
				release();
				return response;
			}
			return new Response(releaseOnEnd(response.body, release), response);
		} catch (error) {
			release();
			throw error;
		}
	}

	private async executePooled(request: Request, pool: string, body: ArrayBuffer, model: string): Promise<Response> {
		const family = this.spec.families.find((entry) => entry.pool === pool.toLowerCase());
		if (!family) {
			const pools = this.spec.families.map((entry) => `pool ${entry.pool}`).join(", ");
			throw new HttpError(
				400,
				`pool ${pool} cannot serve the ${this.spec.api}; use ${pools} or a pinned ${this.spec.families.map(({ vendor }) => vendor).join(" or ")} API-key account`,
			);
		}
		const candidates = this.poolCandidates(family, model);
		const now = Date.now();
		const available = candidates.filter((account) => account.cooldown <= now);
		if (!available.length) {
			const retryAfter = Math.ceil((Math.min(...candidates.map((account) => account.cooldown)) - now) / 1000);
			return keyRouteError(429, `pool ${family.pool}: all matching accounts are cooling down`, String(retryAfter));
		}
		const ordered = this.order(available);
		for (const account of ordered.slice(0, -1)) {
			const response = await this.send(request, account, family, body, model, family.failover);
			if (!this.fails(response, family)) return response;
			await response.body?.cancel();
		}
		return this.send(request, ordered[ordered.length - 1], family, body, model, false);
	}

	private poolCandidates(family: KeyFamily, model: string): Account[] {
		const candidates = [...this.accounts.accounts.values()].filter(
			(account) =>
				this.familyOf(account) === family &&
				!account.record.disabled &&
				account.judges.some((entry) => entry.id === model),
		);
		if (!candidates.length)
			throw new HttpError(503, `pool ${family.pool}: no enabled ${family.vendor} API-key account serves ${model}`);
		return candidates;
	}

	/** The account to try first, then the ones a failover tries in turn. */
	private order(available: Account[]): Account[] {
		if (this.accounts.routing.strategy === "fill-first") return available;
		const start = this.cursor++ % available.length;
		return [...available.slice(start), ...available.slice(0, start)];
	}

	private async send(
		request: Request,
		account: Account,
		family: KeyFamily,
		body: ArrayBuffer,
		model: string,
		failover: boolean,
	): Promise<Response> {
		const response = await this.spec.serve(request, account, body, model, failover);
		if (this.fails(response, family))
			recordFailure(account, response.status, response.headers.get("retry-after") ?? undefined);
		const headers = new Headers(response.headers);
		headers.set("x-credne-account", accountKey(account.record.id));
		return new Response(response.body, { status: response.status, headers });
	}

	private fails(response: Response, family: KeyFamily): boolean {
		return family.failover && isFailoverStatus(response.status);
	}

	private familyOf(account: Account): KeyFamily | undefined {
		if (account.record.kind !== "api-key") return undefined;
		return this.spec.families.find((family) => family.provider === account.record.provider);
	}
}

/** Formats broker-side failures in the OpenAI error envelope the System One route shares. */
export function keyRouteError(status: number, message: string, retryAfter?: string): Response {
	const type = status >= 500 ? "server_error" : status === 429 ? "rate_limit_error" : "invalid_request_error";
	const code =
		status === 429
			? "rate_limit_exceeded"
			: status === 401
				? "invalid_api_key"
				: status === 403
					? "permission_denied"
					: status === 404
						? "not_found"
						: status >= 500
							? "server_error"
							: "invalid_request";
	return Response.json(
		{ error: { message, type, code } },
		{
			status,
			headers: { "cache-control": "no-store", ...(retryAfter ? { "retry-after": retryAfter } : {}) },
		},
	);
}

function requestModel(body: ArrayBuffer): string {
	try {
		const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
		const model = text(object(json).model);
		if (model) return model;
	} catch {
		// OMP validates the rest of the body; the broker only needs the model to select an account.
	}
	throw new HttpError(400, "request body must be JSON with a model");
}

function releaseOnEnd(body: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let cancelling = false;
	const finish = () => {
		reader.releaseLock();
		release();
	};
	return new ReadableStream({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (cancelling) return;
				if (next.done) {
					controller.close();
					finish();
				} else controller.enqueue(next.value);
			} catch (error) {
				if (cancelling) return;
				controller.error(error);
				finish();
			}
		},
		async cancel(reason) {
			cancelling = true;
			try {
				await reader.cancel(reason);
			} finally {
				finish();
			}
		},
	});
}
