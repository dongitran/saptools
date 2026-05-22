import { cfApi, cfAuth, cfEnv, cfTargetSpace } from "../cf/index.js";
import { withCfSession } from "../cf/session.js";
import type { AppDbBinding, RegionKey } from "../types.js";

import { extractHanaBindingsFromCfEnv } from "./parser.js";
import { resolveDbSyncTargetsFromCurrentTopology } from "./sync.js";

export interface FetchAppDbBindingsOptions {
  /** Either a bare `<app>` name or an explicit `region/org/space/app` selector. */
  readonly selector: string;
  readonly email: string;
  readonly password: string;
}

export interface FetchAppDbBindingsResult {
  readonly selector: string;
  readonly regionKey: RegionKey;
  readonly orgName: string;
  readonly spaceName: string;
  readonly appName: string;
  readonly bindings: readonly AppDbBinding[];
}

/**
 * Fetch one CF app's HANA service bindings on demand, WITHOUT persisting anything
 * under `~/.saptools/`. Unlike `runDbSync`, this writes no snapshot, lock, or
 * history file — it is a read-only, side-effect-free credential fetch.
 *
 * A bare app name is resolved against the cached topology snapshot; an explicit
 * `region/org/space/app` selector works without any topology snapshot.
 */
export async function fetchAppDbBindings(
  options: FetchAppDbBindingsOptions,
): Promise<FetchAppDbBindingsResult> {
  const selector = options.selector.trim();
  if (selector.length === 0) {
    throw new Error("A DB app selector is required to fetch HANA bindings");
  }

  const targets = await resolveDbSyncTargetsFromCurrentTopology(selector);
  const target = targets[0];
  if (target === undefined) {
    throw new Error(`Could not resolve a CF app for selector "${selector}"`);
  }

  const bindings = await withCfSession(async (context) => {
    await cfApi(target.apiEndpoint, context);
    await cfAuth(options.email, options.password, context);
    await cfTargetSpace(target.orgName, target.spaceName, context);
    const stdout = await cfEnv(target.appName, context);
    return extractHanaBindingsFromCfEnv(stdout);
  });

  return {
    selector: target.selector,
    regionKey: target.regionKey,
    orgName: target.orgName,
    spaceName: target.spaceName,
    appName: target.appName,
    bindings,
  };
}
