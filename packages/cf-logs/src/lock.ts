export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
): Promise<T> {
  const { mkdir, open, unlink } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const startedAt = Date.now();

  for (;;) {
    try {
      await mkdir(dirname(lockPath), { recursive: true });
      const handle = await open(lockPath, "wx");
      try {
        return await work();
      } finally {
        await handle.close();
        await unlink(lockPath).catch((_error: unknown) => {
          return;
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() - startedAt > 5_000) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
}
