import { lstat, readFile, readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import nodeProcess from "node:process";

import { saptoolsDir } from "../paths.js";

const LEGACY_STATE_FILENAME = "cf-debugger-state.json";
const LEGACY_LOCK_FILENAME = "cf-debugger-state.lock";
const LEGACY_HOMES_DIRNAME = "cf-debugger-homes";

export type DoctorLegacyLiveness = "alive" | "not-running" | "unverified";

export interface DoctorLegacySessionFinding {
  readonly index: number;
  readonly sessionId?: string;
  readonly pid?: number;
  readonly localPort?: number;
  readonly hostname?: string;
  readonly liveness: DoctorLegacyLiveness;
  readonly reason?: string;
}

export interface DoctorLegacyFinding {
  readonly statePath: string;
  readonly statePresent: boolean;
  readonly homesPath: string;
  readonly homesPresent: boolean;
  readonly homeCount?: number;
  readonly sessions?: readonly DoctorLegacySessionFinding[];
  readonly inspectionWarnings?: readonly string[];
  readonly warning?: string;
  readonly manualRemovalCommand?: string;
}

interface LegacyStateInspection {
  readonly present: boolean;
  readonly sessions?: readonly DoctorLegacySessionFinding[];
  readonly warning?: string;
}

interface LegacyHomesInspection {
  readonly present: boolean;
  readonly homeCount?: number;
  readonly warning?: string;
}

interface LegacyLivenessInspection {
  readonly liveness: DoctorLegacyLiveness;
  readonly reason?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function optionalText(value: object, key: string): string | undefined {
  const candidate = field(value, key);
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function optionalInteger(
  value: object,
  key: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const candidate = field(value, key);
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate > 0 &&
    candidate <= maximum
    ? candidate
    : undefined;
}

function inspectLegacyPid(pid: number): LegacyLivenessInspection {
  try {
    nodeProcess.kill(pid, 0);
    return {
      liveness: "alive",
      reason: "PID exists, but v1 state cannot prove process identity or tunnel ownership",
    };
  } catch (error: unknown) {
    if (errorCode(error) === "ESRCH") {
      return { liveness: "not-running" };
    }
    return {
      liveness: "unverified",
      reason: `PID liveness check failed: ${errorMessage(error)}`,
    };
  }
}

function parseLegacySession(value: unknown, index: number): DoctorLegacySessionFinding {
  if (typeof value !== "object" || value === null) {
    return { index, liveness: "unverified", reason: "legacy session entry is not an object" };
  }
  const sessionId = optionalText(value, "sessionId");
  const pid = optionalInteger(value, "pid");
  const localPort = optionalInteger(value, "localPort", 65_535);
  const ownerHostname = optionalText(value, "hostname");
  const fields = {
    index,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(pid === undefined ? {} : { pid }),
    ...(localPort === undefined ? {} : { localPort }),
    ...(ownerHostname === undefined ? {} : { hostname: ownerHostname }),
  };
  if (pid === undefined || ownerHostname === undefined) {
    return {
      ...fields,
      liveness: "unverified",
      reason: pid === undefined
        ? "legacy session has no valid PID"
        : "legacy session has no valid hostname",
    };
  }
  if (ownerHostname !== hostname()) {
    return {
      ...fields,
      liveness: "unverified",
      reason: `legacy session belongs to host ${ownerHostname}; local PID was not probed`,
    };
  }
  return { ...fields, ...inspectLegacyPid(pid) };
}

async function inspectLegacyState(path: string): Promise<LegacyStateInspection> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT"
      ? { present: false }
      : { present: true, warning: `Could not read legacy v1 state: ${errorMessage(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { present: true, warning: "Legacy v1 state contains invalid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { present: true, warning: "Legacy v1 state is not an object." };
  }
  const sessions = field(parsed, "sessions");
  if (field(parsed, "version") !== "1" || !Array.isArray(sessions)) {
    return { present: true, warning: "Legacy v1 state has an invalid structure." };
  }
  return {
    present: true,
    sessions: sessions.map(parseLegacySession),
  };
}

async function inspectLegacyHomes(path: string): Promise<LegacyHomesInspection> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT"
      ? { present: false, homeCount: 0 }
      : { present: true, warning: `Could not inspect legacy v1 homes: ${errorMessage(error)}` };
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return {
      present: true,
      warning: "Legacy v1 homes root is not a real directory; it was not traversed.",
    };
  }
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return {
      present: true,
      homeCount: entries.filter((entry) => entry.isDirectory()).length,
    };
  } catch (error: unknown) {
    return {
      present: true,
      warning: `Could not enumerate legacy v1 homes: ${errorMessage(error)}`,
    };
  }
}

export function shellQuoteForCommand(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export async function findLegacyArtifacts(): Promise<DoctorLegacyFinding> {
  const statePath = join(saptoolsDir(), LEGACY_STATE_FILENAME);
  const lockPath = join(saptoolsDir(), LEGACY_LOCK_FILENAME);
  const homesPath = join(saptoolsDir(), LEGACY_HOMES_DIRNAME);
  const [state, homes] = await Promise.all([
    inspectLegacyState(statePath),
    inspectLegacyHomes(homesPath),
  ]);
  const inspectionWarnings = [state.warning, homes.warning].filter(
    (warning): warning is string => warning !== undefined,
  );
  const base = {
    statePath,
    statePresent: state.present,
    homesPath,
    homesPresent: homes.present,
    ...(homes.homeCount === undefined ? {} : { homeCount: homes.homeCount }),
    ...(state.sessions === undefined ? {} : { sessions: state.sessions }),
    ...(inspectionWarnings.length === 0 ? {} : { inspectionWarnings }),
  };
  if (!state.present && !homes.present) {
    return base;
  }
  return {
    ...base,
    warning:
      "Legacy v1 debugger homes may contain live CF refresh and access tokens. " +
      "Confirm no reported v1 tunnel is running before removing them.",
    manualRemovalCommand:
      `rm -rf -- ${shellQuoteForCommand(homesPath)} ${shellQuoteForCommand(statePath)} ${
        shellQuoteForCommand(lockPath)
      }`,
  };
}
