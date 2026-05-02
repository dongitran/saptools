import process from "node:process";

import { parseSiteRef } from "../graph/sites.js";
import type { SharePointCredentials, SharePointSiteRef, SharePointTarget } from "../types.js";
import {
  ENV_CLIENT_ID,
  ENV_CLIENT_SECRET,
  ENV_ROOT,
  ENV_SITE,
  ENV_SUBDIRS,
  ENV_TENANT,
} from "../types.js";

export interface ConfigOverrides {
  readonly tenant?: string | undefined;
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
  readonly site?: string | undefined;
  readonly root?: string | undefined;
  readonly subdirs?: string | undefined;
}

export interface ResolvedConfig {
  readonly target: SharePointTarget;
  readonly rootPath: string;
  readonly subdirectories: readonly string[];
}

function pickValue(
  override: string | undefined,
  envName: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const value = env[envName];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function requireValue(
  override: string | undefined,
  envName: string,
  env: NodeJS.ProcessEnv,
  humanName: string,
): string {
  const value = pickValue(override, envName, env);
  if (value === undefined) {
    throw new Error(`${humanName} is required (pass flag or set ${envName})`);
  }
  return value;
}

function parseSubdirs(value: string | undefined): readonly string[] {
  if (value === undefined || value.length === 0) {
    return [];
  }

  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export interface ResolveConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly overrides?: ConfigOverrides;
  readonly requireRoot?: boolean;
}

export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  const overrides = options.overrides ?? {};

  const credentials: SharePointCredentials = {
    tenantId: requireValue(overrides.tenant, ENV_TENANT, env, "Tenant ID"),
    clientId: requireValue(overrides.clientId, ENV_CLIENT_ID, env, "Client ID"),
    clientSecret: requireValue(overrides.clientSecret, ENV_CLIENT_SECRET, env, "Client secret"),
  };

  const siteInput = requireValue(overrides.site, ENV_SITE, env, "Site reference");
  const site: SharePointSiteRef = parseSiteRef(siteInput);

  const rootRaw = pickValue(overrides.root, ENV_ROOT, env);
  if (options.requireRoot === true && rootRaw === undefined) {
    throw new Error(`Root directory is required (pass --root or set ${ENV_ROOT})`);
  }
  const rootPath = (rootRaw ?? "").replace(/^\/+|\/+$/g, "");
  const subdirectories = parseSubdirs(pickValue(overrides.subdirs, ENV_SUBDIRS, env));

  return {
    target: { credentials, site },
    rootPath,
    subdirectories,
  };
}
