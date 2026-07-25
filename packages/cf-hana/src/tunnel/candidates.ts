import { parseCfAppsOutput } from "../cf.js";

const RUNNING_STATE = "started";
const VALID_APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isValidAppName(name: string): boolean {
  return VALID_APP_NAME.test(name);
}

function discoveredAppNames(stdout: string | undefined, targetAppName: string): readonly string[] {
  if (stdout === undefined) {
    return [];
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of parseCfAppsOutput(stdout)) {
    if (row.state !== RUNNING_STATE) {
      continue;
    }
    if (row.name === targetAppName || seen.has(row.name)) {
      continue;
    }
    if (!isValidAppName(row.name)) {
      continue;
    }
    seen.add(row.name);
    names.push(row.name);
  }
  return names;
}

/**
 * Orders jump-host candidates: the target app first (it is already a known,
 * resolved CF app, and its own container is the natural first guess), then
 * up to `maxCandidates` other started apps discovered via `cf apps`, deduped
 * and shape-validated so a CF API response can never smuggle an extra flag
 * or shell-adjacent token into a later spawn call.
 */
export function buildCandidateList(
  targetAppName: string,
  discoveredStdout: string | undefined,
  maxCandidates: number,
): readonly string[] {
  const discovered = discoveredAppNames(discoveredStdout, targetAppName);
  return [targetAppName, ...discovered.slice(0, maxCandidates)];
}
