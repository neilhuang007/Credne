// Exercises retained worker model commands over real RPC without contacting a provider.
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const reference = args[args.indexOf("--model") + 1];
const slash = reference.indexOf("/");
let model = { provider: reference.slice(0, slash), id: reference.slice(slash + 1) };
let thinkingLevel = args[args.indexOf("--thinking") + 1];
let scenario;
let generation = 0;
const history = [];
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const record = (type, extra = {}) =>
	fs.appendFileSync(scenario.log, `${JSON.stringify({ type, pid: process.pid, model, thinkingLevel, history, ...extra })}\n`);

async function prompt(message) {
	const run = ++generation;
	scenario = message.startsWith("{") ? JSON.parse(message.split("\n\n")[0]) : { ...scenario, releaseFile: undefined };
	history.push(message);
	record("prompt");
	emit({ type: "message_end", message: { role: "user", content: message, timestamp: 0 } });
	const response = {
		role: "assistant",
		content: [{ type: "text", text: JSON.stringify({ pid: process.pid, history, model, thinkingLevel }) }],
		api: "openai-completions",
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};
	if (scenario.streaming) stream(response);
	while (scenario.releaseFile && !fs.existsSync(scenario.releaseFile) && generation === run)
		await new Promise((resolve) => setTimeout(resolve, 5));
	if (generation !== run) return;
	if (scenario.streaming) {
		response.content = [{ type: "text", text: "Final authoritative response" }];
		response.usage = { ...response.usage, input: 10, output: 5, totalTokens: 15 };
	}
	emit({ type: "message_end", message: response });
	emit({ type: "agent_settled", aborted: false });
}

function stream(response) {
	emit({ type: "message_start", message: { ...response, content: [] } });
	const update = (assistantMessageEvent) => emit({ type: "message_update", usage: { ...response.usage, input: 10, output: 3, totalTokens: 13 }, assistantMessageEvent });
	update({ type: "thinking_start", contentIndex: 0 });
	update({ type: "thinking_delta", contentIndex: 0, delta: "Reason" });
	update({ type: "thinking_delta", contentIndex: 0, delta: "ing" });
	update({ type: "thinking_end", contentIndex: 0, content: "Finished reasoning" });
	update({ type: "text_start", contentIndex: 1 });
	update({ type: "text_delta", contentIndex: 1, delta: "par" });
	update({ type: "text_delta", contentIndex: 1, delta: "tial" });
	update({ type: "text_end", contentIndex: 1, content: "Finished text" });
	update({ type: "toolcall_start", contentIndex: 2, id: "read-1", toolName: "read" });
	update({ type: "toolcall_delta", contentIndex: 2, delta: '{"path":"src/' });
	update({ type: "toolcall_delta", contentIndex: 2, delta: 'file.ts"}' });
	update({ type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "read-1", name: "read", arguments: { path: "final.ts" } } });
	emit({ type: "message_end", message: { role: "toolResult", toolName: "read", toolCallId: "read-1", content: [], isError: false, timestamp: 0 } });
}

async function command(input) {
	const respond = (data) => emit({ type: "response", id: input.id, command: input.type, success: true, data });
	if (input.type === "prompt") {
		respond({ disposition: "started" });
		await prompt(input.message);
		return;
	}
	if (input.type === "steer") {
		history.push(input.message);
		emit({ type: "queue_update", steering: [input.message], followUp: [] });
		respond({ disposition: "queued" });
		return;
	}
	if (input.type === "set_model") {
		record(input.type, { requested: { provider: input.provider, id: input.modelId } });
		if (input.modelId === "model-error") throw new Error("Fixture rejected model");
		while (scenario.configurationReleaseFile && !fs.existsSync(scenario.configurationReleaseFile))
			await new Promise((resolve) => setTimeout(resolve, 5));
		model = { provider: input.provider, id: input.modelId };
		thinkingLevel = "minimal";
		respond(model);
		return;
	}
	if (input.type === "set_thinking_level") {
		record(input.type);
		if (model.id === "effort-error") throw new Error("Fixture rejected effort");
		thinkingLevel = input.level;
	}
	if (input.type === "abort") generation++;
	if (input.type === "get_state") {
		respond({ model, thinkingLevel });
		return;
	}
	respond(input.type === "clear_queue" ? { steering: [], followUp: [] } : undefined);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const input = JSON.parse(line);
	void command(input).catch((error) => emit({ type: "response", id: input.id, command: input.type, success: false, error: error.message }));
});
