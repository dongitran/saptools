import { describe, expect, it } from "vitest";

import {
  createShutdownController,
  type ShutdownControllerDependencies,
} from "../../src/cli/shutdown.js";
import { createProcessGuard } from "../../src/process-guard.js";

interface FakeTimer {
  readonly run: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

interface Harness {
  readonly dependencies: ShutdownControllerDependencies;
  readonly calls: string[];
  readonly exitCodes: number[];
  readonly timers: FakeTimer[];
}

function createHarness(): Harness {
  const calls: string[] = [];
  const exitCodes: number[] = [];
  const timers: FakeTimer[] = [];
  const guard = createProcessGuard();
  guard.register({
    label: "resource",
    release: async (): Promise<void> => {
      calls.push("release");
    },
  });
  const dependencies: ShutdownControllerDependencies = {
    guard,
    abort: (): void => {
      calls.push("abort");
    },
    exit: (code): void => {
      exitCodes.push(code);
    },
    scheduleForceExit: (run, delayMs): (() => void) => {
      // Mirrors real clearTimeout semantics: once cancelled, firing the
      // timer must be a no-op, exactly like a cleared setTimeout can never
      // invoke its callback.
      const timer: FakeTimer = {
        delayMs,
        cancelled: false,
        run: (): void => {
          if (!timer.cancelled) {
            run();
          }
        },
      };
      timers.push(timer);
      return (): void => {
        timer.cancelled = true;
      };
    },
    gracePeriodMs: 5_000,
  };
  return { dependencies, calls, exitCodes, timers };
}

describe("shutdown controller", () => {
  it("aborts immediately and schedules a bounded forced exit on the first signal", () => {
    const { dependencies, calls, exitCodes, timers } = createHarness();
    const controller = createShutdownController(dependencies);

    controller.handleSignal("SIGTERM");

    expect(calls).toEqual(["abort"]);
    expect(exitCodes).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(5_000);
  });

  it("cancels the pending forced exit once the command settles on its own", () => {
    const { dependencies, calls, exitCodes, timers } = createHarness();
    const controller = createShutdownController(dependencies);

    controller.handleSignal("SIGTERM");
    controller.handleSettled();
    // A real cleared setTimeout can never fire; the fake timer's run()
    // mirrors that, so nothing async is triggered here — there is nothing
    // left to await.
    timers[0]?.run();

    expect(timers[0]?.cancelled).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(calls).not.toContain("release");
  });

  it("runs the guard's cleanup and force-exits with the signal's code once the grace period elapses", async () => {
    const { dependencies, calls, exitCodes, timers } = createHarness();
    const controller = createShutdownController(dependencies);

    controller.handleSignal("SIGTERM");
    timers[0]?.run();
    await dependencies.guard.runCleanup();

    expect(calls).toContain("release");
    expect(exitCodes).toEqual([143]);
  });

  it("uses the SIGINT exit code when the grace period elapses after SIGINT", async () => {
    const { dependencies, exitCodes, timers } = createHarness();
    const controller = createShutdownController(dependencies);

    controller.handleSignal("SIGINT");
    timers[0]?.run();
    await dependencies.guard.runCleanup();

    expect(exitCodes).toEqual([130]);
  });

  it("escalates immediately on a repeated signal instead of waiting out the grace period", async () => {
    const { dependencies, calls, exitCodes, timers } = createHarness();
    const controller = createShutdownController(dependencies);

    controller.handleSignal("SIGTERM");
    controller.handleSignal("SIGTERM");
    await dependencies.guard.runCleanup();

    expect(timers).toHaveLength(1);
    expect(timers[0]?.cancelled).toBe(true);
    expect(calls).toContain("release");
    expect(exitCodes).toEqual([143]);
  });

  it("escalates on a second, different signal too", async () => {
    const { dependencies, exitCodes } = createHarness();
    const controller = createShutdownController(dependencies);

    controller.handleSignal("SIGINT");
    controller.handleSignal("SIGTERM");
    await dependencies.guard.runCleanup();

    // The second signal forces the exit; its own conventional code wins.
    expect(exitCodes).toEqual([143]);
  });

  it("runs the guard's cleanup and force-exits with code 1 on a fatal error, with no prior signal", async () => {
    const { dependencies, calls, exitCodes } = createHarness();
    const controller = createShutdownController(dependencies);

    controller.handleFatalError();
    await dependencies.guard.runCleanup();

    expect(calls).toContain("release");
    expect(exitCodes).toEqual([1]);
  });

  it("a fatal error cancels an already-pending signal-triggered forced exit", async () => {
    const { dependencies, exitCodes, timers } = createHarness();
    const controller = createShutdownController(dependencies);

    controller.handleSignal("SIGTERM");
    controller.handleFatalError();
    await dependencies.guard.runCleanup();

    expect(timers[0]?.cancelled).toBe(true);
    expect(exitCodes).toEqual([1]);
  });
});
