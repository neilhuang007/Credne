import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getInitialSystemMessage,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { completeTask, createPlan, startTasks, type TaskSpec } from "../src/extensions/planning/graph.ts";
import planningExtension from "../src/extensions/planning/index.ts";
import { discoverAgents, discoverBundledAgents } from "../src/extensions/subagent/agents.ts";
import { createSubagentDispatch } from "../src/extensions/subagent/dispatch.ts";
import { emptyUsage, type SingleResult } from "../src/extensions/subagent/runner.ts";
import { registerTeamTools, type SpawnInput, WorkerTeam } from "../src/extensions/subagent/team.ts";
import {
	registerWorkerPrompt,
	WORKER_CONVERSATION_ENV,
	WORKER_FLAG,
} from "../src/extensions/subagent/worker-prompt.ts";
import { workerTools } from "../src/extensions/subagent/worker-tools.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

describe("planned worker request layout", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it.each([false, true])(
		"assigns a task with optional acceptance criteria: %s and includes earlier results",
		async (withAcceptance) => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-planning-layout-"));
			directories.push(cwd);
			const agentDirectory = join(cwd, "user-agent");
			mkdirSync(join(agentDirectory, "agents"), { recursive: true });
			writeFileSync(
				join(agentDirectory, "agents", "worker.md"),
				"---\nname: worker\ndescription: User override\ntools: read\n---\nUser worker override",
			);
			vi.stubEnv(ENV_AGENT_DIR, agentDirectory);
			vi.stubEnv(WORKER_CONVERSATION_ENV, "");
			expect(discoverAgents(cwd, "user").agents.find((agent) => agent.name === "worker")?.source).toBe("user");
			const dependency: TaskSpec = {
				id: "1",
				name: "Search schema",
				order: 1,
				description: "Define the search result",
			};
			const task: TaskSpec = {
				id: "2",
				name: "Search API",
				order: 2,
				description: "Implement product search",
				...(withAcceptance ? { acceptance: ["API tests pass"] } : {}),
			};
			const createdPlan = createPlan("Searchable product catalog", [dependency, task], "Initial plan");
			const plan = completeTask(
				startTasks(createdPlan, [dependency.id]),
				dependency.id,
				"Schema returns {id, name, price}",
			);
			const sessionManager = SessionManager.inMemory(cwd);
			sessionManager.appendCustomEntry("planning-state", plan);
			const spawned: SpawnInput[] = [];
			vi.spyOn(WorkerTeam.prototype, "spawn").mockImplementation((input) => {
				spawned.push(input);
				const result: SingleResult = {
					agent: input.name,
					agentSource: "builtin",
					task: input.task,
					status: "completed",
					exitCode: 0,
					messages: [],
					stderr: "",
					usage: emptyUsage(),
				};
				return { id: "planned-worker", result: Promise.resolve(result) };
			});
			const parent = await createHarness({ cwd, sessionManager, extensionFactories: [planningExtension] });
			harnesses.push(parent);
			await parent.session.bindExtensions({});
			parent.setResponses([
				// The bundled worker pins a Claude model that the faux provider does not serve, so the call names one it does.
				fauxAssistantMessage(
					fauxToolCall("assign_tasks", {
						revision: plan.revision,
						taskIds: [task.id],
						model: parent.getModel().id,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("assigned"),
			]);
			await parent.session.prompt("Assign the API task.");
			expect(spawned).toHaveLength(1);
			const assignment = spawned[0];
			const bundled = discoverBundledAgents().find((agent) => agent.name === "worker")!;
			expect(assignment.resolved.agent).toEqual(bundled);
			expect(assignment.defaults.context.mode).toBe("fresh");
			const assignmentText = await assignment.beforeStart!();
			const [heading, ...json] = assignmentText.split("\n");
			expect(heading).toBe("Task assignment notification.");
			expect(JSON.parse(json.join("\n"))).toEqual({
				plan: { objective: plan.objective, tasks: [dependency, task] },
				objective: plan.objective,
				task,
				earlierResults: [{ id: dependency.id, name: dependency.name, output: "Schema returns {id, name, price}" }],
			});
			const extensionsResult = await createTestExtensionsResult([
				(pi) => {
					registerWorkerPrompt(pi);
					registerTeamTools(pi, async () => [], createSubagentDispatch(pi));
				},
				planningExtension,
				createToolSearchExtension(),
			]);
			extensionsResult.runtime.flagValues.set(WORKER_FLAG, true);
			extensionsResult.runtime.flagValues.set("planning-worker", true);
			const tools = workerTools(bundled.tools);
			const child = await createHarness({
				cwd,
				initialActiveToolNames: tools,
				allowedToolNames: tools,
				resourceLoader: {
					...createTestResourceLoader({ extensionsResult }),
					getSystemPrompt: () => assignment.resolved.agent!.systemPrompt,
					getAgentsFiles: () => ({ agentsFiles: [{ path: join(cwd, "AGENTS.md"), content: "Project rules" }] }),
				},
			});
			harnesses.push(child);
			await child.session.bindExtensions({});
			const requests: TranscriptContext[] = [];
			child.setResponses([
				(context) => {
					requests.push(structuredClone(context));
					return fauxAssistantMessage("done");
				},
			]);
			await child.session.prompt(assignmentText);
			const head = getInitialSystemMessage(requests[0].messages)!;
			const prompt = getSystemMessageText(head);
			expect(prompt.startsWith(bundled.systemPrompt)).toBe(true);
			expect(prompt).toContain("Project rules");
			expect(prompt.endsWith(`<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`)).toBe(true);
			expect(prompt).not.toMatch(/Planned task|User worker override|Searchable product catalog/);
			expect(head.toolsAdded?.map((tool) => tool.name)).toEqual(tools);
			expect(requests[0].messages[1]).toMatchObject({
				role: "user",
				content: [{ type: "text", text: assignmentText }],
			});
		},
	);

	it("restores historical identities and completed state before revising", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-planning-restore-"));
		directories.push(cwd);
		const sessionManager = SessionManager.inMemory(cwd);
		const plan = createPlan("Search", [{ name: "API", description: "Build API", order: 1 }], "Initial");
		plan.tasks[0].spec.id = "old-task";
		plan.tasks[0].state = { status: "done", output: "Built" };
		sessionManager.appendCustomEntry("planning-state", plan);
		const parent = await createHarness({ cwd, sessionManager, extensionFactories: [planningExtension] });
		harnesses.push(parent);
		await parent.session.bindExtensions({});
		parent.setResponses([
			fauxAssistantMessage(
				fauxToolCall("revise_plan", {
					revision: 1,
					reason: "Add verification",
					tasks: [{ ...plan.tasks[0].spec }, { name: "Verify", description: "Verify API", order: 2 }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("planned"),
		]);
		await parent.session.prompt("Revise the restored plan.");
		const states = sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "planning-state");
		expect(states.at(-1)).toMatchObject({
			data: { tasks: [plan.tasks[0], { spec: { id: "1" }, state: { status: "pending" } }] },
		});
	});

	it("creates and revises minimal tasks through the tools", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-planning-minimal-"));
		directories.push(cwd);
		const parent = await createHarness({ cwd, extensionFactories: [planningExtension] });
		harnesses.push(parent);
		const setWidget = vi.fn();
		const setSidePanelSection = vi.fn();
		await parent.session.bindExtensions({ uiContext: createTestUiContext({ setWidget, setSidePanelSection }) });
		const task = { name: "Search API", description: "Implement product search", order: 1 };
		const requests: TranscriptContext[] = [];
		parent.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage(fauxToolCall("create_plan", { objective: "Product search", tasks: [task] }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(
				fauxToolCall("revise_plan", {
					revision: 1,
					reason: "Clarify the outcome",
					tasks: [{ ...task, id: "1", description: "Implement product search by name" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("task_create", { revision: 2, name: "Verify", description: "Verify search", order: 2 }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("planned"),
		]);
		await parent.session.prompt("Plan product search.");
		expect(setWidget).toHaveBeenCalledWith("planning", expect.any(Function), { placement: "aboveEditor" });
		// The same plan also goes to the top of the side panel.
		expect(setSidePanelSection).toHaveBeenCalledWith("planning", expect.any(Function), { order: 0 });
		const states = parent.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "planning-state");
		expect(states).toHaveLength(3);
		const results = parent.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(JSON.stringify(results.find((result) => result.toolName === "create_plan")?.content)).toContain(
			'\\"id\\": \\"1\\"',
		);
		expect(JSON.stringify(results.find((result) => result.toolName === "task_create")?.content)).toContain(
			'\\"id\\": \\"2\\"',
		);
		expect(states[1]).toMatchObject({
			data: {
				revision: 2,
				tasks: [
					{
						spec: { ...task, id: "1", description: "Implement product search by name" },
						state: { status: "pending" },
					},
				],
			},
		});
		expect(states[2]).toMatchObject({
			data: { revision: 3, tasks: [{ spec: { id: "1" } }, { spec: { id: "2", name: "Verify" } }] },
		});
	});
});
