export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async (): Promise<void> => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item !== undefined) {
          await fn(item);
        }
      }
    },
  );
  await Promise.all(workers);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
