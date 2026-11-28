// Builds the stable tool declarations for a subagent without delegation or planning controls.

const defaultAgentTools = ["read", "bash", "edit", "write", "tool_search"];
const messagingTools = ["list_agents", "send_agent_message"];
const mainOnlyTools = new Set([
	"subagent",
	"steer_agent",
	"interrupt_agent",
	"continue_agent",
	"change_agent_model",
	"enter_plan_mode",
	"create_plan",
	"task_create",
	"task_update",
	"revise_plan",
	"get_plan",
	"assign_tasks",
	"assign_task",
	"cancel_tasks",
	"get_subagent_context",
	"checkpoint_context",
	"compact",
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
]);

/** Returns sorted agent tools plus messaging; MCP tools must be discovered with tool_search. */
export function workerTools(tools: string[] | undefined): string[] {
	const selected = (tools ?? defaultAgentTools).filter(
		(name) => !mainOnlyTools.has(name) && !name.startsWith("mcp__") && !name.includes("*"),
	);
	return [...new Set([...selected, ...messagingTools])].sort();
}
