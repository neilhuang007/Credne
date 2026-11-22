import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountKey } from "../src/accounts.ts";
import { type BrokerHandle, startBroker } from "../src/service.ts";
import { object } from "../src/wire.ts";

test("legacy migration preserves rollback files while OMP account changes survive restart", async () => {
	const home = await mkdtemp(join(tmpdir(), "credne-migration-"));
	const id = "openai-api-key-work";
	const key = accountKey(id);
	const model = "gpt-6-luna";
	const legacyKey = "sk-openai-migration-fixture";
	const subscription = "claude-legacy.json";
	const legacyPath = join(home, "api-accounts.json");
	const metadataPath = join(home, "omp-accounts.json");
	const subscriptionPath = join(home, "auths", subscription);
	const legacy = `${JSON.stringify(
		{
			version: 1,
			accounts: [
				{
					id,
					provider: "openai-api",
					name: "work",
					kind: "api-key",
					apiKey: legacyKey,
					disabled: true,
					models: [model],
					createdAt: "2026-01-01T00:00:00Z",
				},
			],
		},
		null,
		2,
	)}\n`;
	const auth = JSON.stringify({
		type: "claude",
		email: "legacy@example.com",
		access_token: "sk-ant-oat01-legacy",
		refresh_token: "legacy-refresh",
		expired: new Date(Date.now() + 3600000).toISOString(),
		disabled: true,
	});
	await mkdir(join(home, "auths"));
	await writeFile(legacyPath, legacy, { mode: 0o600 });
	await writeFile(subscriptionPath, auth, { mode: 0o600 });
	const upstreamRequests: { path: string; bearer: string | null }[] = [];
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			upstreamRequests.push({ path: new URL(request.url).pathname, bearer: request.headers.get("authorization") });
			await request.arrayBuffer();
			return Response.json({ model, answers: [{ type: "predicate", name: "easy", probability: 0.5 }] });
		},
	});
	let broker: BrokerHandle | undefined;
	const restart = async () => {
		await broker?.close();
		broker = await startBroker({ home, idleTimeout: 0, openaiBaseUrl: upstream.url.origin });
		if (!broker) throw new Error("No test broker");
	};
	const request = (path: string, method = "GET", body?: unknown) => {
		if (!broker) throw new Error("No test broker");
		return fetch(`${broker.state.url}/credne/v1${path}`, {
			method,
			headers: { authorization: `Bearer ${broker.state.token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	};
	const list = async () => object(await (await request("/accounts")).json()).accounts;
	const decide = () =>
		request(`/route/a.${key}/systemone`, "POST", {
			model,
			state: "Migration test",
			questions: { easy: { type: "noul", instructions: "Is it a test?" } },
		});
	try {
		await restart();
		expect(await list()).toMatchObject([
			{ id: subscription, provider: "claude", kind: "oauth", disabled: true },
			{ id, key, provider: "openai-api", kind: "api-key", label: "work", disabled: true },
		]);
		expect(object(await (await request(`/accounts/${key}/models`)).json()).models).toMatchObject([{ id: model }]);
		const disabled = await decide();
		expect(disabled.status).toBe(403);
		await disabled.body?.cancel();
		expect(upstreamRequests).toEqual([]);
		const migrated = await readFile(metadataPath, "utf8");
		expect(object(JSON.parse(migrated)).version).toBe(2);
		expect(migrated).not.toMatch(/sk-openai-migration-fixture|sk-ant-oat01-legacy|legacy-refresh/);
		expect(await readFile(legacyPath, "utf8")).toBe(legacy);

		const enabled = await request(`/accounts/${key}/enable`, "POST");
		expect(enabled.status).toBe(200);
		await enabled.body?.cancel();
		await restart();
		expect(await list()).toMatchObject([
			{ id: subscription, disabled: true },
			{ id, disabled: false },
		]);
		const response = await decide();
		expect(response.status).toBe(200);
		expect(object(await response.json()).answers).toEqual({ easy: { type: "noul", noul: 0.5 } });
		expect(upstreamRequests).toEqual([{ path: "/v1/decisions", bearer: `Bearer ${legacyKey}` }]);

		for (const deleted of [key, accountKey(subscription)]) {
			const response = await request(`/accounts/${deleted}`, "DELETE");
			expect(response.status).toBe(200);
			await response.body?.cancel();
		}
		await restart();
		expect(await list()).toEqual([]);
		expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual({ version: 2, accounts: [] });
		expect(await readFile(legacyPath, "utf8")).toBe(legacy);
		expect(await readFile(subscriptionPath, "utf8")).toBe(auth);
	} finally {
		await broker?.close();
		await upstream.stop(true);
		await rm(home, { recursive: true, force: true });
	}
}, 10000);
