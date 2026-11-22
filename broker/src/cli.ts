#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { BrokerConfigError } from "./config.ts";
import { type BrokerOptions, startBroker } from "./service.ts";

function duration(value: string): number {
	if (value === "0") return 0;
	let total = 0,
		end = 0;
	for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
		if (match.index !== end) throw new Error("Invalid idle timeout.");
		total += Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]] ?? 0);
		end = match.index + match[0].length;
	}
	if (end !== value.length || !Number.isFinite(total) || total <= 0) throw new Error("Invalid idle timeout.");
	return total;
}
async function main(): Promise<void> {
	process.umask(0o077);
	const version = process.env.CREDNE_BROKER_VERSION ?? "0.1.6";
	const options: BrokerOptions = {
		home: join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "accounts"),
		version,
	};
	const args = process.argv.slice(2);
	let debug = false;
	for (let index = 0; index < args.length; index++) {
		const [flag, inline] = args[index].split("=", 2);
		if (flag === "--version") {
			console.log(version);
			return;
		}
		if (flag === "--debug") {
			debug = inline !== "false";
			continue;
		}
		if (flag === "--help" || flag === "-h") {
			console.log(
				"credne-broker [--home DIR] [--idle-timeout 30m] [--max-concurrency-per-account N] [--anthropic-base-url URL] [--openai-base-url URL] [--typesafe-base-url URL] [--debug] [--version]",
			);
			return;
		}
		const value = inline ?? args[++index];
		if (value === undefined) throw new Error("Missing broker flag value.");
		switch (flag) {
			case "--home":
				options.home = value;
				break;
			case "--idle-timeout":
				options.idleTimeout = duration(value);
				break;
			case "--max-concurrency-per-account":
				options.maxConcurrency = Number(value);
				if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 0)
					throw new Error("Concurrency must be a nonnegative integer.");
				break;
			case "--anthropic-base-url":
			case "--openai-base-url":
			case "--typesafe-base-url": {
				const url = new URL(value);
				if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
					throw new Error("Invalid provider base URL.");
				const base = url.href.replace(/\/$/, "");
				if (flag === "--anthropic-base-url") options.anthropicBaseUrl = base;
				else if (flag === "--openai-base-url") options.openaiBaseUrl = base;
				else options.typesafeBaseUrl = base;
				break;
			}
			default:
				throw new Error("Unknown broker flag.");
		}
	}
	const broker = await startBroker(options);
	if (!broker) return;
	const stop = () => {
		void broker.close();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	console.error(`credne-broker ready (${version}, oh-my-pi 19.0.0)`);
	if (debug) console.error(`credne-broker daemon PID ${broker.state.pid}; listening at ${broker.state.url}`);
	await broker.closed;
	if (debug) console.error("credne-broker daemon stopped");
	process.removeListener("SIGINT", stop);
	process.removeListener("SIGTERM", stop);
}
if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(
			error instanceof BrokerConfigError
				? `credne-broker: ${error.message}`
				: "credne-broker: startup failed. Check home permissions, configuration, and whether a legacy broker must be stopped.",
		);
		process.exitCode = 1;
	}
}
