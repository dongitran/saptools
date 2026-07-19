import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import process from "node:process";

const DEFAULT_POLL_MS = 50;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

interface FileLock {
  readonly handle: FileHandle;
  readonly token: string;
}

interface LockOwner {
  readonly hostname: string;
  readonly pid: number;
  readonly token: string;
  readonly version: "1";
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function parseLockOwner(raw: string): LockOwner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const lockHostname = field(value, "hostname");
  const pid = field(value, "pid");
  const token = field(value, "token");
  const version = field(value, "version");
  if (typeof lockHostname !== "string" || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (typeof token !== "string" || version !== "1") {
    return undefined;
  }
  return { hostname: lockHostname, pid, token, version };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    await chmod(lockPath, 0o600);
    return parseLockOwner(await readFile(lockPath, "utf8"));
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let modifiedAt: number;
  try {
    modifiedAt = (await stat(lockPath)).mtimeMs;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return true;
    }
    throw error;
  }
  const owner = await readLockOwner(lockPath);
  if (owner?.hostname === hostname()) {
    return !isProcessAlive(owner.pid);
  }
  return owner === undefined && Date.now() - modifiedAt > staleMs;
}

async function reclaimAbandonedRecoveryLock(
  recoveryPath: string,
  staleMs: number,
): Promise<void> {
  if (!(await isStaleLock(recoveryPath, staleMs))) {
    return;
  }
  const owner = await readLockOwner(recoveryPath);
  if (owner !== undefined) {
    await removeOwnedLock(recoveryPath, owner.token);
    return;
  }
  await unlink(recoveryPath).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  });
}

async function reclaimStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const recoveryPath = `${lockPath}.recovery`;
  let recoveryLock: FileLock;
  try {
    recoveryLock = await createFileLock(recoveryPath);
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") {
      await reclaimAbandonedRecoveryLock(recoveryPath, staleMs);
      return false;
    }
    throw error;
  }
  try {
    if (!(await isStaleLock(lockPath, staleMs))) {
      return false;
    }
    try {
      await unlink(lockPath);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
    return true;
  } finally {
    await releaseFileLock(recoveryPath, recoveryLock);
  }
}

async function removeOwnedLock(lockPath: string, token: string): Promise<void> {
  const owner = await readLockOwner(lockPath);
  if (owner?.token !== token) {
    return;
  }
  await unlink(lockPath).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  });
}

async function createFileLock(lockPath: string): Promise<FileLock> {
  const handle = await open(lockPath, "wx", 0o600);
  const token = randomUUID();
  try {
    await handle.writeFile(`${JSON.stringify({ hostname: hostname(), pid: process.pid, token, version: "1" })}\n`, "utf8");
    return { handle, token };
  } catch (error: unknown) {
    await handle.close();
    await unlink(lockPath).catch(() => false);
    throw error;
  }
}

async function acquireFileLock(
  lockPath: string,
  timeoutMs: number,
  pollMs: number,
  staleMs: number,
): Promise<FileLock> {
  const deadline = Date.now() + timeoutMs;
  const parentDir = dirname(lockPath);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  await chmod(parentDir, 0o700);

  for (;;) {
    try {
      return await createFileLock(lockPath);
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (await reclaimStaleLock(lockPath, staleMs)) {
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out acquiring file lock at ${lockPath}`);
    }
    await sleep(pollMs);
  }
}

async function releaseFileLock(lockPath: string, lock: FileLock): Promise<void> {
  await lock.handle.close();
  await removeOwnedLock(lockPath, lock.token);
}

export interface WithLockOptions {
  readonly pollMs?: number;
  readonly staleMs?: number;
  readonly timeoutMs?: number;
}

export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options?: WithLockOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const lock = await acquireFileLock(lockPath, timeoutMs, pollMs, staleMs);
  try {
    return await work();
  } finally {
    await releaseFileLock(lockPath, lock);
  }
}
