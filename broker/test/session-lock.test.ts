import { expect, test } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { Account } from "../src/accounts.ts";
import { SessionLocks } from "../src/session-lock.ts";
import { apiKey, subscription } from "./fixtures.ts";

test("a session stays on its OAuth account until the last of its concurrent requests ends", async () => {
	const storage = await AuthStorage.create(":memory:");
	try {
		const own = subscription("sk-ant-oat01-own");
		await storage.credentials.set("anthropic", [own, subscription("sk-ant-oat01-other")]);
		const [ownRow, otherRow] = storage.credentials.list();
		const account = { storage, provider: "anthropic" } as Account;
		const locks = new SessionLocks();
		const permits = (session: string, id: number) => storage.sessions.permits("anthropic", session, id);

		expect(permits("chat", ownRow.id) && permits("chat", otherRow.id)).toBe(true);
		const first = locks.hold(account, own, "chat");
		const second = locks.hold(account, own, "chat");
		expect(permits("chat", ownRow.id)).toBe(true);
		expect(permits("chat", otherRow.id)).toBe(false);
		// Other sessions are not affected.
		expect(permits("elsewhere", otherRow.id)).toBe(true);

		first();
		first();
		expect(permits("chat", otherRow.id)).toBe(false);
		second();
		expect(permits("chat", otherRow.id)).toBe(true);

		// A later request of the same session locks it again.
		const third = locks.hold(account, own, "chat");
		expect(permits("chat", otherRow.id)).toBe(false);
		third();
		expect(permits("chat", otherRow.id)).toBe(true);
	} finally {
		storage.close();
	}
});

test("an API key needs no lock: its key is the runtime override", async () => {
	const storage = await AuthStorage.create(":memory:");
	try {
		const key = apiKey("sk-ant-key");
		await storage.credentials.set("anthropic", key);
		const [row] = storage.credentials.list();
		const release = new SessionLocks().hold({ storage, provider: "anthropic" } as Account, key, "chat");
		expect(storage.sessions.permits("anthropic", "chat", row.id)).toBe(true);
		release();
	} finally {
		storage.close();
	}
});
