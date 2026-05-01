import { mkdir, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_POLL_MS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface WithFileLockOptions {
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

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
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  });
}

export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: WithFileLockOptions = {},
): Promise<T> {
  const handle = await acquireFileLock(
    lockPath,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.pollMs ?? DEFAULT_POLL_MS,
  );
  try {
    return await work();
  } finally {
    await releaseFileLock(lockPath, handle);
  }
}
