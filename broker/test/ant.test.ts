import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { watch } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { type AntLogin, AntTool, extractAnt } from "../src/ant";

// Mock the HTTP callable without Bun's separate fetch.preconnect namespace.
const network: { fetch: FetchImpl } = globalThis;

// A real subprocess with isolated on-disk state. It never contacts a provider.
const FAKE_ANT = String.raw`
import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const profile = args[args.indexOf("--profile") + 1];
const dir = process.env.ANTHROPIC_CONFIG_DIR;
const secret = "provider-secret-do-not-expose";
if (args[0] !== "auth" || !profile || !dir) process.exit(90);
if (process.env.ANTHROPIC_API_KEY !== "" || process.env.ANTHROPIC_AUTH_TOKEN !== "") process.exit(91);
await mkdir(dir, { recursive: true });
await appendFile(join(dir, "commands"), JSON.stringify({ args, profile, dir }) + "\n");
const countPath = join(dir, "count-" + profile);
let count = 0;
try { count = Number(await readFile(countPath, "utf8")); } catch {}
if (args[1] === "print-credentials") {
  let lock;
  try { lock = await open(join(dir, "active-" + profile), "wx"); }
  catch { console.error(secret + " concurrent refresh"); process.exit(92); }
  await writeFile(countPath, String(++count));
  await writeFile(join(dir, "ready-" + profile), "ready");
  if (profile.startsWith("hold")) {
    const releasePath = join(dir, "release-" + profile);
    const released = Promise.withResolvers();
    const watcher = watch(dir, () => {
      void Bun.file(releasePath).exists().then(exists => { if (exists) released.resolve(); });
    });
    try {
      if (await Bun.file(releasePath).exists()) released.resolve();
      await released.promise;
    } finally { watcher.close(); }
  }
  if (profile === "failure") { console.error(secret); process.exit(1); }
  if (profile === "overflow") { process.stdout.write("x".repeat(2 * 1024 * 1024)); await Promise.withResolvers().promise; }
  if (profile === "invalid") { console.log(secret + " invalid JSON"); }
  else if (profile === "missing") { console.log(JSON.stringify({ account_email: secret })); }
  else if (profile === "bad-expiry") { console.log(JSON.stringify({ access_token: secret, expires_at: "tomorrow" })); }
  else {
    console.log(JSON.stringify({
      access_token: profile + "-token-" + count,
      ...(profile === "no-expiry" ? {} : { expires_at: Math.floor(Date.now() / 1000) + (profile === "near" ? 120 : 3600) }),
      account_email: profile + "@example.test", organization_name: "Console org",
      organization_uuid: "org-" + profile, workspace_name: "Workspace", extra_secret: secret
    }));
  }
  await lock.close();
  await rm(join(dir, "active-" + profile));
} else if (args[1] === "logout") {
  if (profile === "failure") { console.error(secret); process.exit(1); }
  await writeFile(join(dir, "logout-" + profile), "yes");
} else if (args[1] === "login") {
  if (!args.includes("--no-browser") || args[args.indexOf("--callback-port") + 1] !== "0") process.exit(93);
  if (profile === "failure") { console.error(secret); process.exit(1); }
  if (profile === "no-url") process.exit(0);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
      await writeFile(join(dir, "callback-" + profile), url.search);
      if (profile === "redirect") return Response.redirect("http://127.0.0.1:1/private");
      void server.stop().then(() => process.exit(0));
      return new Response("ok");
    }
  });
  if (profile === "hold-no-url") {
    await writeFile(join(dir, "ready-" + profile), "ready");
    await Promise.withResolvers().promise;
  }
  const redirect = "http://localhost:" + server.port + "/callback";
  const authorize = "https://console.example/oauth/authorize?redirect_uri=" + encodeURIComponent(redirect) + "&state=test-state";
  console.error("Provider output " + secret);
  console.error("  " + authorize);
  await Promise.withResolvers().promise;
} else process.exit(94);
`;

let home: string;
let fake: string;
let tool: AntTool;
let originalEnv: Record<string, string | undefined>;
const logins: AntLogin[] = [];

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "credne-ant-test-"));
	fake = join(home, "fake-ant");
	await writeFile(fake, `#!${process.execPath}\n${FAKE_ANT}`, { mode: 0o755 });
	await mkdir(join(home, "ant"));
	originalEnv = {
		CREDNE_ANT: process.env.CREDNE_ANT,
		ANTHROPIC_CONFIG_DIR: process.env.ANTHROPIC_CONFIG_DIR,
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
	};
	process.env.CREDNE_ANT = fake;
	process.env.ANTHROPIC_CONFIG_DIR = join(home, "unrelated-profile");
	process.env.ANTHROPIC_API_KEY = "inherited-api-secret";
	process.env.ANTHROPIC_AUTH_TOKEN = "inherited-auth-secret";
	tool = new AntTool(home);
});

afterEach(async () => {
	for (const login of logins.splice(0)) {
		login.cancel();
		await login.done.catch(() => {});
	}
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
});

async function count(profile: string): Promise<number> {
	return Number(await readFile(join(home, "ant", `count-${profile}`), "utf8"));
}

async function ready(profile: string): Promise<void> {
	const path = join(home, "ant", `ready-${profile}`);
	const found = Promise.withResolvers<void>();
	const watcher = watch(join(home, "ant"), () => {
		void Bun.file(path)
			.exists()
			.then((exists) => {
				if (exists) found.resolve();
			}, found.reject);
	});
	const deadline = AbortSignal.timeout(5_000);
	const onTimeout = () => found.reject(new Error("Fake ant did not become ready"));
	deadline.addEventListener("abort", onTimeout, { once: true });
	try {
		if (await Bun.file(path).exists()) found.resolve();
		await found.promise;
	} finally {
		watcher.close();
		deadline.removeEventListener("abort", onTimeout);
	}
}

// Executable shebang fixtures require POSIX. Installer rejection coverage below
// is platform-independent; production also handles the pinned Windows ZIPs.
describe.skipIf(process.platform === "win32")("ant subprocess profiles", () => {
	test("isolates environment and returns only snake_case credential fields", async () => {
		const credentials = await tool.credentials("alice");
		expect(credentials).toEqual({
			access_token: "alice-token-1",
			expires_at: expect.any(Number),
			account_email: "alice@example.test",
			organization_name: "Console org",
			organization_uuid: "org-alice",
			workspace_name: "Workspace",
		});
		const commands = (await readFile(join(home, "ant", "commands"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(commands[0]).toEqual({
			args: ["auth", "print-credentials", "--profile", "alice"],
			profile: "alice",
			dir: join(home, "ant"),
		});
		expect(await Bun.file(join(home, "unrelated-profile", "commands")).exists()).toBe(false);
	});

	test("serializes token refresh and credentials, updating the shared cache", async () => {
		const tokens = await Promise.all(Array.from({ length: 16 }, () => tool.token("alice")));
		expect(new Set(tokens)).toEqual(new Set(["alice-token-1"]));
		expect(await count("alice")).toBe(1);
		const refreshed = await tool.credentials("alice");
		expect(refreshed.access_token).toBe("alice-token-2");
		expect(await tool.token("alice")).toBe("alice-token-2");
		expect(await count("alice")).toBe(2);
		const credentials = await Promise.all(Array.from({ length: 4 }, () => tool.credentials("alice")));
		expect(credentials.map((value) => value.access_token)).toEqual([
			"alice-token-3",
			"alice-token-4",
			"alice-token-5",
			"alice-token-6",
		]);
	});

	test("refreshes three minutes early and gives absent expiry a ten-minute cache", async () => {
		expect(await tool.token("near")).toBe("near-token-1");
		expect(await tool.token("near")).toBe("near-token-2");
		expect(await tool.token("no-expiry")).toBe("no-expiry-token-1");
		expect(await tool.token("no-expiry")).toBe("no-expiry-token-1");
	});

	test("forget invalidates cached and in-flight tokens", async () => {
		expect(await tool.token("alice")).toBe("alice-token-1");
		tool.forget("alice");
		expect(await tool.token("alice")).toBe("alice-token-2");
		const first = tool.token("hold-forget");
		await ready("hold-forget");
		tool.forget("hold-forget");
		await writeFile(join(home, "ant", "release-hold-forget"), "go");
		expect(await first).toBe("hold-forget-token-1");
		expect(await tool.token("hold-forget")).toBe("hold-forget-token-2");
	});

	test("logout revokes the selected profile and evicts its cache", async () => {
		await tool.token("alice");
		await tool.logout("alice");
		expect(await readFile(join(home, "ant", "logout-alice"), "utf8")).toBe("yes");
		expect(await tool.token("alice")).toBe("alice-token-2");
	});

	test("different profiles are independent while same-profile work is queued", async () => {
		const first = tool.credentials("hold-queue");
		await ready("hold-queue");
		const second = tool.credentials("hold-queue");
		expect(await tool.token("bob")).toBe("bob-token-1");
		expect(await count("hold-queue")).toBe(1);
		await writeFile(join(home, "ant", "release-hold-queue"), "go");
		expect((await first).access_token).toBe("hold-queue-token-1");
		expect((await second).access_token).toBe("hold-queue-token-2");
	});

	test("aborting a queued request does not break the profile lock", async () => {
		const first = tool.credentials("hold-abort-queue");
		await ready("hold-abort-queue");
		const controller = new AbortController();
		const cancelled = tool.credentials("hold-abort-queue", controller.signal);
		controller.abort("secret abort reason");
		await expect(cancelled).rejects.toMatchObject({ name: "AbortError", message: "ant operation cancelled" });
		const third = tool.credentials("hold-abort-queue");
		expect(await count("hold-abort-queue")).toBe(1);
		await writeFile(join(home, "ant", "release-hold-abort-queue"), "go");
		await first;
		expect((await third).access_token).toBe("hold-abort-queue-token-2");
	});

	test("aborts an active child without exposing the abort reason", async () => {
		const controller = new AbortController();
		const result = tool.token("hold-cancel", controller.signal);
		await ready("hold-cancel");
		controller.abort("secret abort reason");
		await expect(result).rejects.toMatchObject({ name: "AbortError", message: "ant operation cancelled" });
		expect(await tool.token("bob")).toBe("bob-token-1");
	});

	test("bounds credentials process lifetime without waiting on wall-clock time", async () => {
		vi.useFakeTimers();
		try {
			const result = tool.credentials("hold-timeout");
			await ready("hold-timeout");
			vi.advanceTimersByTime(60_000);
			await expect(result).rejects.toThrow("ant operation timed out");
		} finally {
			vi.useRealTimers();
		}
	});

	test("bounds authorize URL discovery without wall-clock sleeps", async () => {
		vi.useFakeTimers();
		try {
			const result = tool.startLogin("hold-no-url");
			await ready("hold-no-url");
			vi.advanceTimersByTime(30_000);
			await expect(result).rejects.toThrow("ant did not print an authorize URL");
		} finally {
			vi.useRealTimers();
		}
	});

	test("bounds the lifetime of a login after returning its URL", async () => {
		vi.useFakeTimers();
		try {
			const login = await tool.startLogin("alice");
			logins.push(login);
			vi.advanceTimersByTime(15 * 60_000);
			await expect(login.done).rejects.toThrow("ant operation timed out");
		} finally {
			vi.useRealTimers();
		}
	});

	test("rejects already-aborted operations before starting ant", async () => {
		const signal = AbortSignal.abort("private reason");
		await expect(tool.token("alice", signal)).rejects.toMatchObject({ name: "AbortError" });
		await expect(tool.credentials("alice", signal)).rejects.toMatchObject({ name: "AbortError" });
		await expect(tool.logout("alice", signal)).rejects.toMatchObject({ name: "AbortError" });
		await expect(tool.startLogin("alice", signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(await Bun.file(join(home, "ant", "commands")).exists()).toBe(false);
	});

	test("redacts process errors, malformed output and credential contents", async () => {
		for (const profile of ["failure", "invalid", "missing", "bad-expiry", "overflow"]) {
			try {
				await tool.credentials(profile);
				throw new Error("Unexpected success");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).not.toContain("provider-secret");
				expect((error as Error).message).not.toBe("Unexpected success");
			}
		}
		await expect(tool.logout("failure")).rejects.toThrow("ant authentication failed");
		await expect(tool.startLogin("failure")).rejects.toThrow("ant authentication failed");
		await expect(tool.startLogin("no-url")).rejects.toThrow("ant did not print an authorize URL");
	});

	test("uses an existing home/bin executable without downloading", async () => {
		delete process.env.CREDNE_ANT;
		await mkdir(join(home, "bin"));
		await copyFile(fake, join(home, "bin", "ant"));
		await chmod(join(home, "bin", "ant"), 0o755);
		expect(await tool.token("alice")).toBe("alice-token-1");
	});

	test("completes browser login through exactly its advertised callback", async () => {
		const login = await tool.startLogin("alice");
		logins.push(login);
		const authorize = new URL(login.url);
		const callback = authorize.searchParams.get("redirect_uri")!;
		expect(authorize.protocol).toBe("https:");
		await login.callback(`${callback}?code=test-code&state=test-state`);
		await login.done;
		expect(await readFile(join(home, "ant", "callback-alice"), "utf8")).toBe("?code=test-code&state=test-state");
		await expect(login.callback(`${callback}?code=second`)).rejects.toThrow("already finished");
		expect((await tool.credentials("alice")).organization_uuid).toBe("org-alice");
	});

	test("rejects arbitrary callback hosts, ports, paths, credentials and fragments", async () => {
		const login = await tool.startLogin("alice");
		logins.push(login);
		const target = new URL(new URL(login.url).searchParams.get("redirect_uri")!);
		const bad = [
			"https://example.com/callback?code=secret",
			"http://127.0.0.1:1/callback",
			"file:///callback",
			"not a URL",
			`http://localhost:${target.port}/other`,
			`http://localhost:${target.port}/callback/extra`,
			`http://user:pass@localhost:${target.port}/callback`,
			`${target}#fragment`,
			`http://localhost:${Number(target.port) === 65535 ? 65534 : Number(target.port) + 1}/callback`,
		];
		for (const value of bad)
			await expect(login.callback(value)).rejects.toThrow("Expected the callback URL for this ant login");
		expect(await Bun.file(join(home, "ant", "callback-alice")).exists()).toBe(false);
		await login.callback(`${target}?code=valid`);
		await login.done;
	});

	test("does not follow redirects from the local callback", async () => {
		const login = await tool.startLogin("redirect");
		logins.push(login);
		const target = new URL(login.url).searchParams.get("redirect_uri")!;
		await expect(login.callback(`${target}?code=test`)).rejects.toThrow("Cannot deliver ant login callback");
	});

	test("cancelling login kills its child and releases the profile lock", async () => {
		const login = await tool.startLogin("alice");
		logins.push(login);
		login.cancel();
		await expect(login.done).rejects.toMatchObject({ name: "AbortError" });
		expect(await tool.token("alice")).toBe("alice-token-1");
	});

	test("an AbortSignal remains connected after the authorize URL is returned", async () => {
		const controller = new AbortController();
		const login = await tool.startLogin("alice", controller.signal);
		logins.push(login);
		controller.abort();
		await expect(login.done).rejects.toMatchObject({ name: "AbortError" });
	});
});

test("installer requests the pinned platform asset and rejects tampered archives", async () => {
	delete process.env.CREDNE_ANT;
	const requests: string[] = [];
	const download = spyOn(network, "fetch").mockImplementation(async (input) => {
		requests.push(String(input));
		return new Response("tampered archive");
	});
	try {
		await expect(tool.token("alice")).rejects.toThrow("ant release checksum mismatch");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatch(
			/^https:\/\/github\.com\/anthropics\/anthropic-cli\/releases\/download\/v2\.9\.0\/ant_2\.9\.0_(linux|macos|windows)_(386|amd64|arm64|armv6)\.(tar\.gz|zip)$/,
		);
		expect(await Bun.file(join(home, "bin", process.platform === "win32" ? "ant.exe" : "ant")).exists()).toBe(false);
		// A failed download must not poison installation for the next attempt.
		await expect(tool.token("alice")).rejects.toThrow("ant release checksum mismatch");
		expect(requests).toHaveLength(2);
	} finally {
		download.mockRestore();
	}
});

test("installer never exposes download transport errors", async () => {
	delete process.env.CREDNE_ANT;
	const download = spyOn(network, "fetch").mockRejectedValue(new Error("provider-secret download failure"));
	try {
		await expect(tool.token("alice")).rejects.toThrow("Cannot install pinned ant 2.9.0");
	} finally {
		download.mockRestore();
	}
});

function tarFixture(entries: { name: string; content: string; type?: string }[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const body = Buffer.from(entry.content);
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100);
		header.write("0000755\0", 100, 8, "ascii");
		header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
		header.fill(32, 148, 156);
		header.write(entry.type ?? "0", 156, 1, "ascii");
		header.write("ustar\0", 257, 6, "ascii");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function zipFixture(name: string, content: string, mode = 0o100755, deflate = false): Buffer {
	const filename = Buffer.from(name);
	const body = Buffer.from(content);
	let crc = 0xffffffff;
	for (const byte of body) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	crc = (crc ^ 0xffffffff) >>> 0;
	const compressed = deflate ? deflateRawSync(body) : body;
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(deflate ? 8 : 0, 8);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(compressed.length, 18);
	local.writeUInt32LE(body.length, 22);
	local.writeUInt16LE(filename.length, 26);
	const directory = Buffer.alloc(46);
	directory.writeUInt32LE(0x02014b50);
	directory.writeUInt16LE(0x0314, 4);
	directory.writeUInt16LE(20, 6);
	directory.writeUInt16LE(deflate ? 8 : 0, 10);
	directory.writeUInt32LE(crc, 16);
	directory.writeUInt32LE(compressed.length, 20);
	directory.writeUInt32LE(body.length, 24);
	directory.writeUInt16LE(filename.length, 28);
	directory.writeUInt32LE((mode << 16) >>> 0, 38);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(directory.length + filename.length, 12);
	end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
	return Buffer.concat([local, filename, compressed, directory, filename, end]);
}

test("extracts only a regular ant executable from a tar.gz release", () => {
	const archive = tarFixture([
		{ name: "README.md", content: "not executable" },
		{ name: "ant", content: "symlink-target", type: "2" },
		{ name: "release/ant", content: "tar-binary" },
	]);
	expect(extractAnt("ant_2.9.0_linux_amd64.tar.gz", archive).toString()).toBe("tar-binary");
	for (const name of ["../ant", "/ant", "release/../ant", "release\\ant"]) {
		expect(() => extractAnt("ant.tar.gz", tarFixture([{ name, content: "unsafe" }]))).toThrow(
			"ant executable missing",
		);
	}
	expect(() => extractAnt("ant.tar.gz", tarFixture([{ name: "ant", content: "link", type: "2" }]))).toThrow(
		"ant executable missing",
	);
});

test("extracts stored and deflated macOS and Windows ZIP executables", () => {
	for (const deflate of [false, true]) {
		expect(
			extractAnt("ant_2.9.0_macos_arm64.zip", zipFixture("release/ant", "zip-binary", 0o100755, deflate)).toString(),
		).toBe("zip-binary");
		expect(
			extractAnt("ant_2.9.0_windows_amd64.zip", zipFixture("ant.exe", "windows-binary", 0, deflate)).toString(),
		).toBe("windows-binary");
	}
	for (const name of ["../ant", "/ant", "release/../ant", "release\\ant"]) {
		expect(() => extractAnt("ant.zip", zipFixture(name, "unsafe"))).toThrow("ant executable missing");
	}
	expect(() => extractAnt("ant.zip", zipFixture("ant", "target", 0o120777))).toThrow("ant executable missing");
});

test("rejects truncated archives and ZIP content with an invalid CRC", () => {
	const zipped = zipFixture("ant", "zip-binary");
	zipped[33] = zipped[33]! ^ 1;
	expect(() => extractAnt("ant.zip", zipped)).toThrow("Invalid ant release archive");
	expect(() => extractAnt("ant.zip", Buffer.alloc(12))).toThrow("Invalid ant release archive");
	expect(() => extractAnt("ant.tar.gz", Buffer.from("not gzip"))).toThrow();
	expect(() => extractAnt("ant.rar", Buffer.alloc(0))).toThrow("Invalid ant release archive");
});

test("cancelling the last installer caller aborts its download and permits retry", async () => {
	delete process.env.CREDNE_ANT;
	const started = Promise.withResolvers<AbortSignal>();
	const download = spyOn(network, "fetch").mockImplementation(async (_input, options) => {
		const signal = options!.signal!;
		const response = Promise.withResolvers<Response>();
		signal.addEventListener("abort", () => response.reject(new Error("private transport error")), { once: true });
		started.resolve(signal);
		return response.promise;
	});
	try {
		const controller = new AbortController();
		const result = tool.token("alice", controller.signal);
		const signal = await started.promise;
		controller.abort("private cancellation reason");
		await expect(result).rejects.toMatchObject({ name: "AbortError", message: "ant operation cancelled" });
		expect(signal.aborted).toBe(true);
		download.mockImplementation(async () => new Response("tampered archive"));
		await expect(tool.token("alice")).rejects.toThrow("ant release checksum mismatch");
	} finally {
		download.mockRestore();
	}
});

test("bounds installer download lifetime with deterministic timers", async () => {
	delete process.env.CREDNE_ANT;
	const started = Promise.withResolvers<void>();
	const download = spyOn(network, "fetch").mockImplementation(async (_input, options) => {
		const response = Promise.withResolvers<Response>();
		options!.signal!.addEventListener("abort", () => response.reject(new Error("private timeout details")), {
			once: true,
		});
		started.resolve();
		return response.promise;
	});
	vi.useFakeTimers();
	try {
		const result = tool.token("alice");
		await started.promise;
		vi.advanceTimersByTime(5 * 60_000);
		await expect(result).rejects.toThrow("Cannot install pinned ant 2.9.0");
	} finally {
		vi.useRealTimers();
		download.mockRestore();
	}
});
