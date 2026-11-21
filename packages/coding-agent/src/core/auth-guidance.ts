import { join } from "node:path";
import { getDocsPath, USES_BROKER_AUTH } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export const BROKER_AUTH_GUIDANCE = "Manage provider credentials with /accounts.";
export const BROKER_MCP_AUTH_GUIDANCE =
	"Credne cannot reuse model account credentials for MCP. Configure the MCP server's own authentication.";

export function getProviderLoginHelp(): string {
	if (USES_BROKER_AUTH) return BROKER_AUTH_GUIDANCE;
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return USES_BROKER_AUTH
		? `No account configured for ${providerDisplay}. ${BROKER_AUTH_GUIDANCE}`
		: `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
