import { readSessionSnapshot } from "../state.js";
import type { ActiveSession } from "../types.js";

const STOP_REQUEST_POLL_MS = 50;

export interface StartupCancellation {
  readonly signal: AbortSignal;
  dispose(): void;
}

function cancellationRequested(
  sessions: readonly ActiveSession[],
  sessionId: string,
): boolean {
  const session = sessions.find((candidate) => candidate.sessionId === sessionId);
  return session === undefined || session.stopRequestedAt !== undefined;
}

export function createStartupCancellation(
  sessionId: string,
  callerSignal?: AbortSignal,
): StartupCancellation {
  const controller = new AbortController();
  let active = true;
  let timer: NodeJS.Timeout | undefined;
  const onCallerAbort = (): void => {
    controller.abort();
  };
  const schedule = (): void => {
    timer = setTimeout(() => { void poll(); }, STOP_REQUEST_POLL_MS);
    timer.unref();
  };
  const poll = async (): Promise<void> => {
    try {
      const sessions = await readSessionSnapshot();
      if (active && cancellationRequested(sessions, sessionId)) {
        controller.abort();
      }
    } catch {
      // A lifecycle transition still validates state under the lock after transient read failures.
    }
    if (active && !controller.signal.aborted) {
      schedule();
    }
  };

  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted === true) {
    controller.abort();
  } else {
    void poll();
  }
  return {
    signal: controller.signal,
    dispose: (): void => {
      active = false;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}
