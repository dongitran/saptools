import { mkdir, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_POLL_MS = 50;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface WithLockOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options?: WithLockOptions,
): Promise<T> {
  const timeoutMs = resolvePositive(options?.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollMs = resolvePositive(options?.pollMs, DEFAULT_POLL_MS);
  const handle = await acquireFileLock(lockPath, timeoutMs, pollMs);
  try {
    return await work();
  } finally {
    await releaseFileLock(lockPath, handle);
  }
}

async function acquireFileLock(
  lockPath: string,
  timeoutMs: number,
  pollMs: number,
): Promise<FileHandle> {
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out acquiring file lock at ${lockPath}`);
    }

    await sleep(pollMs);
  }
}

async function releaseFileLock(lockPath: string, handle: FileHandle): Promise<void> {
  await handle.close();
  await unlink(lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

function resolvePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
