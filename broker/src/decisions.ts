// Proxies OpenAI's Decisions API without translating the body or sharing inference retry state.
import { type Account, type Accounts, accountKey, HttpError } from "./accounts.ts";
import { object, text } from "./wire.ts";

export class Decisions {
	private cursor = 0;

	constructor(
		private readonly accounts: Accounts,
		private readonly acquire: (account: Account, signal: AbortSignal) => Promise<() => void>,
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
		let account: Account;
		if (pin) {
			account = this.accounts.get(name);
			const label = `account ${account.record.name}`;
			if (account.record.disabled) throw new HttpError(403, `${label} is disabled`);
			if (!openAIKey(account))
				throw new HttpError(
					400,
					`${label} is not an OpenAI API-key account; the Decisions API accepts OpenAI API keys only`,
				);
		} else {
			if (name.toLowerCase() !== "openai")
				throw new HttpError(
					400,
					`pool ${name} cannot serve the Decisions API; use pool openai or a pinned OpenAI API-key account`,
				);
			const candidates = [...this.accounts.accounts.values()].filter(
				(account) =>
					openAIKey(account) && !account.record.disabled && account.models.some((entry) => entry.id === model),
			);
			if (!candidates.length)
				throw new HttpError(503, `pool openai: no enabled OpenAI API-key account serves ${model}`);
			const now = Date.now();
			const available = candidates.filter((account) => account.cooldown <= now);
			if (!available.length) {
				const retryAfter = Math.ceil((Math.min(...candidates.map((account) => account.cooldown)) - now) / 1000);
				return decisionsError(429, "pool openai: all matching accounts are cooling down", String(retryAfter));
			}
			account = available[this.accounts.routing.strategy === "fill-first" ? 0 : this.cursor++ % available.length];
		}
		const release = pin ? await this.acquire(account, request.signal) : undefined;
		try {
			const response = await forward(request, account, body, this.accounts.options.openaiBaseUrl);
			if (!release) return response;
			if (response.body) return new Response(releaseOnEnd(response.body, release), response);
			release();
			return response;
		} catch (error) {
			release?.();
			throw error;
		}
	}
}

/** Formats broker-side failures in the Decisions API's OpenAI error envelope. */
export function decisionsError(status: number, message: string, retryAfter?: string): Response {
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
		// The original bytes are forwarded only for JSON that names a model.
	}
	throw new HttpError(400, "request body must be JSON with a model");
}

function openAIKey(account: Account): boolean {
	return account.record.kind === "api-key" && account.record.provider === "openai-api";
}

async function forward(request: Request, account: Account, body: ArrayBuffer, defaultBase: string): Promise<Response> {
	// Read the managed key directly: no OAuth path, gateway credential cascading, or environment fallback.
	const credential = account.storage.credentials.get(account.provider);
	if (credential?.type !== "api_key") throw new HttpError(401, "Account credential is unavailable.");
	const base = (account.record.baseUrl ?? defaultBase).replace(/\/+$/, "");
	const url = `${base}${base.endsWith("/v1") ? "" : "/v1"}/decisions`;
	const headers = new Headers({ authorization: `Bearer ${credential.key}`, "content-type": "application/json" });
	copyHeaders(request.headers, headers, ["accept", "openai-beta", "x-client-request-id"]);
	for (const [name, value] of Object.entries(account.record.headers ?? {})) headers.set(name, value);
	let upstream: Response;
	try {
		upstream = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: request.signal });
	} catch {
		request.signal.throwIfAborted();
		throw new HttpError(502, `account ${account.record.name}: provider request failed`);
	}
	const responseHeaders = new Headers({ "x-credne-account": accountKey(account.record.id) });
	copyHeaders(upstream.headers, responseHeaders, ["content-type", "retry-after", "x-request-id"]);
	return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

function copyHeaders(source: Headers, destination: Headers, names: readonly string[]): void {
	for (const name of names) {
		const value = source.get(name);
		if (value !== null) destination.set(name, value);
	}
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
