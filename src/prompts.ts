import { select, checkbox } from "@inquirer/prompts";
import { getAllRegions } from "./regions.js";
import type { RegionKey } from "./types.js";

export type MainAction = "EXTRACT" | "SYNC";

// Prompt user for main action
export async function promptAction(): Promise<MainAction> {
  return await select<MainAction>({
    message: "What would you like to do?",
    choices: [
      { name: "🔍 Extract to SQLTools Config", value: "EXTRACT" },
      { name: "🔄 Refresh Data Cache (Sync All)", value: "SYNC" },
    ],
  });
}

// Prompt user to select a region
export async function promptRegion(): Promise<RegionKey> {
  const regions = getAllRegions();

  return await select<RegionKey>({
    message: "Select SAP BTP Cloud Foundry region:",
    choices: regions.map((r) => ({
      name: r.label,
      value: r.key,
    })),
  });
}

// Prompt user to select one org from list
export async function promptOrg(orgs: string[]): Promise<string> {
  const answer = await select<string>({
    message: "Select an org:",
    choices: orgs.map((o) => ({ name: o, value: o })),
  });

  return answer;
}

// Prompt user to select one space from list
export async function promptSpace(spaces: string[]): Promise<string> {
  if (spaces.length === 1) {
    // Auto-select if only one space
    return spaces[0] ?? "";
  }

  const answer = await select<string>({
    message: "Select a space:",
    choices: spaces.map((s) => ({ name: s, value: s })),
  });

  return answer;
}

const ALL_APPS_VALUE = "__ALL__";

// Prompt user to select apps — supports "All Apps" shortcut
export async function promptApps(apps: string[]): Promise<string[]> {
  const choices = [
    { name: "[ All Apps ]", value: ALL_APPS_VALUE },
    ...apps.map((a) => ({ name: a, value: a })),
  ];

  const selected = await checkbox<string>({
    message: "Select apps to extract HANA credentials from (space to toggle, enter to confirm):",
    choices,
    validate: (items) => items.length > 0 || "Please select at least one app.",
  });

  if (selected.includes(ALL_APPS_VALUE)) {
    return apps;
  }

  return selected;
}
