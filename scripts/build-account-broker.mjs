#!/usr/bin/env node
// Compiles the account broker and packages the native assets its upstream loader needs.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brokerDir = join(repoRoot, "broker");
const brokerRequire = createRequire(join(brokerDir, "package.json"));

export function assertBunVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version);
	const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
	if (!match || major < 1 || (major === 1 && (minor < 4 || (minor === 4 && patch < 4)))) {
		throw new Error(`Building the account broker requires Bun >=1.4.4; found ${version}.`);
	}
}

export function requiredBrokerAddon() {
	return `pi_natives.${process.platform}-${process.arch}${process.arch === "x64" ? "-baseline" : ""}.node`;
}

export function buildAccountBroker({ outDir = join(brokerDir, "dist") } = {}) {
	let bunVersion;
	try {
		bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (cause) {
		throw new Error("Building the account broker requires Bun >=1.4.4 on PATH.", { cause });
	}
	assertBunVersion(bunVersion);

	const platformTag = `${process.platform}-${process.arch}`;
	const nativeManifestPath = resolve(dirname(brokerRequire.resolve("@oh-my-pi/pi-natives")), "..", "package.json");
	const nativeManifest = JSON.parse(readFileSync(nativeManifestPath, "utf8"));
	const nativeName = `@oh-my-pi/pi-natives-${platformTag}`;
	const nativeVersion = nativeManifest.optionalDependencies[nativeName];
	if (!nativeVersion) throw new Error(`The account broker does not support ${platformTag}.`);
	let nativeDir;
	try {
		nativeDir = dirname(brokerRequire.resolve(`${nativeName}/package.json`));
	} catch (cause) {
		throw new Error(`Missing ${nativeName}@${nativeVersion}. Run npm ci --ignore-scripts without --omit=optional.`, { cause });
	}
	const installedNative = JSON.parse(readFileSync(join(nativeDir, "package.json"), "utf8"));
	if (installedNative.version !== nativeVersion) {
		throw new Error(`${nativeName}: installed ${installedNative.version}, expected ${nativeVersion}.`);
	}
	const addons = [requiredBrokerAddon()];
	const modernAddon = `pi_natives.${platformTag}-modern.node`;
	if (process.arch === "x64" && existsSync(join(nativeDir, modernAddon))) addons.push(modernAddon);
	const notices = ["LICENSE", "THIRD-PARTY-NOTICES.txt"];
	for (const asset of [...addons, ...notices]) {
		if (!existsSync(join(nativeDir, asset))) throw new Error(`Missing broker native asset: ${join(nativeDir, asset)}`);
	}

	const output = resolve(outDir);
	const binary = join(output, process.platform === "win32" ? "credne-broker.exe" : "credne-broker");
	const version = JSON.parse(readFileSync(join(repoRoot, "credne", "package.json"), "utf8")).version;
	mkdirSync(output, { recursive: true });
	execFileSync("bun", [
		"build", "--compile", "src/cli.ts", "--outfile", binary,
		"--define", `process.env.CREDNE_BROKER_VERSION=${JSON.stringify(version)}`,
	], { cwd: brokerDir, stdio: "inherit" });

	// pi-natives resolves adjacent addons dynamically, so Bun cannot discover these as static imports.
	for (const addon of addons) cpSync(join(nativeDir, addon), join(output, addon));
	for (const notice of notices) cpSync(join(nativeDir, notice), join(output, `pi-natives-${notice}`));
	// bun:sqlite ships in the compiled runtime; pi-catalog's static models/rules JSON imports are bundled.
	return binary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		buildAccountBroker();
	} else if (args.length === 2 && args[0] === "--out" && !args[1].startsWith("--")) {
		buildAccountBroker({ outDir: args[1] });
	} else {
		throw new Error("Usage: node scripts/build-account-broker.mjs [--out <directory>]");
	}
}
