import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { AppHanaEntry } from "./types.js";

// Fixed SQLTools fields common to all SAP HANA connections
const HANA_OPTIONS = {
  encrypt: true,
  sslValidateCertificate: true,
  sslCryptoProvider: "openssl",
} as const;

const CONNECTION_TIMEOUT = 30;
const PREVIEW_LIMIT = 50;
const DRIVER = "SAPHana";

export interface SqlToolsConnection {
  readonly connectionTimeout: number;
  readonly hanaOptions: { readonly encrypt: boolean; readonly sslValidateCertificate: boolean; readonly sslCryptoProvider: string };
  readonly previewLimit: number;
  readonly driver: string;
  readonly name: string;
  readonly server: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

// Convert one AppHanaEntry → one SQLTools connection object
export function toSqlToolsConnection(entry: AppHanaEntry): SqlToolsConnection {
  return {
    connectionTimeout: CONNECTION_TIMEOUT,
    hanaOptions: HANA_OPTIONS,
    previewLimit: PREVIEW_LIMIT,
    driver: DRIVER,
    // Name format: "app-name (region)" for easy identification
    name: `${entry.app} (${entry.region})`,
    server: entry.hana.host,
    port: parseInt(entry.hana.port, 10),
    username: entry.hana.user,
    password: entry.hana.password,
    database: entry.hana.schema,
  };
}

// Read existing .vscode/settings.json — returns {} if not found
async function readVscodeSettings(settingsPath: string): Promise<Record<string, unknown>> {
  if (!existsSync(settingsPath)) return {};

  const raw = await readFile(settingsPath, "utf-8");

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File exists but is malformed — preserve it by returning empty (will merge below)
    return {};
  }
}

// Write .vscode/settings.json — creates .vscode/ dir if needed
async function writeVscodeSettings(settingsPath: string, settings: Record<string, unknown>): Promise<void> {
  const vscodeDir = resolve(settingsPath, "..");

  if (!existsSync(vscodeDir)) {
    await mkdir(vscodeDir, { recursive: true });
  }

  await writeFile(settingsPath, JSON.stringify(settings, null, 4), "utf-8");
}

// Update sqltools.connections in .vscode/settings.json at the given workspaceRoot.
// Overwrites the entire connections array — all entries come from sap-cli output.
export async function updateVscodeConnections(
  entries: AppHanaEntry[],
  workspaceRoot?: string,
): Promise<string> {
  const root = workspaceRoot ?? process.cwd();
  const settingsPath = join(root, ".vscode", "settings.json");

  const existing = await readVscodeSettings(settingsPath);
  const connections = entries.map(toSqlToolsConnection);

  const updated: Record<string, unknown> = {
    ...existing,
    "sqltools.useNodeRuntime": true,
    "sqltools.connections": connections,
  };

  await writeVscodeSettings(settingsPath, updated);

  return settingsPath;
}
