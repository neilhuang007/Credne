import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker } from "../src/service.ts";
import { object } from "../src/wire.ts";

test.skipIf(process.platform === "win32")(
	"Console login reserves names, rejects duplicate organizations, routes bearer credits and logs out only new profiles",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "credne-credits-"));
		const fake = join(home, "ant-fixture");
		await writeFile(
			fake,
			`#!${process.execPath}\nimport {writeFile,mkdir} from 'node:fs/promises';import {join} from 'node:path';const args=process.argv.slice(2),profile=args[args.indexOf('--profile')+1],dir=process.env.ANTHROPIC_CONFIG_DIR;if(args[1]==='print-credentials'){console.log(JSON.stringify({access_token:'sk-ant-oat-console-private',expires_at:Math.floor(Date.now()/1000)+3600,organization_uuid:'same-organization',organization_name:'Example org',account_email:'console@example.com'}));}else if(args[1]==='logout'){await mkdir(dir,{recursive:true});await writeFile(join(dir,profile+'.logout'),'logged out');}else if(args[1]==='login'){const done=Promise.withResolvers();const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){setTimeout(()=>done.resolve(),20);return new Response('ok');}});const redirect='http://127.0.0.1:'+server.port+'/callback';console.error('https://console.example/authorize?redirect_uri='+encodeURIComponent(redirect)+'&state='+profile);await done.promise;await server.stop(true);}\n`,
			{ mode: 0o700 },
		);
		await chmod(fake, 0o700);
		const prior = process.env.CREDNE_ANT;
		process.env.CREDNE_ANT = fake;
		const received: { bearer: string | null; wire: Record<string, unknown> } = { bearer: null, wire: {} };
		let inferenceCalls = 0;
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				received.bearer = request.headers.get("authorization");
				if (new URL(request.url).pathname === "/v1/models")
					return Response.json({ data: [{ id: "claude-test" }], has_more: false });
				received.wire = object(await request.json());
				if (++inferenceCalls === 1) return Response.json({ error: { message: "expired" } }, { status: 401 });
				return Response.json(
					{ error: { message: "Your credit balance is too low. sk-ant-oat-console-private" } },
					{ status: 400 },
				);
			},
		});
		const broker = await startBroker({ home, idleTimeout: 0, anthropicBaseUrl: upstream.url.origin });
		if (!broker) throw new Error("No test broker");
		const request = (path: string, body?: unknown, method?: string) =>
			fetch(`${broker.state.url}/credne/v1${path}`, {
				method: method ?? (body === undefined ? "GET" : "POST"),
				headers: { authorization: `Bearer ${broker.state.token}`, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		try {
			let firstKey = "";
			for (const name of ["first", "second"]) {
				const startedResponse = await request("/logins", { provider: "claude-api-credits", name });
				expect(startedResponse.status).toBe(200);
				const started = object(await startedResponse.json());
				const state = String(started.state);
				expect((await request("/logins", { provider: "claude-api-credits", name })).status).toBe(409);
				const authorize = new URL(String(started.url));
				const callback = new URL(String(authorize.searchParams.get("redirect_uri")));
				callback.searchParams.set("state", `credne-${name}`);
				callback.searchParams.set("code", "private-code");
				expect((await request(`/logins/${state}/callback`, { redirectUrl: callback.href })).status).toBe(200);
				let result = object(await (await request(`/logins/${state}`)).json());
				const deadline = Date.now() + 5000;
				while (result.status === "wait" && Date.now() < deadline)
					result = object(await (await request(`/logins/${state}`)).json());
				expect(result.status).toBe(name === "first" ? "ok" : "error");
				if (name === "first") firstKey = String(object(result.account).key);
				else expect(result.error).toContain("already added as first");
				expect(JSON.stringify(result)).not.toContain("sk-ant-oat-console-private");
			}
			expect(await Bun.file(join(home, "ant", "credne-second.logout")).exists()).toBe(true);
			expect(await Bun.file(join(home, "ant", "credne-first.logout")).exists()).toBe(false);
			const response = await request(`/route/a.${firstKey}/v1/messages`, {
				model: "claude-test",
				max_tokens: 16,
				system: "unaltered-system",
				messages: [{ role: "user", content: "question" }],
				stream: false,
			});
			expect(response.status).toBe(402);
			expect(response.headers.get("retry-after")).toBe("3600");
			expect(await response.text()).not.toContain("sk-ant-oat-console-private");
			expect(received.bearer).toBe("Bearer sk-ant-oat-console-private");
			expect(received.wire.system).toBe("unaltered-system");
			expect(inferenceCalls).toBe(2);
			expect((await request(`/accounts/${firstKey}`, undefined, "DELETE")).status).toBe(200);
			expect(await Bun.file(join(home, "ant", "credne-first.logout")).exists()).toBe(true);
		} finally {
			await broker.close();
			await upstream.stop(true);
			if (prior === undefined) delete process.env.CREDNE_ANT;
			else process.env.CREDNE_ANT = prior;
			await rm(home, { recursive: true, force: true });
		}
	},
	30000,
);
