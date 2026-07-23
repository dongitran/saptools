import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { CfInspectorError } from "../types.js";

import type { Target } from "./commandTypes.js";

const ELECTION_WINDOW_MS = 25;
const LOCK_FILE_SUFFIX = ".lock";

interface SessionLockMetadata {
  readonly pid: number;
  readonly processStart?: string;
  readonly state: "pending" | "owned";
  readonly startedAt: string;
  readonly token: string;
  readonly target: string;
}

export interface DebugSessionLock {
  readonly path: string;
  release(): Promise<void>;
}

export interface DebugSessionLockOptions {
  readonly stateRoot?: string;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly token?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly getProcessStart?: (pid: number) => string | undefined;
}

export async function acquireDebugSessionLock(
  target: Target,
  options: DebugSessionLockOptions = {},
): Promise<DebugSessionLock> {
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const getProcessStart = options.getProcessStart ?? processStart;
  const ownerProcessStart = getProcessStart(pid);
  const token = options.token?.() ?? randomUUID();
  const targetIdentity = debugTargetIdentity(target);
  const key = createHash("sha256").update(targetIdentity).digest("hex");
  const lockRoot = options.stateRoot ?? defaultStateRoot();
  const lockDirectory = join(lockRoot, "cf-inspector", "locks");
  const ownPath = join(lockDirectory, `${key}.${pid.toString()}.${token}${LOCK_FILE_SUFFIX}`);
  const metadata: SessionLockMetadata = {
    pid,
    ...(ownerProcessStart === undefined ? {} : { processStart: ownerProcessStart }),
    state: "pending",
    startedAt: now().toISOString(),
    token,
    target: targetIdentity,
  };
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const handle = await open(ownPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
  } finally {
    await handle.close();
  }

  try {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ELECTION_WINDOW_MS);
    });
    const contenders = await findLiveContenders(
      lockDirectory,
      key,
      ownPath,
      options.isProcessAlive ?? processIsAlive,
      getProcessStart,
    );
    const owner = contenders.find((candidate) => candidate.state === "owned") ??
      contenders
        .filter((candidate) => candidate.state === "pending" && candidate.token < token)
        .sort((left, right) => left.token.localeCompare(right.token))[0];
    if (owner !== undefined) {
      throw alreadyDebuggedError(owner);
    }
    await writeLockMetadata(ownPath, { ...metadata, state: "owned" });
  } catch (error: unknown) {
    await unlink(ownPath).catch(() => {
      // Best-effort cleanup after a refused or failed acquisition.
    });
    throw error;
  }

  let released = false;
  return {
    path: ownPath,
    release: async (): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      const current = await readLockMetadata(ownPath);
      if (current?.token !== token || current.pid !== pid) {
        return;
      }
      await unlink(ownPath).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      });
    },
  };
}

export function debugTargetIdentity(target: Target): string {
  const targetIndex = target.targetIndex ?? 0;
  if (target.kind === "port") {
    return JSON.stringify({
      kind: "port",
      host: normalizeHost(target.host),
      port: target.port,
      targetIndex,
    });
  }
  return JSON.stringify({
    kind: "cf",
    region: target.region,
    org: target.org,
    space: target.space,
    app: target.app,
    targetIndex,
  });
}

function defaultStateRoot(): string {
  const configured = process.env["CF_INSPECTOR_STATE_DIR"]?.trim();
  return configured === undefined || configured.length === 0
    ? join(homedir(), ".saptools")
    : configured;
}

async function findLiveContenders(
  lockDirectory: string,
  key: string,
  ownPath: string,
  isProcessAlive: (pid: number) => boolean,
  getProcessStart: (pid: number) => string | undefined,
): Promise<readonly SessionLockMetadata[]> {
  const prefix = `${key}.`;
  const names = await readdir(lockDirectory);
  const contenders: SessionLockMetadata[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(LOCK_FILE_SUFFIX)) {
      continue;
    }
    const path = join(lockDirectory, name);
    if (path === ownPath) {
      continue;
    }
    const info = await stat(path).catch(() => {
      // The contender may have released between directory listing and stat.
    });
    const metadata = await readLockMetadata(path) ??
      (info === undefined ? undefined : metadataFromFilename(name, key, info.mtimeMs));
    if (metadata !== undefined) {
      if (ownerIsAlive(metadata, isProcessAlive, getProcessStart)) {
        contenders.push(metadata);
      } else {
        await unlink(path).catch(() => {
          // Another contender may already have reclaimed this stale file.
        });
      }
      continue;
    }
    if (info !== undefined) {
      contenders.push({
        pid: 0,
        state: "owned",
        startedAt: new Date(info.mtimeMs).toISOString(),
        token: "unknown",
        target: "unknown",
      });
    }
  }
  return contenders;
}

async function readLockMetadata(path: string): Promise<SessionLockMetadata | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) {
      return undefined;
    }
    const pid = parsed["pid"];
    const processStart = parsed["processStart"];
    const state = parsed["state"];
    const startedAt = parsed["startedAt"];
    const token = parsed["token"];
    const target = parsed["target"];
    if (
      typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 ||
      (processStart !== undefined && typeof processStart !== "string") ||
      (state !== "pending" && state !== "owned") ||
      typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt)) ||
      typeof token !== "string" || token.length === 0 ||
      typeof target !== "string" || target.length === 0
    ) {
      return undefined;
    }
    return {
      pid,
      ...(typeof processStart === "string" ? { processStart } : {}),
      state,
      startedAt,
      token,
      target,
    };
  } catch {
    return undefined;
  }
}

async function writeLockMetadata(path: string, metadata: SessionLockMetadata): Promise<void> {
  await writeFile(path, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", mode: 0o600 });
}

function metadataFromFilename(
  name: string,
  key: string,
  mtimeMs: number,
): SessionLockMetadata | undefined {
  const match = new RegExp(`^${key}\\.(\\d+)\\.(.+)\\${LOCK_FILE_SUFFIX}$`, "u").exec(name);
  const rawPid = match?.[1];
  const token = match?.[2];
  if (rawPid === undefined || token === undefined || token.length === 0) {
    return undefined;
  }
  const pid = Number.parseInt(rawPid, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  return {
    pid,
    state: "owned",
    startedAt: new Date(mtimeMs).toISOString(),
    token,
    target: "unknown",
  };
}

function ownerIsAlive(
  metadata: SessionLockMetadata,
  isProcessAlive: (pid: number) => boolean,
  getProcessStart: (pid: number) => string | undefined,
): boolean {
  if (!isProcessAlive(metadata.pid)) {
    return false;
  }
  const currentStart = getProcessStart(metadata.pid);
  return metadata.processStart === undefined || currentStart === undefined ||
    metadata.processStart === currentStart;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const status = processStatus(pid);
    return !status?.startsWith("Z");
  } catch (error: unknown) {
    return isNodeError(error, "EPERM");
  }
}

function processStatus(pid: number): string | undefined {
  return runPs(pid, "stat=");
}

function processStart(pid: number): string | undefined {
  return runPs(pid, "lstart=");
}

function runPs(pid: number, field: string): string | undefined {
  try {
    const value = execFileSync("ps", ["-o", field, "-p", pid.toString()], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

function alreadyDebuggedError(owner: SessionLockMetadata): CfInspectorError {
  const ownerLabel = owner.pid > 0 ? `PID ${owner.pid.toString()}` : "an unknown process";
  return new CfInspectorError(
    "TARGET_ALREADY_DEBUGGED",
    `Another cf-inspector session (${ownerLabel}, started ${owner.startedAt}) is already actively debugging this target. Concurrent debugging sessions on the same isolate(s) can corrupt each other and disrupt real application traffic, so this attempt was refused rather than queued. Wait for the other session to finish, or confirm that it is gone before retrying; locks from dead processes are reclaimed automatically.`,
  );
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "::1" ? "127.0.0.1" : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
