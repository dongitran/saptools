import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { profilesPath } from "../config/paths.js";
import type { RedactedProfile, SecretStoreKind, StoredProfile } from "../types.js";
import { DEFAULT_PROFILE_NAME } from "../types.js";

import type { SecretVault } from "./secret-vault.js";

interface ProfileFile {
  readonly version: 1;
  readonly profiles: readonly StoredProfile[];
}

export interface ProfileStore {
  readProfiles: () => Promise<readonly StoredProfile[]>;
  writeProfiles: (profiles: readonly StoredProfile[]) => Promise<void>;
}

export interface UpsertProfileInput {
  readonly name?: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly site: string;
  readonly drive?: string;
  readonly secretStore: SecretStoreKind;
  readonly updatedAt?: Date;
}

const PROFILE_FILE_MODE = 0o600;
const EMPTY_PROFILE_FILE: ProfileFile = { version: 1, profiles: [] };

function isMissingFileError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function isSecretStoreKind(value: unknown): value is SecretStoreKind {
  return value === "keyring" || value === "file";
}

function toStoredProfile(value: unknown): StoredProfile | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const name = raw["name"];
  const tenantId = raw["tenantId"];
  const clientId = raw["clientId"];
  const site = raw["site"];
  const drive = raw["drive"];
  const secretStore = raw["secretStore"];
  const updatedAt = raw["updatedAt"];
  if (
    typeof name !== "string" ||
    typeof tenantId !== "string" ||
    typeof clientId !== "string" ||
    typeof site !== "string" ||
    typeof updatedAt !== "string" ||
    !isSecretStoreKind(secretStore)
  ) {
    return undefined;
  }
  return {
    name,
    tenantId,
    clientId,
    site,
    ...(typeof drive === "string" ? { drive } : {}),
    secretStore,
    updatedAt,
  };
}

function isStoredProfile(value: StoredProfile | undefined): value is StoredProfile {
  return value !== undefined;
}

async function readProfileFile(path: string): Promise<ProfileFile> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { readonly version?: unknown; readonly profiles?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
      return EMPTY_PROFILE_FILE;
    }
    return { version: 1, profiles: parsed.profiles.map(toStoredProfile).filter(isStoredProfile) };
  } catch (err) {
    if (isMissingFileError(err)) {
      return EMPTY_PROFILE_FILE;
    }
    throw err;
  }
}

async function writeProfileFile(path: string, value: ProfileFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: PROFILE_FILE_MODE,
  });
  await chmod(path, PROFILE_FILE_MODE);
}

export function createProfileStore(path = profilesPath()): ProfileStore {
  return {
    async readProfiles(): Promise<readonly StoredProfile[]> {
      return (await readProfileFile(path)).profiles;
    },
    async writeProfiles(profiles: readonly StoredProfile[]): Promise<void> {
      await writeProfileFile(path, { version: 1, profiles });
    },
  };
}

export function findProfile(
  profiles: readonly StoredProfile[],
  name = DEFAULT_PROFILE_NAME,
): StoredProfile | undefined {
  return profiles.find((profile) => profile.name === name);
}

export async function upsertProfile(
  store: ProfileStore,
  vault: SecretVault,
  input: UpsertProfileInput,
): Promise<StoredProfile> {
  const name = input.name ?? DEFAULT_PROFILE_NAME;
  const stored: StoredProfile = {
    name,
    tenantId: input.tenantId,
    clientId: input.clientId,
    site: input.site,
    ...(input.drive === undefined || input.drive.length === 0 ? {} : { drive: input.drive }),
    secretStore: input.secretStore,
    updatedAt: (input.updatedAt ?? new Date()).toISOString(),
  };
  const profiles = await store.readProfiles();
  const nextProfiles = profiles.some((profile) => profile.name === name)
    ? profiles.map((profile) => (profile.name === name ? stored : profile))
    : [...profiles, stored];
  await vault.setSecret(name, input.clientSecret);
  await store.writeProfiles(nextProfiles);
  return stored;
}

export async function removeProfile(
  store: ProfileStore,
  vault: SecretVault,
  name = DEFAULT_PROFILE_NAME,
): Promise<boolean> {
  const profiles = await store.readProfiles();
  const nextProfiles = profiles.filter((profile) => profile.name !== name);
  await vault.deleteSecret(name);
  if (nextProfiles.length === profiles.length) {
    return false;
  }
  await store.writeProfiles(nextProfiles);
  return true;
}

export async function redactProfile(
  profile: StoredProfile,
  vault: SecretVault,
): Promise<RedactedProfile> {
  const secret = await vault.getSecret(profile.name);
  return {
    ...profile,
    clientId: `${profile.clientId.slice(0, 4)}...${profile.clientId.slice(-4)}`,
    hasClientSecret: secret !== undefined,
  };
}
