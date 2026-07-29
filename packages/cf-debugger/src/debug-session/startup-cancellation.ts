import {
  hasSessionStopIntent,
  inspectSessionStateStopIntent,
} from "../state.js";

const STOP_REQUEST_POLL_MS = 500;

export interface StartupCancellation {
  readonly signal: AbortSignal;
  dispose(): void;
}

async function startupStopWasRequested(sessionId: string): Promise<boolean> {
  try {
    if (await hasSessionStopIntent(sessionId)) {
      return true;
    }
  } catch {
    // The unlocked state read below is an independent compatibility backstop.
  }
  const stateVerdict = await inspectSessionStateStopIntent(sessionId);
  return stateVerdict === "missing" || stateVerdict === "requested";
}

export function createStartupCancellation(
  sessionId: string,
  callerSignal?: AbortSignal,
): StartupCancellation {
  const controller = new AbortController();
  let active = true;
  let timer: NodeJS.Timeout | undefined;
  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };
  const schedule = (): void => {
    timer = setTimeout(() => { void poll(); }, STOP_REQUEST_POLL_MS);
    timer.unref();
  };
  const poll = async (): Promise<void> => {
    try {
      if (active && await startupStopWasRequested(sessionId)) {
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
    controller.abort(callerSignal.reason);
  } else {
    void poll();
  }
  return {
    signal: controller.signal,
    dispose: (): void => {
      active = false;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      controller.abort();
    },
  };
}
