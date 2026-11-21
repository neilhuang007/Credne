#!/usr/bin/env node
// Assembles the Credne package from the built Pi coding agent and the account broker.
//
// Prerequisites: `npm run build` at the repo root and Bun >=1.4.4 on PATH.
// Usage: node credne/scripts/build.mjs [--skip-broker]
//
// Pi resolves its assets (docs, README, CHANGELOG, themes, export templates) from the package
// directory, so everything is copied next to credne/package.json. The bundle's external runtime
// dependencies are copied from the monorepo's node_modules, so no registry install is needed and the
// root package-lock.json stays untouched.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAccountBroker } from "../../scripts/build-account-broker.mjs";

const credneDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(credneDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const brokerDir = join(repoRoot, "broker");
const skipBroker = process.argv.includes("--skip-broker");

const bundleCli = join(codingAgentDir, "dist", "bundle", "cli.js");
if (!existsSync(bundleCli)) {
	throw new Error(`Missing ${bundleCli}. Run \`npm run build\` at the repo root first.`);
}

function copy(from, to) {
	rmSync(to, { recursive: true, force: true });
	mkdirSync(dirname(to), { recursive: true });
	cpSync(from, to, { recursive: true, dereference: true });
}

// Pi code and assets.
copy(join(codingAgentDir, "dist"), join(credneDir, "dist"));
for (const entry of ["docs", "examples", "CHANGELOG.md"]) {
	copy(join(codingAgentDir, entry), join(credneDir, entry));
}
copy(join(credneDir, "RELEASE_NOTES.md"), join(credneDir, "README.md"));

// Runtime dependencies the bundle leaves external, at the versions package.json pins.
const manifest = JSON.parse(readFileSync(join(credneDir, "package.json"), "utf8"));
for (const [name, version] of Object.entries(manifest.dependencies)) {
	const source = join(repoRoot, "node_modules", ...name.split("/"));
	const installed = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
	if (installed !== version) {
		throw new Error(`${name}: monorepo has ${installed}, credne/package.json pins ${version}`);
	}
	copy(source, join(credneDir, "node_modules", ...name.split("/")));
}

// The account broker, found by the accounts extension in <packageDir>/bin.
if (!skipBroker) {
	rmSync(join(credneDir, "bin"), { recursive: true, force: true });
	buildAccountBroker({ outDir: join(credneDir, "bin") });
}
copy(join(brokerDir, "THIRD_PARTY_NOTICES.md"), join(credneDir, "THIRD_PARTY_NOTICES.md"));

console.log(`Built credne ${manifest.version} in ${credneDir}`);
