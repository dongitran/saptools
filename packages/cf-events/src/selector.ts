import { getApiEndpointForRegion, readCurrentCfTarget } from "./cf.js";
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

/**
 * Resolves a raw selector.
 * - Bare app name: based strictly on the CURRENT CF target (no global search).
 * - Full path: uses known region-to-api mapping; trusts the provided org/space/app (no snapshot validation).
 */
export async function resolveSelector(raw: string): Promise<ResolvedSelector> {
  const parsed = parseSelector(raw);

  if (parsed.kind === "appName") {
    const current = await readCurrentCfTarget();
    if (!current) {
      throw new Error(
        "No current CF target found. Run `cf target -o <org> -s <space>` or pass a full region/org/space/app selector.",
      );
    }
    return {
      raw,
      regionKey: current.regionKey ?? "",
      apiEndpoint: current.apiEndpoint,
      orgName: current.orgName,
      spaceName: current.spaceName,
      appName: parsed.appName,
    };
  }

  // explicit full path
  const apiEndpoint = getApiEndpointForRegion(parsed.regionKey);
  if (!apiEndpoint) {
    throw new Error(
      `Unknown region "${parsed.regionKey}". Use a bare app name (requires current CF target) or a known region key.`,
    );
  }

  return {
    raw,
    regionKey: parsed.regionKey,
    apiEndpoint,
    orgName: parsed.orgName,
    spaceName: parsed.spaceName,
    appName: parsed.appName,
  };
}
