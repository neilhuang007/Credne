// Exercises local Credne staging, backup preservation and rollback without a build or real installation.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { installLocal } from "./install-local.mjs";

const version = "0.1.0";
const dependencies = {
	"@silvia-odwyer/photon-node": "0.3.4",
	jiti: "2.7.0",
	"quickjs-wasi": "3.6.2",
};
const brokerAssets = [
	`bin/credne-broker${process.platform === "win32" ? ".exe" : ""}`,
	"bin/pi-natives-LICENSE",
	"bin/pi-natives-THIRD-PARTY-NOTICES.txt",
	`bin/pi_natives.${process.platform}-${process.arch}${process.arch === "x64" ? "-baseline" : ""}.node`,
];

function write(path, contents = "fixture") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

function fixture({ installedVersionFails = false, stagedVersionFails = false } = {}) {
	const temp = mkdtempSync(join(tmpdir(), "credne-installer-test-"));
	const source = join(temp, "repo", "credne");
	const target = join(temp, "install", "current", "node_modules", "@neilhuang007", "credne");
	const manifest = {
		name: "@neilhuang007/credne",
		version,
		type: "module",
		files: ["dist", "bin", "docs", "examples", "README.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md"],
		dependencies,
	};
	write(join(source, "package.json"), JSON.stringify(manifest));
	const cli = `import { fileURLToPath } from "node:url";
const staged = fileURLToPath(import.meta.url).includes(".credne-stage-");
console.log(${JSON.stringify(installedVersionFails)} && !staged || ${JSON.stringify(stagedVersionFails)} && staged ? "wrong" : "${version}");
`;
	for (const [path, contents] of Object.entries({
		"dist/bundle/cli.js": cli,
		"dist/bundle/cli-runtime.js": "// fixture",
		"dist/bundle/chunks/chunk.js": "// fixture",
		"dist/core/export-html/template.html": "fixture",
		"dist/core/export-html/template.css": "fixture",
		"dist/modes/interactive/assets/theme.txt": "fixture",
		"dist/extensions/subagent/agents/worker.md": "fixture",
		"docs/index.md": "fixture",
		"examples/index.md": "fixture",
		"README.md": "fixture",
		"CHANGELOG.md": "fixture",
		"THIRD_PARTY_NOTICES.md": "fixture",
		"node_modules/quickjs-wasi/quickjs.wasm": "fixture",
		"node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm": "fixture",
		"node_modules/jiti/lib/jiti.mjs": "fixture",
	})) write(join(source, path), contents);
	for (const asset of brokerAssets) write(join(source, asset));
	for (const [name, pinnedVersion] of Object.entries(dependencies)) {
		write(join(source, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version: pinnedVersion }));
	}
	mkdirSync(target, { recursive: true });
	write(join(target, "package.json"), JSON.stringify({ name: manifest.name, version: "old" }));
	write(join(target, "old.txt"), "previous package");
	return { temp, source, target };
}

function stages(target) {
	return readdirSync(dirname(target)).filter((entry) => entry.startsWith(".credne-stage-"));
}

test("successful swap keeps an independent previous-package backup", () => {
	const { temp, source, target } = fixture();
	try {
		const result = installLocal({ target, source, skipBuild: true });
		assert.equal(result.target, target);
		assert.ok(result.backup);
		assert.equal(readFileSync(join(result.backup, "old.txt"), "utf8"), "previous package");
		assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version, version);
		assert.deepEqual(stages(target), []);
	} finally {
		rmSync(temp, { recursive: true });
	}
});

test("failure after swap restores old package and removes only its staging files", () => {
	const { temp, source, target } = fixture({ installedVersionFails: true });
	try {
		assert.throws(() => installLocal({ target, source, skipBuild: true }), /returned "wrong"/);
		assert.equal(readFileSync(join(target, "old.txt"), "utf8"), "previous package");
		assert.deepEqual(stages(target), []);
		assert.equal(readdirSync(dirname(target)).filter((entry) => entry.includes(".backup-")).length, 0);
	} finally {
		rmSync(temp, { recursive: true });
	}
});

test("invalid staged package leaves the target untouched and cleans staging", () => {
	const { temp, source, target } = fixture();
	try {
		rmSync(join(source, "node_modules", "quickjs-wasi", "quickjs.wasm"));
		assert.throws(() => installLocal({ target, source, skipBuild: true }), /quickjs.wasm/);
		assert.equal(readFileSync(join(target, "old.txt"), "utf8"), "previous package");
		assert.deepEqual(stages(target), []);
	} finally {
		rmSync(temp, { recursive: true });
	}
});

for (const asset of brokerAssets) {
	test(`a missing broker asset (${asset}) leaves the target untouched`, () => {
		const { temp, source, target } = fixture();
		try {
			rmSync(join(source, asset));
			assert.throws(
				() => installLocal({ target, source, skipBuild: true }),
				(error) => error.message.includes(asset.slice(asset.lastIndexOf("/") + 1)),
			);
			assert.equal(readFileSync(join(target, "old.txt"), "utf8"), "previous package");
			assert.deepEqual(stages(target), []);
		} finally {
			rmSync(temp, { recursive: true });
		}
	});
}

test("a staged CLI version mismatch does not move the old package", () => {
	const { temp, source, target } = fixture({ stagedVersionFails: true });
	try {
		assert.throws(() => installLocal({ target, source, skipBuild: true }), /returned "wrong"/);
		assert.equal(readFileSync(join(target, "old.txt"), "utf8"), "previous package");
		assert.deepEqual(stages(target), []);
	} finally {
		rmSync(temp, { recursive: true });
	}
});

test("source-overlapping targets are rejected before staging", () => {
	const { temp, source, target } = fixture();
	try {
		const unsafeTarget = join(dirname(source), "another-package");
		assert.throws(() => installLocal({ target: unsafeTarget, source, skipBuild: true }), /overlap the source repository/);
		assert.equal(existsSync(unsafeTarget), false);
		assert.deepEqual(stages(target), []);
	} finally {
		rmSync(temp, { recursive: true });
	}
});
