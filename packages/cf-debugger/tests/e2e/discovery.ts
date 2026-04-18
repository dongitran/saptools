import { listKnownRegionKeys, resolveApiEndpoint } from "../../src/regions.js";

import {
  cfExec,
  parseApps,
  parseOrgs,
  parseSpaces,
  withIsolatedCfHome,
} from "./helpers.js";

export interface DebugTarget {
  readonly regionKey: string;
  readonly apiEndpoint: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

interface ScoredTarget extends DebugTarget {
  readonly appState: string;
  readonly runningInstances: number;
}

function scoreTargets(
  regionKey: string,
  apiEndpoint: string,
  org: string,
  space: string,
  count: number,
  appsOutput: string,
): readonly ScoredTarget[] {
  const running = parseApps(appsOutput)
    .filter((app) => app.state === "started" && app.runningInstances > 0)
    .slice(0, count);

  return running.map((app) => ({
    regionKey,
    apiEndpoint,
    org,
    space,
    app: app.name,
    appState: app.state,
    runningInstances: app.runningInstances,
  }));
}

function candidateRegions(): readonly string[] {
  const override = process.env["CF_DEBUGGER_E2E_REGIONS"];
  if (override !== undefined && override.trim().length > 0) {
    return override
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return listKnownRegionKeys();
}

async function loginTo(
  apiEndpoint: string,
  email: string,
  password: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await cfExec(["api", apiEndpoint], env, 45_000);
    await cfExec(["auth", email, password], env, 45_000);
    return true;
  } catch {
    return false;
  }
}

async function discoverTargetsInRegion(
  regionKey: string,
  apiEndpoint: string,
  email: string,
  password: string,
  count: number,
): Promise<readonly ScoredTarget[]> {
  return await withIsolatedCfHome(async ({ env }) => {
    const authenticated = await loginTo(apiEndpoint, email, password, env);
    if (!authenticated) {
      return [];
    }
    let orgs: readonly string[];
    try {
      const { stdout } = await cfExec(["orgs"], env);
      orgs = parseOrgs(stdout);
    } catch {
      return [];
    }

    for (const org of orgs) {
      let spaces: readonly string[];
      try {
        await cfExec(["target", "-o", org], env);
        const { stdout } = await cfExec(["spaces"], env);
        spaces = parseSpaces(stdout);
      } catch {
        continue;
      }

      for (const space of spaces) {
        try {
          await cfExec(["target", "-o", org, "-s", space], env);
          const { stdout } = await cfExec(["apps"], env);
          const targets = scoreTargets(regionKey, apiEndpoint, org, space, count, stdout);
          if (targets.length >= count) {
            return targets;
          }
        } catch {
          continue;
        }
      }
    }

    return [];
  });
}

export async function discoverDebugTargets(
  email: string,
  password: string,
  count: number,
): Promise<readonly DebugTarget[]> {
  const regions = candidateRegions();

  for (const regionKey of regions) {
    const apiEndpoint = resolveApiEndpoint(regionKey);
    const targets = await discoverTargetsInRegion(regionKey, apiEndpoint, email, password, count);
    if (targets.length >= count) {
      return targets.map((target) => ({
        regionKey: target.regionKey,
        apiEndpoint: target.apiEndpoint,
        org: target.org,
        space: target.space,
        app: target.app,
      }));
    }
  }

  return [];
}

export async function discoverDebugTarget(
  email: string,
  password: string,
): Promise<DebugTarget | undefined> {
  const targets = await discoverDebugTargets(email, password, 1);
  const first = targets[0];
  return first;
}

export async function discoverTwoDebugTargets(
  email: string,
  password: string,
): Promise<readonly DebugTarget[]> {
  return await discoverDebugTargets(email, password, 2);
}

export async function discoverThreeDebugTargets(
  email: string,
  password: string,
): Promise<readonly DebugTarget[]> {
  return await discoverDebugTargets(email, password, 3);
}
