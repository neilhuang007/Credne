// One-time move of Claude subscriptions from the broker's credential files to the local store.
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { LocalClaudeStore } from "./claude-store.ts";
import type { BrokerClient } from "./client.ts";

/** The broker keeps Claude OAuth tokens in `<home>/auths/claude-*.json`. */
const authsDirName = "auths";
const claudeFilePattern = /^claude-.*\.json$/;

/**
 * Move every Claude subscription the broker holds to the local store, so only one side ever refreshes a
 * rotating refresh token. A credential is first written locally. Only after that succeeds is the broker's copy
 * removed: through the broker's API when one is running, otherwise by deleting the file, since a broker that
 * is not running holds no copy in memory. Accounts the local store already has are not overwritten, so the
 * import can run at every startup and retry a removal that failed. Returns the number of accounts handled.
 */
export async function importBrokerClaudeAccounts(store: LocalClaudeStore, client: BrokerClient): Promise<number> {
	const authsDir = join(store.home, authsDirName);
	const files = claudeAuthFiles(authsDir);
	if (files.length === 0) return 0;
	// An incompatible live daemon may still refresh these tokens; never treat it as stopped.
	const broker = await client.connectExisting();
	let handled = 0;
	for (const file of files) {
		const credential = readBrokerClaudeCredential(join(authsDir, file));
		if (!credential) continue;
		await store.adopt(credential);
		if (await removeBrokerCopy(client, authsDir, file, broker !== undefined)) handled++;
	}
	return handled;
}

/** Convert a broker auth file; undefined when it is not a Claude OAuth file or lacks its tokens. */
export function readBrokerClaudeCredential(path: string): OAuthCredential | undefined {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof data !== "object" || data === null) return undefined;
	const file = data as Record<string, unknown>;
	const access = text(file.access_token);
	const refresh = text(file.refresh_token);
	if (file.type !== "claude" || !access || !refresh) return undefined;
	// An unreadable expiry counts as expired, which makes the next request refresh the token.
	const expires = Date.parse(text(file.expired) ?? "");
	const deviceIds = Array.isArray(file.claude_device_ids) ? file.claude_device_ids : [];
	return withDefined(
		{ type: "oauth", access, refresh, expires: Number.isFinite(expires) ? expires : 0 },
		{
			accountId: text(file.account_uuid),
			orgId: text(file.organization_uuid),
			orgName: text(file.organization_name),
			email: text(file.email),
			deviceId: text(deviceIds[0]),
			plan: text(file.plan_type),
			disabled: file.disabled === true ? true : undefined,
		},
	);
}

function claudeAuthFiles(authsDir: string): string[] {
	try {
		return readdirSync(authsDir)
			.filter((name) => claudeFilePattern.test(name))
			.sort();
	} catch {
		return [];
	}
}

/** Whether the broker's copy is gone. A failed removal leaves it for the next startup's retry. */
async function removeBrokerCopy(
	client: BrokerClient,
	authsDir: string,
	file: string,
	brokerRunning: boolean,
): Promise<boolean> {
	try {
		if (brokerRunning) await client.removeAccount(Buffer.from(file).toString("base64url"));
		else rmSync(join(authsDir, file), { force: true });
		return true;
	} catch {
		return false;
	}
}

/** Credential fields only when they have a value, because the store persists the object as given. */
function withDefined(credential: OAuthCredential, fields: Record<string, string | true | undefined>): OAuthCredential {
	for (const [name, value] of Object.entries(fields)) {
		if (value !== undefined) credential[name] = value;
	}
	return credential;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}
