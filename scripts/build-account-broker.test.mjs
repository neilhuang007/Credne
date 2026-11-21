import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertBunVersion } from "./build-account-broker.mjs";

for (const version of ["0.99.99", "1.3.99", "1.4.3", "1.4.4-canary", "1.4", "unknown", ""]) {
	test(`broker builds reject unsupported Bun version ${JSON.stringify(version)}`, () => {
		assert.throws(() => assertBunVersion(version), /requires Bun >=1\.4\.4/);
	});
}

for (const args of [["--out"], ["--unknown"], ["--out", "--unknown"], ["--out", "dist", "--extra"]]) {
	test(`broker builder rejects incomplete or unknown arguments ${JSON.stringify(args)}`, () => {
		const result = spawnSync(process.execPath, [fileURLToPath(new URL("./build-account-broker.mjs", import.meta.url)), ...args], {
			encoding: "utf8",
			env: { ...process.env, PATH: "" },
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Usage: node scripts\/build-account-broker\.mjs/);
	});
}
