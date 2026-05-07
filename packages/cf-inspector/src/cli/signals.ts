import process from "node:process";

/**
 * Run `fn` with a fresh AbortController whose signal aborts on SIGINT/SIGTERM.
 * The handlers are detached on completion so repeated invocations do not leak
 * listeners, and so the next signal restores the default Node behaviour.
 */
export async function withTerminationSignal<T>(
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const onSignal = (): void => {
    abort.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await fn(abort.signal);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
