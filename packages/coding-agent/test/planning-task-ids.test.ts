import { fauxAssistantMessage, fauxToolCall, getCurrentTools, getInitialSystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import planningExtension from "../src/extensions/planning/index.ts";
import { createHarness } from "./suite/harness.ts";

describe("planning task IDs", () => {
	it.each(["assign_tasks", "cancel_tasks"])("%s accepts Codex schemas and rejects duplicate IDs", async (name) => {
		const harness = await createHarness({ extensionFactories: [planningExtension] });
		try {
			await harness.session.bindExtensions({});
			harness.setResponses([
				(context) => {
					// Plan tools stay undeclared until enter_plan_mode.
					const initial = getInitialSystemMessage(context.messages)?.toolsAdded?.map((entry) => entry.name);
					expect(initial).toContain("enter_plan_mode");
					expect(initial).not.toContain(name);
					return fauxAssistantMessage(fauxToolCall("enter_plan_mode", {}), { stopReason: "toolUse" });
				},
				(context) => {
					const tool = getCurrentTools(context.messages).find((entry) => entry.name === name);
					expect(tool?.parameters).toMatchObject({
						properties: { taskIds: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } } },
					});
					expect(tool?.parameters).not.toHaveProperty("properties.taskIds.uniqueItems");
					return fauxAssistantMessage(
						fauxToolCall("create_plan", {
							objective: "Verify",
							tasks: [{ name: "Check", description: "Check output", order: 1 }],
						}),
						{ stopReason: "toolUse" },
					);
				},
				// The bundled worker pins a Claude model that the faux provider does not serve, so assign_tasks gets one it does.
				fauxAssistantMessage(
					fauxToolCall(name, {
						revision: 1,
						taskIds: ["1", "1"],
						...(name === "assign_tasks" ? { model: harness.getModel().id } : {}),
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Check duplicate task IDs.");
			const result = harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === name
						? [entry.message]
						: [],
				);
			expect(result).toMatchObject([
				{ isError: true, content: [{ type: "text", text: expect.stringContaining("distinct") }] },
			]);
		} finally {
			harness.cleanup();
		}
	});
});
