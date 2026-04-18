import { mkdir, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_POLL_MS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
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
  await unlink(lockPath).catch((err: unknown) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  });
}

export interface WithLockOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options?: WithLockOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const handle = await acquireFileLock(lockPath, timeoutMs, pollMs);
  try {
    return await work();
  } finally {
    await releaseFileLock(lockPath, handle);
  }
}
