import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { object } from "../src/wire.ts";

const homes: string[] = [];
const pids = new Set<number>();
afterEach(async () => {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	pids.clear();
	for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
async function discovery(home: string, oldToken?: string) {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		try {
			const record = object(JSON.parse(await readFile(join(home, "broker.json"), "utf8")));
			if (
				typeof record.url === "string" &&
				typeof record.token === "string" &&
				typeof record.pid === "number" &&
				record.token !== oldToken
			) {
				const response = await fetch(`${record.url}/credne/v1/health`, {
					headers: { authorization: `Bearer ${record.token}` },
					signal: AbortSignal.timeout(1000),
				});
				await response.body?.cancel();
				if (response.ok) return { url: record.url, token: record.token, pid: record.pid };
			}
		} catch {}
		await Bun.sleep(50);
	}
	throw new Error("Daemon discovery did not become healthy.");
}

test("concurrent processes share one pid/token/port, attach, and recover a crashed lock", async () => {
	const home = await mkdtemp(join(tmpdir(), "credne-processes-"));
	homes.push(home);
	const children = Array.from({ length: 3 }, () =>
		Bun.spawn([process.execPath, cli, "--home", home, "--idle-timeout", "0"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		}),
	);
	for (const child of children) pids.add(child.pid);
	const initial = await discovery(home);
	expect(children.filter((child) => child.pid === initial.pid)).toHaveLength(1);
	for (const child of children.filter((child) => child.pid !== initial.pid)) {
		expect(await child.exited).toBe(0);
		pids.delete(child.pid);
	}
	const attach = Bun.spawn([process.execPath, cli, "--home", home, "--idle-timeout", "0"], {
		stdout: "ignore",
		stderr: "pipe",
	});
	expect(await attach.exited).toBe(0);
	expect(await discovery(home)).toEqual(initial);
	process.kill(initial.pid, "SIGKILL");
	await children.find((child) => child.pid === initial.pid)!.exited;
	pids.delete(initial.pid);
	const replacement = Bun.spawn([process.execPath, cli, "--home", home, "--idle-timeout", "0"], {
		stdout: "ignore",
		stderr: "pipe",
	});
	pids.add(replacement.pid);
	const recovered = await discovery(home, initial.token);
	expect(recovered.pid).toBe(replacement.pid);
	expect(recovered.token).not.toBe(initial.token);
	const shutdown = await fetch(`${recovered.url}/credne/v1/shutdown`, {
		method: "POST",
		headers: { authorization: `Bearer ${recovered.token}` },
	});
	await shutdown.body?.cancel();
	expect(await replacement.exited).toBe(0);
	pids.delete(replacement.pid);
	expect(await Bun.file(join(home, "broker.json")).exists()).toBe(false);
}, 40000);

test.skipIf(process.platform === "win32")(
	"shared daemon outlives the launcher process",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "credne-detached-"));
		homes.push(home);
		const script = `import {spawn} from 'node:child_process'; const child=spawn(${JSON.stringify(process.execPath)},${JSON.stringify([cli, "--home", home, "--idle-timeout", "0"])},{detached:true,stdio:'ignore'}); child.unref();`;
		const launcher = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" });
		expect(await launcher.exited).toBe(0);
		const record = await discovery(home);
		pids.add(record.pid);
		expect(record.pid).not.toBe(launcher.pid);
		const response = await fetch(`${record.url}/credne/v1/health`, {
			headers: { authorization: `Bearer ${record.token}` },
		});
		expect(response.ok).toBe(true);
		await response.body?.cancel();
		await fetch(`${record.url}/credne/v1/shutdown`, {
			method: "POST",
			headers: { authorization: `Bearer ${record.token}` },
		});
	},
	25000,
);
