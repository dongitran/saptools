import process from "node:process";

import { REGION_KEYS, cfStructurePath, runSync } from "@saptools/cf-sync";
import type { RegionKey, SyncOptions, SyncResult } from "@saptools/cf-sync";

export interface SyncCommandOptions {
  readonly verbose?: boolean;
  readonly interactive?: boolean;
  readonly only?: string;
}

type RunSyncFn = (options: SyncOptions) => Promise<SyncResult>;

export interface SyncCommandDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdoutIsTTY?: boolean;
  readonly runSync?: RunSyncFn;
  readonly writeStdout?: (message: string) => void;
}

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function parseOnlyRegions(raw: string): readonly RegionKey[] {
  const requested = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (requested.length === 0) {
    throw new Error("--only must list at least one region key");
  }

  const allowed = new Set<string>(REGION_KEYS);
  const invalid = requested.filter((value) => !allowed.has(value));
  if (invalid.length > 0) {
    throw new Error(`Unknown region key(s): ${invalid.join(", ")}. Allowed: ${REGION_KEYS.join(", ")}`);
  }

  return requested as readonly RegionKey[];
}

function resolveInteractive(options: SyncCommandOptions, env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): boolean {
  return options.interactive !== false && stdoutIsTTY && env["CI"] !== "true";
}

function writeSummary(result: SyncResult, writeStdout: (message: string) => void): void {
  writeStdout(
    `✔ Structure written to ${cfStructurePath()}\n` +
      `  Accessible regions: ${result.accessibleRegions.length.toString()}\n` +
      `  Inaccessible regions: ${result.inaccessibleRegions.length.toString()}\n`,
  );
}

function defaultWriteStdout(message: string): void {
  process.stdout.write(message);
}

export async function runSyncCommand(
  options: SyncCommandOptions,
  deps: SyncCommandDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const onlyRegions = options.only ? parseOnlyRegions(options.only) : undefined;
  const result = await (deps.runSync ?? runSync)({
    email: requireEnv("SAP_EMAIL", env),
    password: requireEnv("SAP_PASSWORD", env),
    verbose: options.verbose ?? false,
    interactive: resolveInteractive(options, env, deps.stdoutIsTTY ?? process.stdout.isTTY),
    ...(onlyRegions ? { onlyRegions } : {}),
  });

  writeSummary(result, deps.writeStdout ?? defaultWriteStdout);
}
