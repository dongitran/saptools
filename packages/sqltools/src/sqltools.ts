import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import type { AppHanaEntry, SqlToolsConnection, SqlToolsHanaOptions } from "./types.js";

export const HANA_OPTIONS: SqlToolsHanaOptions = {
  encrypt: true,
  sslValidateCertificate: true,
  sslCryptoProvider: "openssl",
};

export const CONNECTION_TIMEOUT = 30;
export const PREVIEW_LIMIT = 50;
export const DRIVER = "SAPHana";
export const VSCODE_SETTINGS_REL_PATH = ".vscode/settings.json";
export const SQLTOOLS_CONNECTIONS_KEY = "sqltools.connections";
export const SQLTOOLS_USE_NODE_RUNTIME_KEY = "sqltools.useNodeRuntime";

export function toSqlToolsConnection(entry: AppHanaEntry): SqlToolsConnection {
  const port = Number.parseInt(entry.hana.port, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid HANA port for app "${entry.app}": ${entry.hana.port}`);
  }
  return {
    name: `${entry.app} (${entry.region})`,
    driver: DRIVER,
    server: entry.hana.host,
    port,
    username: entry.hana.user,
    password: entry.hana.password,
    database: entry.hana.schema,
    connectionTimeout: CONNECTION_TIMEOUT,
    previewLimit: PREVIEW_LIMIT,
    hanaOptions: HANA_OPTIONS,
  };
}

async function readVscodeSettings(settingsPath: string): Promise<Record<string, unknown>> {
  if (!existsSync(settingsPath)) {
    return {};
  }
  const raw = await readFile(settingsPath, "utf-8");
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeVscodeSettings(
  settingsPath: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const vscodeDir = dirname(settingsPath);
  if (!existsSync(vscodeDir)) {
    await mkdir(vscodeDir, { recursive: true });
  }
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 4)}\n`, "utf-8");
}

export interface UpdateVscodeConnectionsOptions {
  readonly workspaceRoot?: string;
  readonly merge?: boolean;
}

export interface UpdateVscodeConnectionsResult {
  readonly settingsPath: string;
  readonly connectionCount: number;
}

export async function updateVscodeConnections(
  entries: readonly AppHanaEntry[],
  options: UpdateVscodeConnectionsOptions = {},
): Promise<UpdateVscodeConnectionsResult> {
  const root = options.workspaceRoot ?? process.cwd();
  const settingsPath = join(root, VSCODE_SETTINGS_REL_PATH);
  const existing = await readVscodeSettings(settingsPath);
  const incoming = entries.map((entry) => toSqlToolsConnection(entry));

  let connections: readonly SqlToolsConnection[];
  if (options.merge === true) {
    const existingConnections = readExistingConnections(existing);
    connections = mergeConnectionsByName(existingConnections, incoming);
  } else {
    connections = incoming;
  }

  const updated: Record<string, unknown> = {
    ...existing,
    [SQLTOOLS_USE_NODE_RUNTIME_KEY]: true,
    [SQLTOOLS_CONNECTIONS_KEY]: connections,
  };

  await writeVscodeSettings(settingsPath, updated);
  return { settingsPath, connectionCount: connections.length };
}

function readExistingConnections(
  existing: Record<string, unknown>,
): readonly SqlToolsConnection[] {
  const raw = existing[SQLTOOLS_CONNECTIONS_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((value): value is SqlToolsConnection => {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const obj = value as Record<string, unknown>;
    return typeof obj["name"] === "string";
  });
}

function mergeConnectionsByName(
  existing: readonly SqlToolsConnection[],
  incoming: readonly SqlToolsConnection[],
): readonly SqlToolsConnection[] {
  const incomingNames = new Set(incoming.map((c) => c.name));
  const kept = existing.filter((c) => !incomingNames.has(c.name));
  return [...kept, ...incoming];
}
