import process from "node:process";

import { runCli } from "./cli/main.js";
import { createShutdownController } from "./cli/shutdown.js";
import { getSharedProcessGuard } from "./process-guard.js";

const abortController = new AbortController();
const controller = createShutdownController({
  guard: getSharedProcessGuard(),
  abort: (): void => {
    abortController.abort();
  },
  exit: (code): void => {
    process.exit(code);
  },
  scheduleForceExit: (run, delayMs): (() => void) => {
    const timer = setTimeout(run, delayMs);
    return (): void => {
      clearTimeout(timer);
    };
  },
});

const onSigint = (): void => {
  controller.handleSignal("SIGINT");
};
const onSigterm = (): void => {
  controller.handleSignal("SIGTERM");
};
const onUncaughtException = (): void => {
  controller.handleFatalError();
};
const onUnhandledRejection = (): void => {
  controller.handleFatalError();
};

// Registered with `on`, not `once`: a repeated SIGINT/SIGTERM must still
// reach handleSignal so it can escalate past a graceful shutdown that is not
// finishing in time, rather than falling through to Node's raw default
// (immediate termination with no debugger resume or tunnel dispose).
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
process.on("uncaughtException", onUncaughtException);
process.on("unhandledRejection", onUnhandledRejection);

try {
  process.exitCode = await runCli(process.argv, {
    stdout: process.stdout,
    stderr: process.stderr,
    signal: abortController.signal,
  });
} catch {
  process.exitCode = 1;
} finally {
  // A fast graceful shutdown must not be overridden by the forced-exit
  // fallback once the command has already settled on its own.
  controller.handleSettled();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.off("uncaughtException", onUncaughtException);
  process.off("unhandledRejection", onUnhandledRejection);
}
