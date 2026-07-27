import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import nodeProcess from "node:process";
import { promisify } from "node:util";

import { CfDebuggerError } from "../types.js";

const execFileAsync = promisify(execFile);

export type ProcessIdentityVerdict = "match" | "mismatch" | "unavailable";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

export function parseLinuxProcessStartTime(statLine: string): string | undefined {
  const commandEnd = statLine.lastIndexOf(")");
  if (commandEnd < 0) {
    return undefined;
  }
  const fieldsAfterCommand = statLine.slice(commandEnd + 1).trim().split(/\s+/);
  // The tail begins at proc(5) field 3, so field 22 (starttime) is index 19.
  const startTime = fieldsAfterCommand[19];
  return startTime !== undefined && /^\d+$/.test(startTime) ? startTime : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CfDebuggerError("ABORTED", "Process identity inspection was aborted.");
  }
}

async function linuxProcessIdentity(
  pid: number,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const statLine = await readFile(`/proc/${pid.toString()}/stat`, {
      encoding: "utf8",
      ...(signal === undefined ? {} : { signal }),
    });
    const startTime = parseLinuxProcessStartTime(statLine);
    return startTime === undefined ? undefined : `linux:${startTime}`;
  } catch (error: unknown) {
    throwIfAborted(signal);
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

async function darwinProcessIdentity(
  pid: number,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", pid.toString(), "-o", "lstart="], {
      ...(signal === undefined ? {} : { signal }),
      timeout: 2_000,
    });
    const startedAt = stdout.trim();
    return startedAt.length === 0 ? undefined : `darwin:${startedAt}`;
  } catch {
    throwIfAborted(signal);
    return undefined;
  }
}

export async function readProcessIdentity(
  pid: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (nodeProcess.platform === "linux") {
    return await linuxProcessIdentity(pid, signal);
  }
  if (nodeProcess.platform === "darwin") {
    return await darwinProcessIdentity(pid, signal);
  }
  // Windows intentionally retains PID-only compatibility: there is no cheap,
  // dependency-free process creation token available to this package.
  return undefined;
}

export async function processIdentityMatches(
  pid: number,
  expected: string | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  return await inspectProcessIdentity(pid, expected, signal) === "match";
}

export async function inspectProcessIdentity(
  pid: number,
  expected: string | undefined,
  signal?: AbortSignal,
): Promise<ProcessIdentityVerdict> {
  throwIfAborted(signal);
  if (expected === undefined) {
    return "match";
  }
  const current = await readProcessIdentity(pid, signal);
  if (current === undefined) {
    return "unavailable";
  }
  return current === expected ? "match" : "mismatch";
}
