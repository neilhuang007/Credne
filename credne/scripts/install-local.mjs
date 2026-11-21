#!/usr/bin/env node
// Builds and safely replaces only the local Credne package, keeping the previous package as a backup.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredBrokerAddon } from "../../scripts/build-account-broker.mjs";
import { execNpmSync } from "../../scripts/npm-command.mjs";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@neilhuang007/credne";

function parseOptions(args) {
	let target;
	let skipBuild = false;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--target" && args[index + 1] && !args[index + 1].startsWith("--")) {
			if (target !== undefined) throw new Error("--target may only be specified once");
			target = args[++index];
		} else if (args[index] === "--skip-build") {
			skipBuild = true;
		} else {
			throw new Error(`Unknown or incomplete option: ${args[index]}`);
		}
	}
	if (target === undefined) {
		if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
			throw new Error("Specify --target (the Windows default requires LOCALAPPDATA)");
		}
		target = join(process.env.LOCALAPPDATA, "pi-node", "current", "node_modules", "@neilhuang007", "credne");
	}
	return { target: resolve(target), skipBuild };
}

function isWithin(path, directory) {
	const relativePath = relative(directory, path);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function existingPath(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

function validateTarget(target, packageDir) {
	const parent = dirname(target);
	const parentEntry = existingPath(parent);
	if (!parentEntry || !statSync(parent).isDirectory()) throw new Error(`Target parent directory does not exist: ${parent}`);
	const entry = existingPath(target);
	if (entry?.isSymbolicLink()) throw new Error(`Refusing to replace a symlink: ${target}`);
	if (entry && !entry.isDirectory()) throw new Error(`Target is not a directory: ${target}`);

	const canonicalTarget = join(realpathSync(parent), target.slice(parent.length + 1));
	const canonicalRepo = realpathSync(dirname(packageDir));
	if (isWithin(canonicalTarget, canonicalRepo) || isWithin(canonicalRepo, canonicalTarget)) {
		throw new Error(`Target must not overlap the source repository: ${target}`);
	}
	if (entry) {
		const installed = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
		if (installed.name !== packageName) throw new Error(`Refusing to replace a different package: ${target}`);
	}
}

function packageManifest(directory) {
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	if (manifest.name !== packageName) throw new Error(`Expected ${packageName} in ${directory}`);
	if (!Array.isArray(manifest.files) || !manifest.dependencies || typeof manifest.version !== "string") {
		throw new Error(`Incomplete Credne package manifest: ${directory}`);
	}
	return manifest;
}

function copyPackage(directory, staging, manifest) {
	for (const entry of ["package.json", ...manifest.files, "node_modules"]) {
		if (typeof entry !== "string" || entry === "." || entry === "" || isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
			throw new Error(`Unsafe Credne package entry: ${entry}`);
		}
		mkdirSync(dirname(join(staging, entry)), { recursive: true });
		cpSync(join(directory, entry), join(staging, entry), { recursive: true, dereference: true });
	}
}

function requireFile(directory, entry) {
	const path = join(directory, entry);
	if (!statSync(path).isFile()) throw new Error(`Missing required Credne file: ${path}`);
}

function requireDirectory(directory, entry) {
	const path = join(directory, entry);
	if (!statSync(path).isDirectory()) throw new Error(`Missing required Credne directory: ${path}`);
}

function validatePackage(directory, version) {
	const manifest = packageManifest(directory);
	if (manifest.version !== version) throw new Error(`Unexpected Credne version in ${directory}: ${manifest.version}`);
	for (const path of [
		"dist/bundle/cli.js",
		"dist/bundle/cli-runtime.js",
		"dist/core/export-html/template.html",
		"dist/core/export-html/template.css",
		"README.md",
		"CHANGELOG.md",
		"THIRD_PARTY_NOTICES.md",
		`bin/credne-broker${process.platform === "win32" ? ".exe" : ""}`,
		"bin/pi-natives-LICENSE",
		"bin/pi-natives-THIRD-PARTY-NOTICES.txt",
		`bin/${requiredBrokerAddon()}`,
	]) requireFile(directory, path);
	for (const path of ["dist/bundle/chunks", "dist/modes/interactive/assets", "dist/extensions/subagent/agents", "docs", "examples"]) {
		requireDirectory(directory, path);
	}
	for (const [name, pinnedVersion] of Object.entries(manifest.dependencies)) {
		const dependencyDir = join(directory, "node_modules", ...name.split("/"));
		const installed = JSON.parse(readFileSync(join(dependencyDir, "package.json"), "utf8"));
		if (installed.name !== name || installed.version !== pinnedVersion) {
			throw new Error(`Runtime dependency mismatch: ${name}@${pinnedVersion} in ${directory}`);
		}
	}
	requireFile(directory, "node_modules/quickjs-wasi/quickjs.wasm");
	requireFile(directory, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm");
	requireFile(directory, "node_modules/jiti/lib/jiti.mjs");
}

function checkVersion(directory, version, node) {
	const output = execFileSync(node, [join(directory, "dist", "bundle", "cli.js"), "--version", "--offline"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
		env: { ...process.env, PI_PACKAGE_DIR: directory, PI_SKIP_VERSION_CHECK: "1" },
	}).trim();
	if (output !== version) throw new Error(`Credne --version at ${directory} returned ${JSON.stringify(output)}; expected ${version}`);
}

function backupPath(target) {
	let path;
	do {
		path = `${target}.backup-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
	} while (existingPath(path));
	return path;
}

/** Install a locally built Credne package without modifying the Node runtime, wrappers or other packages. */
export function installLocal({ target, skipBuild = false, source = sourceDir }) {
	const destination = resolve(target);
	const directory = resolve(source);
	validateTarget(destination, directory);
	if (!skipBuild) {
		execNpmSync(["run", "build:offline"], { cwd: dirname(directory), stdio: "inherit" });
		execFileSync(process.execPath, [join(directory, "scripts", "build.mjs")], { cwd: dirname(directory), stdio: "inherit" });
	}
	const manifest = packageManifest(directory);
	const nodeCandidate = join(dirname(dirname(dirname(destination))), process.platform === "win32" ? "node.exe" : "node");
	const node = existsSync(nodeCandidate) ? nodeCandidate : process.execPath;
	const staging = mkdtempSync(join(dirname(destination), ".credne-stage-"));
	let backup;
	let stageLocation = staging;
	try {
		copyPackage(directory, staging, manifest);
		validatePackage(staging, manifest.version);
		checkVersion(staging, manifest.version, node);

		if (existingPath(destination)) {
			backup = backupPath(destination);
			renameSync(destination, backup);
		}
		try {
			renameSync(staging, destination);
			stageLocation = destination;
			checkVersion(destination, manifest.version, node);
		} catch (error) {
			try {
				if (stageLocation === destination) {
					renameSync(destination, staging);
					stageLocation = staging;
				}
				if (backup) renameSync(backup, destination);
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], `Credne install failed; rollback failed. Previous package: ${backup ?? "none"}; new package: ${stageLocation}`);
			}
			throw error;
		}
		console.log(`Installed Credne ${manifest.version} at ${destination}`);
		console.log(`Previous Credne package backup: ${backup ?? "none (first installation)"}`);
		return { target: destination, backup };
	} finally {
		if (stageLocation === staging && existingPath(staging)) {
			try {
				rmSync(staging, { recursive: true });
			} catch (error) {
				console.error(`Could not clean up staging directory ${staging}: ${error.message}`);
			}
		}
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		installLocal(parseOptions(process.argv.slice(2)));
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
