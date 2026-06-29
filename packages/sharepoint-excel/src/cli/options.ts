import type { Command } from "commander";

import type { RuntimeOverrides } from "../config/resolve.js";

export interface CommonFlags extends RuntimeOverrides {
  readonly json?: boolean;
}

export interface ConfigSetFlags {
  readonly profile?: string;
  readonly tenant?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly site?: string;
  readonly drive?: string;
  readonly store?: string;
  readonly allowPlaintextSecret?: boolean;
  readonly json?: boolean;
}

export interface ConfigGetFlags {
  readonly profile?: string;
  readonly json?: boolean;
}

export interface CreateFlags extends CommonFlags {
  readonly drive?: string;
  readonly path?: string;
  readonly sheet?: string;
  readonly headers?: string;
  readonly rows?: string;
  readonly table?: string;
}

export interface ReadFlags extends CommonFlags {
  readonly drive?: string;
  readonly path?: string;
  readonly sheet?: string;
  readonly range?: string;
}

export interface AppendFlags extends CommonFlags {
  readonly drive?: string;
  readonly path?: string;
  readonly sheet?: string;
  readonly record?: string;
  readonly matchHeader?: boolean;
}

export interface UpdateCellFlags extends CommonFlags {
  readonly drive?: string;
  readonly path?: string;
  readonly sheet?: string;
  readonly cell?: string;
  readonly value?: string;
}

export interface AddSheetFlags extends CommonFlags {
  readonly drive?: string;
  readonly path?: string;
  readonly sheet?: string;
  readonly headers?: string;
}

export function addCommonOptions(cmd: Command): Command {
  return cmd
    .option("--profile <name>", "Stored profile name")
    .option("--tenant <id>", "Azure AD tenant ID")
    .option("--client-id <id>", "App registration client ID")
    .option("--client-secret <secret>", "App registration client secret")
    .option("--site <ref>", "SharePoint site, e.g. contoso.sharepoint.com/sites/demo")
    .option("--drive <nameOrId>", "Document library name or ID")
    .option("--json", "Emit JSON output", false);
}

export function toRuntimeOverrides(flags: CommonFlags): RuntimeOverrides {
  return {
    profile: flags.profile,
    tenant: flags.tenant,
    clientId: flags.clientId,
    clientSecret: flags.clientSecret,
    site: flags.site,
    drive: flags.drive,
  };
}

export function requireFlag(value: string | undefined, flagName: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${flagName} is required`);
  }
  return value;
}
