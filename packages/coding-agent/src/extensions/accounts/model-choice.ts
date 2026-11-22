import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { findAliasRowOfModel, resolveAliasRow } from "../subagent/model-aliases.ts";
import { accountDisplayName, familyOf, sharedRouteFamily } from "./catalog.ts";
import type { AccountProviderSpec } from "./provider.ts";

/** Let the user pin a payer for a shared pool model, or deliberately keep the pool's failover. */
export async function choosePoolModelAccount(
	model: Model<Api>,
	provider: (Provider & Pick<AccountProviderSpec, "poolAccounts">) | undefined,
	select: (title: string, options: string[]) => Promise<string | undefined>,
	alias?: string,
): Promise<Model<Api> | undefined> {
	const members = provider?.poolAccounts;
	if (!members || members.length < 2) return model;
	const source = members.find((member) => member.models.some((candidate) => candidate.id === model.id));
	if (!source) return model;
	const family = sharedRouteFamily(familyOf(source.provider));
	const aliasRow = alias ? findAliasRowOfModel(model.id) : undefined;
	const row = aliasRow && aliasRow.alias === alias?.toLowerCase() ? aliasRow : undefined;
	const choices = members.flatMap((member) => {
		if (sharedRouteFamily(familyOf(member.provider)) !== family) return [];
		const candidate = row
			? resolveAliasRow(row, member.models)
			: member.models.find((entry) => entry.id === model.id);
		return candidate ? [{ member, model: candidate }] : [];
	});
	if (choices.length < 2) return model;
	choices.sort((left, right) => Number(right.member.kind === "oauth") - Number(left.member.kind === "oauth"));
	const names = choices.map(({ member }) => accountDisplayName(member));
	const options = choices.map(({ member, model: candidate }, index) => {
		const name = names[index];
		const identity = names.indexOf(name) === names.lastIndexOf(name) ? name : `${name} [${member.id}]`;
		return `${member.kind === "oauth" ? "Subscription" : "API key"}: ${identity} · ${candidate.id}`;
	});
	options.push(`Keep ${provider.name} · automatic failover`);
	const selected = await select(`Which account should pay for ${row?.alias ?? model.id}?`, options);
	if (selected === undefined) return undefined;
	const index = options.indexOf(selected);
	return index === choices.length ? model : choices[index]?.model;
}
