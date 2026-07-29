import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import nodeProcess from "node:process";
import { promisify } from "node:util";

import { CfDebuggerError } from "../types.js";

const execFileAsync = promisify(execFile);
const PROCESS_IDENTITY_VERSION = "v1";
const DARWIN_START_TIME_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(?:[1-9]|[12]\d|3[01]) \d{2}:\d{2}:\d{2} \d{4}$/;

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
    return startTime === undefined
      ? undefined
      : `linux:${PROCESS_IDENTITY_VERSION}:${startTime}`;
  } catch (error: unknown) {
    throwIfAborted(signal);
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

export function darwinIdentityEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    LC_ALL: "C",
    TZ: "UTC",
  };
}

async function darwinProcessIdentity(
  pid: number,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", pid.toString(), "-o", "lstart="], {
      env: darwinIdentityEnvironment(nodeProcess.env),
      ...(signal === undefined ? {} : { signal }),
      timeout: 2_000,
    });
    const startedAt = stdout.trim();
    return startedAt.length === 0
      ? undefined
      : `darwin:${PROCESS_IDENTITY_VERSION}:${startedAt}`;
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

function isCurrentProcessIdentity(identity: string): boolean {
  if (/^linux:v1:\d+$/.test(identity)) {
    return true;
  }
  const darwinPrefix = `darwin:${PROCESS_IDENTITY_VERSION}:`;
  return identity.startsWith(darwinPrefix)
    && DARWIN_START_TIME_PATTERN.test(identity.slice(darwinPrefix.length));
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
  if (!isCurrentProcessIdentity(expected)) {
    // Older readers and previous token formats cannot be compared safely. Retaining the
    // session is safer than interpreting an upgrade-induced format change as PID reuse.
    return "unavailable";
  }
  const current = await readProcessIdentity(pid, signal);
  if (current === undefined || !isCurrentProcessIdentity(current)) {
    return "unavailable";
  }
  return current === expected ? "match" : "mismatch";
}
