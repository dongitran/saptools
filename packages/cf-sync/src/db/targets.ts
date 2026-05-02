import { getRegion } from "../config/regions.js";
import type { CfStructure, DbSyncTarget, DbTargetSelector, RegionKey } from "../types.js";
import { REGION_KEYS } from "../types.js";

function isRegionKey(value: string): value is RegionKey {
  return (REGION_KEYS as readonly string[]).includes(value);
}

export function formatDbSelector(
  regionKey: RegionKey,
  orgName: string,
  spaceName: string,
  appName: string,
): string {
  return `${regionKey}/${orgName}/${spaceName}/${appName}`;
}

export function collectDbTargets(structure: CfStructure): readonly DbSyncTarget[] {
  return structure.regions.flatMap((region) =>
    region.orgs.flatMap((org) =>
      org.spaces.flatMap((space) =>
        space.apps.map((app): DbSyncTarget => ({
          selector: formatDbSelector(region.key, org.name, space.name, app.name),
          regionKey: region.key,
          apiEndpoint: region.apiEndpoint,
          orgName: org.name,
          spaceName: space.name,
          appName: app.name,
        })),
      ),
    ),
  );
}

export function parseDbTargetSelector(raw: string): DbTargetSelector {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("DB app selector must not be empty");
  }

  const parts = trimmed.split("/").map((part) => part.trim());
  if (parts.length === 1) {
    return {
      type: "name",
      appName: parts[0] ?? trimmed,
    };
  }

  if (parts.length !== 4) {
    throw new Error(
      "DB app selector must be either `<app>` or `region/org/space/app`",
    );
  }

  const [regionKey, orgName, spaceName, appName] = parts;
  if (!regionKey || !orgName || !spaceName || !appName) {
    throw new Error(
      "DB app selector must be either `<app>` or `region/org/space/app`",
    );
  }

  if (!isRegionKey(regionKey)) {
    throw new Error(`Unknown region key: ${regionKey}`);
  }

  return {
    type: "explicit",
    regionKey,
    orgName,
    spaceName,
    appName,
    selector: formatDbSelector(regionKey, orgName, spaceName, appName),
  };
}

export function resolveDbTargetSelector(
  structure: CfStructure,
  raw: string,
): readonly DbSyncTarget[] {
  const selector = parseDbTargetSelector(raw);
  if (selector.type === "explicit") {
    return [
      {
        selector: selector.selector,
        regionKey: selector.regionKey,
        apiEndpoint: getRegion(selector.regionKey).apiEndpoint,
        orgName: selector.orgName,
        spaceName: selector.spaceName,
        appName: selector.appName,
      },
    ];
  }

  const candidates = collectDbTargets(structure).filter(
    (target) => target.appName === selector.appName,
  );
  if (candidates.length === 0) {
    throw new Error(`Could not find app "${selector.appName}" in the CF topology snapshot`);
  }

  if (candidates.length > 1) {
    const candidateText = candidates.map((target) => target.selector).join(", ");
    throw new Error(
      `App name "${selector.appName}" is ambiguous. Use one of: ${candidateText}`,
    );
  }

  const [candidate] = candidates;
  if (!candidate) {
    throw new Error(`Could not find app "${selector.appName}" in the CF topology snapshot`);
  }
  return [candidate];
}
