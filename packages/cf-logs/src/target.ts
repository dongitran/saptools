/* eslint import/order: "off" -- eslint-plugin-import 2.32 crashes on this file with ESLint 10 */
import { execFile } from "node:child_process";

import { regionKeyForApiEndpoint } from "./regions.js";

export interface CfExecContext {
  readonly command?: string;
}

export interface CurrentCfTarget {
  readonly apiEndpoint: string;
  readonly regionKey?: string;
  readonly orgName: string;
  readonly spaceName: string;
}

const CF_TARGET_TIMEOUT_MS = 30_000;
const CF_TARGET_MAX_BUFFER = 16 * 1024 * 1024;

export async function readCurrentCfTarget(
  context?: CfExecContext,
): Promise<CurrentCfTarget | undefined> {
  const resolved = resolveCfInvocation(context?.command);
  const { stdout } = await execFileAsync(resolved.bin, [...resolved.argsPrefix, "target"]);
  return parseCfTargetOutput(stdout);
}

export function parseCfTargetOutput(stdout: string): CurrentCfTarget | undefined {
  const fields = parseCfTargetFields(stdout);
  const apiEndpoint = fields.get("api endpoint");
  const orgName = fields.get("org");
  const spaceName = fields.get("space");
  if (
    apiEndpoint === undefined ||
    orgName === undefined ||
    spaceName === undefined ||
    apiEndpoint.length === 0 ||
    orgName.length === 0 ||
    spaceName.length === 0
  ) {
    return undefined;
  }

  const regionKey = regionKeyForApiEndpoint(apiEndpoint);
  return {
    apiEndpoint,
    ...(regionKey === undefined ? {} : { regionKey }),
    orgName,
    spaceName,
  };
}

function resolveCfBin(override?: string): string {
  return override ?? process.env["CF_LOGS_CF_BIN"] ?? "cf";
}

function isNodeScriptCommand(command: string): boolean {
  return /\.(?:c|m)?js$/i.test(command);
}

function resolveCfInvocation(command?: string): {
  readonly bin: string;
  readonly argsPrefix: readonly string[];
} {
  const resolvedBin = resolveCfBin(command);
  return isNodeScriptCommand(resolvedBin)
    ? { bin: process.execPath, argsPrefix: [resolvedBin] }
    : { bin: resolvedBin, argsPrefix: [] };
}

function execFileAsync(
  file: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      file,
      [...args],
      { maxBuffer: CF_TARGET_MAX_BUFFER, timeout: CF_TARGET_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error !== null) {
          const enriched = Object.assign(error, { stdout, stderr });
          rejectPromise(
            enriched instanceof Error ? enriched : new Error("cf target execution failed", { cause: error }),
          );
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

function parseCfTargetFields(stdout: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0 && value.length > 0) {
      fields.set(key, value);
    }
  }
  return fields;
}
