type RemoveFn = (path: string) => Promise<void>;

const tracked = new Map<string, RemoveFn>();
let handlerInstalled = false;

async function runCleanup(): Promise<void> {
  await Promise.all(
    [...tracked.entries()].map(async ([path, remove]) => {
      try {
        await remove(path);
      } catch {
        // Best effort: a failed cleanup of one tracked path must not stop the others.
      }
    }),
  );
}

function installHandlerOnce(): void {
  if (handlerInstalled) {
    return;
  }
  handlerInstalled = true;
  const onSignal = (): void => {
    void runCleanup()
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- Intentional empty catch; suppresses error-during-cleanup
      .catch(() => {})
      .finally(() => {
        process.exit(1);
      });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

/**
 * Register a temp directory (or file) for best-effort removal if the process
 * is interrupted (Ctrl-C / SIGTERM) before the caller's own `finally` block
 * runs. `remove` is normally `(path) => rm(path, { recursive: true, force:
 * true })` — passed in rather than hardcoded so a caller working with a
 * single temp file, not a directory, can pass `unlink` instead.
 *
 * Ported out of `@saptools/cf-metrics`'s `cf.ts` (where it already guarded
 * the CF_HOME temp directory) to close the equivalent, confirmed-open gap in
 * `@saptools/cf-otel`'s `saml-toggle.ts`, which held a full instance
 * params blob (secrets included) in an untracked temp directory.
 */
export function trackTempDir(path: string, remove: RemoveFn): void {
  installHandlerOnce();
  tracked.set(path, remove);
}

/** Stop tracking a path — call this in the normal (non-interrupted) cleanup path, immediately before removing it yourself. */
export function untrackTempDir(path: string): void {
  tracked.delete(path);
}

/** Test-only: clears all tracked state so tests do not leak into each other. Never call from production code. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- intentional __ prefix for test-only functions
export function __resetTempDirTrackingForTests(): void {
  tracked.clear();
  handlerInstalled = false;
}

/** Test-only: runs the same cleanup a real SIGINT/SIGTERM would, without touching real signal handlers or exiting the process. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- intentional __ prefix for test-only functions
export async function __runTrackedCleanupForTests(): Promise<void> {
  await runCleanup();
}
