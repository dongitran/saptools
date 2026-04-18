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

export async function discoverDebugTarget(
  email: string,
  password: string,
): Promise<DebugTarget | undefined> {
  const regions = candidateRegions();
  const discovered: ScoredTarget[] = [];

  for (const regionKey of regions) {
    const apiEndpoint = resolveApiEndpoint(regionKey);
    const target = await withIsolatedCfHome(async ({ env }) => {
      const authenticated = await loginTo(apiEndpoint, email, password, env);
      if (!authenticated) {
        return undefined;
      }
      let orgs: readonly string[];
      try {
        const { stdout } = await cfExec(["orgs"], env);
        orgs = parseOrgs(stdout);
      } catch {
        return undefined;
      }
      if (orgs.length === 0) {
        return undefined;
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
            const apps = parseApps(stdout);
            const running = apps.filter(
              (a) => a.state === "started" && a.runningInstances > 0,
            );
            if (running.length === 0) {
              continue;
            }
            const pick = running[0];
            if (pick === undefined) {
              continue;
            }
            return {
              regionKey,
              apiEndpoint,
              org,
              space,
              app: pick.name,
              appState: pick.state,
              runningInstances: pick.runningInstances,
            } satisfies ScoredTarget;
          } catch {
            continue;
          }
        }
      }
      return undefined;
    });

    if (target !== undefined) {
      discovered.push(target);
      break;
    }
  }

  const first = discovered[0];
  if (first === undefined) {
    return undefined;
  }
  return {
    regionKey: first.regionKey,
    apiEndpoint: first.apiEndpoint,
    org: first.org,
    space: first.space,
    app: first.app,
  };
}

export async function discoverTwoDebugTargets(
  email: string,
  password: string,
): Promise<readonly DebugTarget[]> {
  const regions = candidateRegions();

  for (const regionKey of regions) {
    const apiEndpoint = resolveApiEndpoint(regionKey);
    const targets = await withIsolatedCfHome(async ({ env }) => {
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
            const apps = parseApps(stdout);
            const running = apps
              .filter((a) => a.state === "started" && a.runningInstances > 0)
              .slice(0, 2);
            if (running.length >= 2) {
              return running.map((row) => ({
                regionKey,
                apiEndpoint,
                org,
                space,
                app: row.name,
              } satisfies DebugTarget));
            }
          } catch {
            continue;
          }
        }
      }
      return [];
    });

    if (targets.length >= 2) {
      return targets;
    }
  }

  return [];
}
