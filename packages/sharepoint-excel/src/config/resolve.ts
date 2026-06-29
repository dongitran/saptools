import process from "node:process";

import type { ProfileStore } from "../credentials/profile-store.js";
import { createProfileStore, findProfile } from "../credentials/profile-store.js";
import type { SecretVault } from "../credentials/secret-vault.js";
import { createFileSecretVault, createKeyringSecretVault } from "../credentials/secret-vault.js";
import { parseSiteRef } from "../graph/site.js";
import type { SecretStoreKind, SharePointTarget, StoredProfile } from "../types.js";
import {
  DEFAULT_PROFILE_NAME,
  ENV_CLIENT_ID,
  ENV_CLIENT_SECRET,
  ENV_DRIVE,
  ENV_PROFILE,
  ENV_SITE,
  ENV_TENANT,
  FALLBACK_ENV_CLIENT_ID,
  FALLBACK_ENV_CLIENT_SECRET,
  FALLBACK_ENV_DRIVE,
  FALLBACK_ENV_SITE,
  FALLBACK_ENV_TENANT,
} from "../types.js";

export interface RuntimeOverrides {
  readonly profile?: string | undefined;
  readonly tenant?: string | undefined;
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
  readonly site?: string | undefined;
  readonly drive?: string | undefined;
}

export interface ResolveRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly overrides?: RuntimeOverrides;
  readonly profileStore?: ProfileStore;
  readonly keyringVault?: SecretVault;
  readonly fileVault?: SecretVault;
}

export interface ResolvedRuntime {
  readonly target: SharePointTarget;
  readonly drive?: string;
  readonly profileName: string;
  readonly source: "profile" | "env";
}

function pickEnv(env: NodeJS.ProcessEnv, primary: string, fallback: string): string | undefined {
  const value = env[primary] ?? env[fallback];
  return value === undefined || value.length === 0 ? undefined : value;
}

function pickValue(
  override: string | undefined,
  envValue: string | undefined,
  profileValue: string | undefined,
): string | undefined {
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return envValue ?? profileValue;
}

function vaultForProfile(
  profile: StoredProfile | undefined,
  options: ResolveRuntimeOptions,
): SecretVault {
  if (profile?.secretStore === "file") {
    return options.fileVault ?? createFileSecretVault();
  }
  return options.keyringVault ?? createKeyringSecretVault();
}

async function resolveClientSecret(
  override: string | undefined,
  envValue: string | undefined,
  profile: StoredProfile | undefined,
  options: ResolveRuntimeOptions,
): Promise<string | undefined> {
  if (override !== undefined && override.length > 0) {
    return override;
  }
  if (envValue !== undefined) {
    return envValue;
  }
  return profile === undefined ? undefined : await vaultForProfile(profile, options).getSecret(profile.name);
}

function requireValue(value: string | undefined, humanName: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${humanName} is required (pass a flag, set env, or run config set)`);
  }
  return value;
}

export async function resolveRuntime(options: ResolveRuntimeOptions = {}): Promise<ResolvedRuntime> {
  const env = options.env ?? process.env;
  const overrides = options.overrides ?? {};
  const profileName =
    overrides.profile ?? env[ENV_PROFILE] ?? DEFAULT_PROFILE_NAME;
  const store = options.profileStore ?? createProfileStore();
  const profile = findProfile(await store.readProfiles(), profileName);

  const tenantId = pickValue(
    overrides.tenant,
    pickEnv(env, ENV_TENANT, FALLBACK_ENV_TENANT),
    profile?.tenantId,
  );
  const clientId = pickValue(
    overrides.clientId,
    pickEnv(env, ENV_CLIENT_ID, FALLBACK_ENV_CLIENT_ID),
    profile?.clientId,
  );
  const site = pickValue(overrides.site, pickEnv(env, ENV_SITE, FALLBACK_ENV_SITE), profile?.site);
  const drive = pickValue(overrides.drive, pickEnv(env, ENV_DRIVE, FALLBACK_ENV_DRIVE), profile?.drive);
  const clientSecret = await resolveClientSecret(
    overrides.clientSecret,
    pickEnv(env, ENV_CLIENT_SECRET, FALLBACK_ENV_CLIENT_SECRET),
    profile,
    options,
  );

  return {
    target: {
      credentials: {
        tenantId: requireValue(tenantId, "Tenant ID"),
        clientId: requireValue(clientId, "Client ID"),
        clientSecret: requireValue(clientSecret, "Client secret"),
      },
      site: parseSiteRef(requireValue(site, "SharePoint site")),
    },
    ...(drive === undefined ? {} : { drive }),
    profileName,
    source: profile === undefined ? "env" : "profile",
  };
}

export function parseSecretStoreKind(value: string | undefined): SecretStoreKind {
  if (value === undefined || value === "keyring") {
    return "keyring";
  }
  if (value === "file") {
    return "file";
  }
  throw new Error(`Invalid secret store "${value}". Expected keyring or file`);
}
