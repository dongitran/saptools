import { getApiEndpointForRegion, readCurrentCfTarget } from "./cf.js";
import type { ResolvedSelector } from "./types.js";

export interface ParsedAppName {
  readonly kind: "appName";
  readonly appName: string;
}

export interface ParsedAppPath {
  readonly kind: "appPath";
  readonly regionKey: string;
  readonly orgName: string;
  readonly spaceName: string;
  readonly appName: string;
}

export interface ParsedSpacePath {
  readonly kind: "spacePath";
  readonly regionKey: string;
  readonly orgName: string;
  readonly spaceName: string;
}

export type ParsedSelector = ParsedAppName | ParsedAppPath | ParsedSpacePath;

const SELECTOR_USAGE = 'use "region/org/space", "region/org/space/app", or a bare app name';

function assertNonEmpty(raw: string, parts: readonly string[], shape: string): void {
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid selector "${raw}": every ${shape} segment must be non-empty.`);
  }
}

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

  if (parts.length === 3) {
    assertNonEmpty(raw, parts, "region/org/space");
    const [regionKey, orgName, spaceName] = parts;
    return { kind: "spacePath", regionKey: regionKey ?? "", orgName: orgName ?? "", spaceName: spaceName ?? "" };
  }

  if (parts.length === 4) {
    assertNonEmpty(raw, parts, "region/org/space/app");
    const [regionKey, orgName, spaceName, appName] = parts;
    return {
      kind: "appPath",
      regionKey: regionKey ?? "",
      orgName: orgName ?? "",
      spaceName: spaceName ?? "",
      appName: appName ?? "",
    };
  }

  throw new Error(`Invalid selector "${raw}": ${SELECTOR_USAGE}.`);
}

/**
 * Resolves a raw selector.
 * - Bare app name: based strictly on the CURRENT CF target (no global search).
 * - Explicit paths: use known region-to-api mapping; trust the provided org/space/app.
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
      kind: "app",
      raw,
      regionKey: current.regionKey ?? "",
      apiEndpoint: current.apiEndpoint,
      orgName: current.orgName,
      spaceName: current.spaceName,
      appName: parsed.appName,
    };
  }

  const apiEndpoint = getApiEndpointForRegion(parsed.regionKey);
  if (!apiEndpoint) {
    throw new Error(
      `Unknown region "${parsed.regionKey}". Use a bare app name (requires current CF target) or a known region key.`,
    );
  }

  if (parsed.kind === "spacePath") {
    return {
      kind: "space",
      raw,
      regionKey: parsed.regionKey,
      apiEndpoint,
      orgName: parsed.orgName,
      spaceName: parsed.spaceName,
    };
  }

  return {
    kind: "app",
    raw,
    regionKey: parsed.regionKey,
    apiEndpoint,
    orgName: parsed.orgName,
    spaceName: parsed.spaceName,
    appName: parsed.appName,
  };
}
