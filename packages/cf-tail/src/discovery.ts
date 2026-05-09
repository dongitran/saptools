import { fetchStartedAppsViaCfCli } from "@saptools/cf-logs";
import type { AppCatalogEntry } from "@saptools/cf-logs";

import { applyAppFilter, buildAppFilter } from "./filters.js";
import type { DiscoverAppsInput } from "./types.js";

export async function discoverMatchingApps(
  input: DiscoverAppsInput,
): Promise<readonly AppCatalogEntry[]> {
  const apps = await fetchStartedAppsViaCfCli({
    ...(input.apiEndpoint === undefined ? {} : { apiEndpoint: input.apiEndpoint }),
    ...(input.region === undefined ? {} : { region: input.region }),
    email: input.email,
    password: input.password,
    org: input.org,
    space: input.space,
    ...(input.cfHomeDir === undefined ? {} : { cfHomeDir: input.cfHomeDir }),
    ...(input.command === undefined ? {} : { command: input.command }),
  });
  const filter = buildAppFilter(input);
  const filtered = applyAppFilter(apps, filter);
  return [...filtered].sort((left, right) => left.name.localeCompare(right.name));
}

export function diffAppCatalogs(
  before: readonly AppCatalogEntry[],
  after: readonly AppCatalogEntry[],
): { readonly addedApps: readonly string[]; readonly removedApps: readonly string[] } {
  const beforeNames = new Set(before.map((app) => app.name));
  const afterNames = new Set(after.map((app) => app.name));
  const addedApps: string[] = [];
  const removedApps: string[] = [];
  for (const name of afterNames) {
    if (!beforeNames.has(name)) {
      addedApps.push(name);
    }
  }
  for (const name of beforeNames) {
    if (!afterNames.has(name)) {
      removedApps.push(name);
    }
  }
  addedApps.sort((left, right) => left.localeCompare(right));
  removedApps.sort((left, right) => left.localeCompare(right));
  return { addedApps, removedApps };
}
