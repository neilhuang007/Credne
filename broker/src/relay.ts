// Holds an SSE response back until its attempt is decided, then relays it to the caller.
type StreamRead = { done: false; value: Uint8Array } | { done: true; value?: Uint8Array };
type Reader = ReadableStreamDefaultReader<Uint8Array>;

/** What was read from a stream before its attempt was decided. */
export interface Held {
	chunks: Uint8Array[];
	/** A read that was already in flight when the attempt was decided; its result is the next chunk. */
	pending?: Promise<StreamRead>;
	ended: boolean;
}

/**
 * Reads frames until `decided` settles or the stream ends. OMP emits its first frames before it has sent the provider
 * request, so a caller must not see any until the provider's answer shows whether the pool keeps this attempt.
 */
export async function holdUntil(reader: Reader, decided: Promise<void>): Promise<Held> {
	const chunks: Uint8Array[] = [];
	let pending: Promise<StreamRead> | undefined;
	for (;;) {
		pending ??= reader.read();
		const next = await Promise.race([decided.then(() => undefined), pending]);
		if (next === undefined) return { chunks, pending, ended: false };
		pending = undefined;
		if (next.done) return { chunks, ended: true };
		chunks.push(next.value);
	}
}

/**
 * Replays the held frames (none, for a stream relayed from its first frame), then the rest of the stream. `done` runs
 * when the stream ends, fails or is cancelled.
 */
export function relay(reader: Reader, held: Held, done: () => void): ReadableStream<Uint8Array> {
	let { pending, ended } = held;
	const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => {
		ended = true;
		controller.close();
		reader.releaseLock();
		done();
	};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of held.chunks) controller.enqueue(chunk);
			if (ended) finish(controller);
		},
		async pull(controller) {
			if (ended) return;
			try {
				const next = await (pending ?? reader.read());
				pending = undefined;
				if (next.done) finish(controller);
				else controller.enqueue(next.value);
			} catch (error) {
				ended = true;
				done();
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
				done();
			}
		},
	});
}
