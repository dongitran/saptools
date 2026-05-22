import { readStructure } from "@saptools/cf-sync";
import type { CfStructure } from "@saptools/cf-sync";

import type { ResolvedSelector } from "./types.js";

export interface ParsedAppName {
  readonly kind: "appName";
  readonly appName: string;
}

export interface ParsedExplicit {
  readonly kind: "explicit";
  readonly regionKey: string;
  readonly orgName: string;
  readonly spaceName: string;
  readonly appName: string;
}

export type ParsedSelector = ParsedAppName | ParsedExplicit;

const SELECTOR_USAGE = 'use "region/org/space/app" or a bare app name';

/** Parses a raw selector string into its structural parts without any I/O. */
export function parseSelector(raw: string): ParsedSelector {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`A selector is required: ${SELECTOR_USAGE}.`);
  }

  const parts = trimmed.split("/").map((part) => part.trim());

  if (parts.length === 1) {
    const appName = parts[0] ?? "";
    if (appName.length === 0) {
      throw new Error(`A selector is required: ${SELECTOR_USAGE}.`);
    }
    return { kind: "appName", appName };
  }

  if (parts.length === 4) {
    const [regionKey, orgName, spaceName, appName] = parts;
    if (
      regionKey === undefined ||
      orgName === undefined ||
      spaceName === undefined ||
      appName === undefined ||
      regionKey.length === 0 ||
      orgName.length === 0 ||
      spaceName.length === 0 ||
      appName.length === 0
    ) {
      throw new Error(`Invalid selector "${raw}": every region/org/space/app segment must be non-empty.`);
    }
    return { kind: "explicit", regionKey, orgName, spaceName, appName };
  }

  throw new Error(`Invalid selector "${raw}": ${SELECTOR_USAGE}.`);
}

function resolveExplicit(
  raw: string,
  parsed: ParsedExplicit,
  structure: CfStructure,
): ResolvedSelector {
  const region = structure.regions.find((entry) => entry.key === parsed.regionKey);
  if (region === undefined) {
    throw new Error(
      `Region "${parsed.regionKey}" is not in the CF topology snapshot. ` +
        "Run `cf-sync sync` first (or `cf-sync regions` to list valid region keys).",
    );
  }

  const org = region.orgs.find((entry) => entry.name === parsed.orgName);
  if (org === undefined) {
    throw new Error(
      `Org "${parsed.orgName}" was not found in region ${parsed.regionKey}. ` +
        `Run \`cf-sync orgs ${parsed.regionKey}\` to refresh it.`,
    );
  }

  const space = org.spaces.find((entry) => entry.name === parsed.spaceName);
  if (space === undefined) {
    throw new Error(
      `Space "${parsed.spaceName}" was not found in ${parsed.regionKey}/${parsed.orgName}. ` +
        `Run \`cf-sync org ${parsed.regionKey} ${parsed.orgName}\` to refresh it.`,
    );
  }

  const app = space.apps.find((entry) => entry.name === parsed.appName);
  if (app === undefined) {
    throw new Error(
      `App "${parsed.appName}" was not found in ${parsed.regionKey}/${parsed.orgName}/${parsed.spaceName}. ` +
        `Run \`cf-sync space ${parsed.regionKey} ${parsed.orgName} ${parsed.spaceName}\` to refresh it.`,
    );
  }

  return {
    raw,
    regionKey: region.key,
    apiEndpoint: region.apiEndpoint,
    orgName: org.name,
    spaceName: space.name,
    appName: app.name,
  };
}

function resolveByAppName(raw: string, appName: string, structure: CfStructure): ResolvedSelector {
  const matches: ResolvedSelector[] = [];
  for (const region of structure.regions) {
    for (const org of region.orgs) {
      for (const space of org.spaces) {
        for (const app of space.apps) {
          if (app.name === appName) {
            matches.push({
              raw,
              regionKey: region.key,
              apiEndpoint: region.apiEndpoint,
              orgName: org.name,
              spaceName: space.name,
              appName: app.name,
            });
          }
        }
      }
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `App "${appName}" was not found in the CF topology snapshot. ` +
        "Run `cf-sync sync` first, or pass a full region/org/space/app selector.",
    );
  }

  if (matches.length > 1) {
    const candidates = matches
      .map((match) => `  ${match.regionKey}/${match.orgName}/${match.spaceName}/${match.appName}`)
      .join("\n");
    throw new Error(
      `App "${appName}" is ambiguous - it exists in multiple spaces:\n${candidates}\n` +
        "Pass a full region/org/space/app selector to disambiguate.",
    );
  }

  const onlyMatch = matches[0];
  if (onlyMatch === undefined) {
    throw new Error(`App "${appName}" could not be resolved.`);
  }
  return onlyMatch;
}

/**
 * Resolves a raw selector against the cf-sync topology snapshot, validating
 * that the region/org/space/app exists and resolving a bare app name to a
 * unique full path.
 */
export async function resolveSelector(raw: string): Promise<ResolvedSelector> {
  const parsed = parseSelector(raw);
  const structure = await readStructure();
  if (structure === undefined) {
    throw new Error(
      "No CF topology snapshot found. Run `cf-sync sync` (or `cf-sync space ...`) first.",
    );
  }

  if (parsed.kind === "explicit") {
    return resolveExplicit(raw, parsed, structure);
  }
  return resolveByAppName(raw, parsed.appName, structure);
}
