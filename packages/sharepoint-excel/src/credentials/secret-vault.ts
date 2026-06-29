import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Entry } from "@napi-rs/keyring";

import { fileSecretsPath } from "../config/paths.js";

export interface SecretVault {
  getSecret: (profileName: string) => Promise<string | undefined>;
  setSecret: (profileName: string, secret: string) => Promise<void>;
  deleteSecret: (profileName: string) => Promise<void>;
}

interface SecretFile {
  readonly version: 1;
  readonly entries: Readonly<Record<string, string>>;
}

const SERVICE_NAME = "saptools-sharepoint-excel";
const SECRET_FILE_MODE = 0o600;
const EMPTY_SECRET_FILE: SecretFile = { version: 1, entries: {} };

function isMissingFileError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

async function readSecretFile(path: string): Promise<SecretFile> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { readonly version?: unknown; readonly entries?: unknown };
    if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
      return EMPTY_SECRET_FILE;
    }
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (typeof value === "string") {
        entries[key] = value;
      }
    }
    return { version: 1, entries };
  } catch (err) {
    if (isMissingFileError(err)) {
      return EMPTY_SECRET_FILE;
    }
    throw err;
  }
}

async function writeSecretFile(path: string, value: SecretFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: SECRET_FILE_MODE,
  });
  await chmod(path, SECRET_FILE_MODE);
}

export function createKeyringSecretVault(serviceName = SERVICE_NAME): SecretVault {
  return {
    getSecret(profileName: string): Promise<string | undefined> {
      const password = new Entry(serviceName, profileName).getPassword();
      return Promise.resolve(password === null || password.length === 0 ? undefined : password);
    },
    setSecret(profileName: string, secret: string): Promise<void> {
      new Entry(serviceName, profileName).setPassword(secret);
      return Promise.resolve();
    },
    deleteSecret(profileName: string): Promise<void> {
      try {
        new Entry(serviceName, profileName).deletePassword();
      } catch (err) {
        if (err instanceof Error && /not found|no entry|missing/i.test(err.message)) {
          return Promise.resolve();
        }
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return Promise.resolve();
    },
  };
}

export function createFileSecretVault(path = fileSecretsPath()): SecretVault {
  return {
    async getSecret(profileName: string): Promise<string | undefined> {
      const file = await readSecretFile(path);
      return file.entries[profileName];
    },
    async setSecret(profileName: string, secret: string): Promise<void> {
      const file = await readSecretFile(path);
      await writeSecretFile(path, {
        version: 1,
        entries: { ...file.entries, [profileName]: secret },
      });
    },
    async deleteSecret(profileName: string): Promise<void> {
      const file = await readSecretFile(path);
      const remaining = Object.fromEntries(
        Object.entries(file.entries).filter(([entryName]) => entryName !== profileName),
      );
      await writeSecretFile(path, { version: 1, entries: remaining });
    },
  };
}
