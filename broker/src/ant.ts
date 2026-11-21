import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

const VERSION = "2.9.0";
// From ant_2.9.0_checksums.txt, not fetched alongside the executable.
const CHECKSUMS: Readonly<Record<string, string>> = {
	"ant_2.9.0_linux_386.tar.gz": "7569d39f60c439fad899ea00bc69ddbda2de2c04f7080421606a9476538ed927",
	"ant_2.9.0_linux_amd64.tar.gz": "69158f6a17e92e8e559e0061bea2530ac5b60976fb6d697673136d110ebe351f",
	"ant_2.9.0_linux_arm64.tar.gz": "2bbccb2861c647cbad708d83921dfc3e0689233fc0f50be4745df3e973166cc9",
	"ant_2.9.0_linux_armv6.tar.gz": "f52b7fc3e1be516c25c544488e51af69b97fffb749f2db3e7152479f14f43682",
	"ant_2.9.0_macos_amd64.zip": "45039f3cffc029cdcbacd3ec073f355df035fdb6988c4b0d9bcac0aad602ba35",
	"ant_2.9.0_macos_arm64.zip": "316aedd862136b53545997ec4f30add182783873e86c6479dcde6e34bc2702a3",
	"ant_2.9.0_windows_386.zip": "ab323257e0287e874458b5ccd5aef0c4a9d92fcd02c687559503589d94211f49",
	"ant_2.9.0_windows_amd64.zip": "6ff884fd3b1aa60558cd6536271548c27c7617b857cef93adc6dc113097f3b0c",
	"ant_2.9.0_windows_arm64.zip": "12ea50f67c888a7afbcb98ffe61405a7ba2ab0c6f81ad27c82e2694d6265843d",
};
const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_BINARY = 256 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const TOKEN_SKEW = 3 * 60_000;

export interface AntCredentials {
	access_token: string;
	expires_at: number | null;
	account_email: string;
	organization_name: string;
	organization_uuid: string;
	workspace_name: string;
}

export interface AntLogin {
	url: string;
	done: Promise<void>;
	cancel(): void;
	callback(redirectUrl: string): Promise<void>;
}

function aborted(): DOMException {
	return new DOMException("ant operation cancelled", "AbortError");
}

function checkSignal(signal?: AbortSignal): void {
	if (signal?.aborted) throw aborted();
}

async function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	checkSignal(signal);
	if (!signal) return promise;
	const { promise: cancellation, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(aborted());
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, cancellation]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return Buffer.concat(chunks, size);
			size += chunk.value.byteLength;
			if (size > limit) throw new Error("ant download exceeds size limit");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function assetName(): string {
	const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
	const arch =
		process.arch === "x64"
			? "amd64"
			: process.arch === "ia32"
				? "386"
				: process.arch === "arm"
					? "armv6"
					: process.arch;
	const asset = `ant_${VERSION}_${os}_${arch}${os === "linux" ? ".tar.gz" : ".zip"}`;
	if (!CHECKSUMS[asset]) throw new Error("No pinned ant release for this platform");
	return asset;
}

function archiveError(): Error {
	return new Error("Invalid ant release archive");
}

function archiveName(name: string, want: string): boolean {
	// Nothing from the archive is written to its own pathname, including links.
	return !name.includes("\\") && !name.split("/").includes("..") && !name.startsWith("/") && basename(name) === want;
}

function tarNumber(bytes: Buffer): number {
	const value = bytes.toString("ascii").replace(/\0.*$/s, "").trim();
	if (!/^[0-7]+$/.test(value)) throw archiveError();
	const number = Number.parseInt(value, 8);
	if (!Number.isSafeInteger(number)) throw archiveError();
	return number;
}

function extractTar(archive: Buffer, want: string): Buffer {
	const tar = gunzipSync(archive, { maxOutputLength: MAX_BINARY });
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const checksum = tarNumber(header.subarray(148, 156));
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
		if (sum !== checksum) throw archiveError();
		const size = tarNumber(header.subarray(124, 136));
		const start = offset + 512;
		if (size > MAX_BINARY || start + size > tar.length) throw archiveError();
		const name = header.subarray(0, 100).toString("utf8").split("\0", 1)[0]!;
		const prefix = header.subarray(345, 500).toString("utf8").split("\0", 1)[0]!;
		if ((header[156] === 0 || header[156] === 48) && archiveName(prefix ? `${prefix}/${name}` : name, want)) {
			if (size === 0) throw archiveError();
			return tar.subarray(start, start + size);
		}
		offset = start + Math.ceil(size / 512) * 512;
	}
	throw new Error("ant executable missing from release archive");
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index++) {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
	CRC_TABLE[index] = value;
}

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
	return (crc ^ 0xffffffff) >>> 0;
}

function extractZip(zip: Buffer, want: string): Buffer {
	// Read only the central directory's regular executable entry; never extract paths.
	let end = zip.length - 22;
	for (; end >= Math.max(0, zip.length - 65_557); end--) {
		if (zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length) break;
	}
	if (end < 0 || end < zip.length - 65_557 || zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0)
		throw archiveError();
	const entries = zip.readUInt16LE(end + 10);
	const directorySize = zip.readUInt32LE(end + 12);
	let offset = zip.readUInt32LE(end + 16);
	if (entries === 0xffff || zip.readUInt16LE(end + 8) !== entries || offset + directorySize !== end)
		throw archiveError();
	for (let index = 0; index < entries; index++) {
		if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50) throw archiveError();
		const flags = zip.readUInt16LE(offset + 8);
		const method = zip.readUInt16LE(offset + 10);
		const checksum = zip.readUInt32LE(offset + 16);
		const compressedSize = zip.readUInt32LE(offset + 20);
		const size = zip.readUInt32LE(offset + 24);
		const nameSize = zip.readUInt16LE(offset + 28);
		const next = offset + 46 + nameSize + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
		if (next > end) throw archiveError();
		const name = zip.subarray(offset + 46, offset + 46 + nameSize).toString("utf8");
		const mode = zip.readUInt32LE(offset + 38) >>> 16;
		if (archiveName(name, want) && !name.endsWith("/") && ((mode & 0xf000) === 0 || (mode & 0xf000) === 0x8000)) {
			if ((flags & 1) !== 0 || (method !== 0 && method !== 8) || size === 0 || size > MAX_BINARY)
				throw archiveError();
			const local = zip.readUInt32LE(offset + 42);
			if (
				local + 30 > offset ||
				zip.readUInt32LE(local) !== 0x04034b50 ||
				zip.readUInt16LE(local + 8) !== method ||
				zip.readUInt16LE(local + 6) !== flags
			)
				throw archiveError();
			const localNameSize = zip.readUInt16LE(local + 26);
			const start = local + 30 + localNameSize + zip.readUInt16LE(local + 28);
			if (
				start + compressedSize > offset ||
				!zip
					.subarray(local + 30, local + 30 + localNameSize)
					.equals(zip.subarray(offset + 46, offset + 46 + nameSize))
			)
				throw archiveError();
			const compressed = zip.subarray(start, start + compressedSize);
			const binary = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_BINARY });
			if (binary.length !== size || crc32(binary) !== checksum) throw archiveError();
			return binary;
		}
		offset = next;
	}
	throw new Error("ant executable missing from release archive");
}

/** Read only the executable from an already checksum-verified release archive. */
export function extractAnt(asset: string, archive: Buffer): Buffer {
	if (asset.endsWith(".tar.gz")) return extractTar(archive, "ant");
	if (asset.endsWith(".zip")) return extractZip(archive, asset.includes("_windows_") ? "ant.exe" : "ant");
	throw archiveError();
}

interface RunningCommand {
	done: Promise<string>;
	stop(error?: Error): void;
}

/** The official ant CLI owns Console profiles and rotating refresh tokens. */
export class AntTool {
	private readonly tokens = new Map<string, { value: string; expires: number }>();
	private readonly generations = new Map<string, number>();
	private readonly locks = new Map<string, Promise<void>>();
	private installation?: { promise: Promise<string>; controller: AbortController; users: number };

	constructor(private readonly home: string) {}

	private async acquire(profile: string, signal?: AbortSignal): Promise<() => void> {
		checkSignal(signal);
		const previous = this.locks.get(profile) ?? Promise.resolve();
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const tail = previous.then(() => gate);
		this.locks.set(profile, tail);
		void tail.then(() => {
			if (this.locks.get(profile) === tail) this.locks.delete(profile);
		});
		try {
			await cancellable(previous, signal);
			checkSignal(signal);
			return release;
		} catch (error) {
			release();
			throw error;
		}
	}

	private async executable(signal?: AbortSignal): Promise<string> {
		checkSignal(signal);
		if (process.env.CREDNE_ANT) return process.env.CREDNE_ANT;
		// A cancelled caller does not cancel installation needed by another profile.
		if (!this.installation) {
			const controller = new AbortController();
			const installing = { promise: this.install(controller.signal), controller, users: 0 };
			this.installation = installing;
			void installing.promise.catch(() => {
				if (this.installation === installing) this.installation = undefined;
			});
		}
		const installation = this.installation;
		installation.users++;
		try {
			return await cancellable(installation.promise, signal);
		} finally {
			installation.users--;
			if (installation.users === 0 && signal?.aborted && this.installation === installation) {
				this.installation = undefined;
				installation.controller.abort();
			}
		}
	}

	private async install(signal: AbortSignal): Promise<string> {
		const target = join(this.home, "bin", process.platform === "win32" ? "ant.exe" : "ant");
		try {
			const existing = await stat(target);
			if (existing.isFile()) return target;
			throw new Error("Invalid installed ant executable");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error("Cannot access installed ant executable");
		}
		const asset = assetName();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5 * 60_000);
		const downloadSignal = AbortSignal.any([signal, controller.signal]);
		let temporary: string | undefined;
		try {
			const response = await fetch(
				`https://github.com/anthropics/anthropic-cli/releases/download/v${VERSION}/${asset}`,
				{ signal: downloadSignal },
			);
			if (response.status !== 200 || !response.body) {
				await response.body?.cancel();
				throw new Error("Cannot download pinned ant release");
			}
			const archive = await readBounded(response.body, MAX_ARCHIVE);
			if (createHash("sha256").update(archive).digest("hex") !== CHECKSUMS[asset])
				throw new Error("ant release checksum mismatch");
			const binary = extractAnt(asset, archive);
			checkSignal(downloadSignal);
			await mkdir(dirname(target), { recursive: true, mode: 0o700 });
			temporary = `${target}.${randomUUID()}.tmp`;
			const file = await open(temporary, "wx", 0o755);
			try {
				await file.writeFile(binary);
			} finally {
				await file.close();
			}
			checkSignal(downloadSignal);
			await rename(temporary, target);
			return target;
		} catch (error) {
			if (error instanceof Error && error.message === "ant release checksum mismatch") throw error;
			throw new Error(`Cannot install pinned ant ${VERSION}`);
		} finally {
			clearTimeout(timer);
			if (temporary) await rm(temporary, { force: true }).catch(() => {});
		}
	}

	private async command(
		args: string[],
		signal?: AbortSignal,
		timeout = 60_000,
		onStderr?: (text: string) => void,
	): Promise<RunningCommand> {
		const executable = await this.executable(signal);
		checkSignal(signal);
		await mkdir(join(this.home, "ant"), { recursive: true, mode: 0o700 }).catch(() => {
			throw new Error("Cannot create ant profile directory");
		});
		checkSignal(signal);
		let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			child = Bun.spawn([executable, ...args], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					ANTHROPIC_CONFIG_DIR: join(this.home, "ant"),
					ANTHROPIC_API_KEY: "",
					ANTHROPIC_AUTH_TOKEN: "",
				},
			});
		} catch {
			throw new Error("Cannot start ant");
		}
		let failure: Error | undefined;
		const stop = (error: Error = aborted()) => {
			failure ??= error;
			try {
				child.kill("SIGKILL");
			} catch {
				/* Already reaped. */
			}
		};
		const onAbort = () => stop();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) stop();
		const timer = setTimeout(() => stop(new Error("ant operation timed out")), timeout);
		let bytes = 0;
		const consume = async (stream: ReadableStream<Uint8Array>, collect: boolean): Promise<string> => {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let output = "";
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					bytes += chunk.value.byteLength;
					if (bytes > MAX_OUTPUT) {
						stop(new Error("ant output exceeds size limit"));
						break;
					}
					const text = decoder.decode(chunk.value, { stream: true });
					if (collect) output += text;
					else onStderr?.(text);
				}
				const last = decoder.decode();
				if (collect) output += last;
				else onStderr?.(`${last}\n`);
				return output;
			} catch {
				stop(new Error("Cannot read ant output"));
				return "";
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		};
		const done = (async () => {
			try {
				const [code, output] = await Promise.all([
					child.exited,
					consume(child.stdout, true),
					consume(child.stderr, false),
				]);
				if (failure) throw failure;
				if (code !== 0) throw new Error("ant authentication failed; sign in again");
				return output;
			} catch (error) {
				stop();
				if (failure && error === failure) throw error;
				throw new Error("ant authentication failed; sign in again");
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		})();
		void done.catch(() => {});
		return { done, stop };
	}

	private async readCredentials(profile: string, signal?: AbortSignal): Promise<AntCredentials> {
		const generation = this.generations.get(profile);
		const command = await this.command(["auth", "print-credentials", "--profile", profile], signal);
		const output = await command.done;
		let value: unknown;
		try {
			value = JSON.parse(output);
		} catch {
			throw new Error("ant returned no access token; sign in again");
		}
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("ant returned no access token; sign in again");
		const raw = value as Record<string, unknown>;
		if (
			typeof raw.access_token !== "string" ||
			!raw.access_token.trim() ||
			(raw.expires_at != null && (typeof raw.expires_at !== "number" || !Number.isSafeInteger(raw.expires_at)))
		)
			throw new Error("ant returned invalid credentials; sign in again");
		const text = (key: string): string => (typeof raw[key] === "string" ? raw[key] : "");
		const credentials: AntCredentials = {
			access_token: raw.access_token,
			expires_at: typeof raw.expires_at === "number" ? raw.expires_at : null,
			account_email: text("account_email"),
			organization_name: text("organization_name"),
			organization_uuid: text("organization_uuid"),
			workspace_name: text("workspace_name"),
		};
		if (generation === this.generations.get(profile))
			this.tokens.set(profile, {
				value: credentials.access_token,
				expires: credentials.expires_at == null ? Date.now() + 10 * 60_000 : credentials.expires_at * 1000,
			});
		return credentials;
	}

	async token(profile: string, signal?: AbortSignal): Promise<string> {
		const release = await this.acquire(profile, signal);
		try {
			const cached = this.tokens.get(profile);
			if (cached && cached.expires - Date.now() > TOKEN_SKEW) return cached.value;
			return (await this.readCredentials(profile, signal)).access_token;
		} finally {
			release();
		}
	}

	async credentials(profile: string, signal?: AbortSignal): Promise<AntCredentials> {
		const release = await this.acquire(profile, signal);
		try {
			return await this.readCredentials(profile, signal);
		} finally {
			release();
		}
	}

	forget(profile: string): void {
		this.tokens.delete(profile);
		this.generations.set(profile, (this.generations.get(profile) ?? 0) + 1);
	}

	async logout(profile: string, signal?: AbortSignal): Promise<void> {
		this.forget(profile);
		const release = await this.acquire(profile, signal);
		try {
			this.forget(profile);
			const command = await this.command(["auth", "logout", "--profile", profile], signal);
			await command.done;
		} finally {
			this.forget(profile);
			release();
		}
	}

	async startLogin(profile: string, signal?: AbortSignal): Promise<AntLogin> {
		const release = await this.acquire(profile, signal);
		this.forget(profile);
		let command: RunningCommand;
		const { promise: foundUrl, resolve: resolveUrl } = Promise.withResolvers<string>();
		let pending = "";
		const line = (text: string) => {
			const candidate = text.trim();
			if (!candidate.startsWith("https://")) return;
			try {
				const url = new URL(candidate);
				if (
					url.protocol === "https:" &&
					!url.username &&
					!url.password &&
					url.searchParams.getAll("redirect_uri").length === 1
				) {
					callbackTarget(url.searchParams.get("redirect_uri")!);
					resolveUrl(candidate);
				}
			} catch {
				/* Ignore non-authorize output, without exposing it. */
			}
		};
		try {
			command = await this.command(
				["auth", "login", "--profile", profile, "--no-browser", "--callback-port", "0", "--timeout", "10m"],
				signal,
				15 * 60_000,
				(text) => {
					pending += text;
					for (;;) {
						const newline = pending.indexOf("\n");
						if (newline < 0) break;
						line(pending.slice(0, newline));
						pending = pending.slice(newline + 1);
					}
				},
			);
		} catch (error) {
			release();
			throw error;
		}
		let finished = false;
		const done = command.done
			.finally(() => {
				this.forget(profile);
				finished = true;
				release();
			})
			.then(() => {});
		void done.catch(() => {});
		const urlDeadline = Promise.withResolvers<never>();
		const timer = setTimeout(() => urlDeadline.reject(new Error("ant did not print an authorize URL")), 30_000);
		try {
			const url = await Promise.race([
				foundUrl,
				done.then(() => {
					throw new Error("ant did not print an authorize URL");
				}),
				urlDeadline.promise,
			]);
			if (finished) {
				await done;
				throw new Error("ant login already finished");
			}
			const target = callbackTarget(new URL(url).searchParams.get("redirect_uri")!);
			const callbackCancellation = new AbortController();
			return {
				url,
				done,
				cancel: () => {
					if (!finished) {
						callbackCancellation.abort();
						command.stop();
					}
				},
				callback: async (redirectUrl) => {
					if (finished) throw new Error("ant login already finished");
					let redirect: URL;
					try {
						redirect = new URL(redirectUrl);
						if (
							redirect.origin !== target.origin ||
							redirect.pathname !== target.pathname ||
							redirect.username ||
							redirect.password ||
							redirect.hash
						)
							throw new Error();
						for (const [key, value] of target.searchParams)
							if (redirect.searchParams.getAll(key).length !== 1 || redirect.searchParams.get(key) !== value)
								throw new Error();
					} catch {
						throw new Error("Expected the callback URL for this ant login");
					}
					// Never resolve an arbitrary hostname or follow a callback redirect.
					if (redirect.hostname === "localhost") redirect.hostname = "127.0.0.1";
					try {
						const signals = [callbackCancellation.signal, AbortSignal.timeout(10_000)];
						if (signal) signals.push(signal);
						const response = await fetch(redirect, { redirect: "manual", signal: AbortSignal.any(signals) });
						await response.body?.cancel();
						if (!response.ok) throw new Error();
					} catch {
						throw new Error("Cannot deliver ant login callback");
					}
				},
			};
		} catch (error) {
			command.stop();
			await done.catch(() => {});
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
}

function callbackTarget(value: string): URL {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		!url.port ||
		Number(url.port) < 1 ||
		url.username ||
		url.password ||
		url.hash ||
		url.pathname !== "/callback"
	)
		throw new Error("Invalid ant callback target");
	return url;
}
