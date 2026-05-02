import type { Command } from "commander";

import type { ConfigOverrides } from "../config/index.js";

export interface CommonFlags extends ConfigOverrides {
  readonly json?: boolean;
}

export interface TreeFlags extends CommonFlags {
  readonly drive?: string;
  readonly depth?: string;
}

export interface ValidateFlags extends CommonFlags {
  readonly drive?: string;
}

export interface WriteTestFlags extends CommonFlags {
  readonly drive?: string;
}

export interface CheckFlags extends ValidateFlags {
  readonly subdirs?: string;
}

export function addCommonOptions(cmd: Command): Command {
  return cmd
    .option("--tenant <id>", "Azure AD tenant ID (overrides SHAREPOINT_TENANT_ID)")
    .option("--client-id <id>", "App registration client ID (overrides SHAREPOINT_CLIENT_ID)")
    .option(
      "--client-secret <secret>",
      "App registration client secret (overrides SHAREPOINT_CLIENT_SECRET)",
    )
    .option(
      "--site <ref>",
      "SharePoint site (e.g. contoso.sharepoint.com/sites/demo or full URL)",
    )
    .option("--json", "Emit JSON instead of human-readable output", false);
}

export function toOverrides(flags: CommonFlags): ConfigOverrides {
  return {
    tenant: flags.tenant,
    clientId: flags.clientId,
    clientSecret: flags.clientSecret,
    site: flags.site,
    root: flags.root,
    subdirs: flags.subdirs,
  };
}

export function parseDepth(rawDepth: string | undefined): number | undefined {
  const normalized = rawDepth?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid --depth "${normalized}"`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid --depth "${normalized}"`);
  }

  return parsed;
}
