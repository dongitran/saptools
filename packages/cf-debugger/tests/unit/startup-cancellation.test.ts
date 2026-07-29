import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasSessionStopIntent: vi.fn(),
  inspectSessionStateStopIntent: vi.fn(),
  readSessionSnapshot: vi.fn(),
}));

vi.mock("../../src/state.js", () => ({
  hasSessionStopIntent: mocks.hasSessionStopIntent,
  inspectSessionStateStopIntent: mocks.inspectSessionStateStopIntent,
  readSessionSnapshot: mocks.readSessionSnapshot,
}));

const { createStartupCancellation } = await import(
  "../../src/debug-session/startup-cancellation.js"
);

beforeEach(() => {
  mocks.hasSessionStopIntent.mockResolvedValue(false);
  mocks.inspectSessionStateStopIntent.mockResolvedValue("active");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("startup cancellation monitor", () => {
  it("aborts when the per-session stop intent appears", async () => {
    vi.useFakeTimers();
    mocks.hasSessionStopIntent
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    const cancellation = createStartupCancellation("session-a");
    await vi.advanceTimersByTimeAsync(499);
    expect(cancellation.signal.aborted).toBe(false);
    expect(mocks.hasSessionStopIntent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(cancellation.signal.aborted).toBe(true);
    expect(mocks.hasSessionStopIntent).toHaveBeenCalledTimes(2);
    cancellation.dispose();
  });

  it("keeps polling while no stop intent exists", async () => {
    vi.useFakeTimers();
    mocks.hasSessionStopIntent.mockResolvedValue(false);

    const cancellation = createStartupCancellation("session-a");
    await vi.advanceTimersByTimeAsync(1_500);

    expect(cancellation.signal.aborted).toBe(false);
    expect(mocks.hasSessionStopIntent).toHaveBeenCalledTimes(4);
    cancellation.dispose();
  });

  it("retries after a transient stop-intent read failure", async () => {
    vi.useFakeTimers();
    mocks.hasSessionStopIntent
      .mockRejectedValueOnce(new Error("filesystem busy"))
      .mockResolvedValue(true);

    const cancellation = createStartupCancellation("session-a");
    await vi.advanceTimersByTimeAsync(500);

    expect(cancellation.signal.aborted).toBe(true);
    cancellation.dispose();
  });

  it.each(["requested", "missing"])(
    "aborts when the unlocked state backstop reports %s",
    async (verdict): Promise<void> => {
      vi.useFakeTimers();
      mocks.inspectSessionStateStopIntent.mockResolvedValue(verdict);

      const cancellation = createStartupCancellation("session-a");
      await vi.advanceTimersByTimeAsync(0);

      expect(cancellation.signal.aborted).toBe(true);
      expect(mocks.inspectSessionStateStopIntent).toHaveBeenCalledWith("session-a");
      expect(mocks.readSessionSnapshot).not.toHaveBeenCalled();
      cancellation.dispose();
    },
  );

  it("keeps polling when the unlocked state backstop is unavailable", async () => {
    vi.useFakeTimers();
    mocks.inspectSessionStateStopIntent.mockResolvedValue("unavailable");

    const cancellation = createStartupCancellation("session-a");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(cancellation.signal.aborted).toBe(false);
    expect(mocks.inspectSessionStateStopIntent).toHaveBeenCalledTimes(3);
    expect(mocks.readSessionSnapshot).not.toHaveBeenCalled();
    cancellation.dispose();
  });

  it("uses the sidecar as the primary stop signal", async () => {
    vi.useFakeTimers();
    mocks.hasSessionStopIntent.mockResolvedValue(true);

    const cancellation = createStartupCancellation("session-a");
    await vi.advanceTimersByTimeAsync(0);

    expect(cancellation.signal.aborted).toBe(true);
    expect(mocks.inspectSessionStateStopIntent).not.toHaveBeenCalled();
    cancellation.dispose();
  });

  it("does not reschedule an in-flight check after disposal", async () => {
    vi.useFakeTimers();
    let finishRead: (exists: boolean) => void = () => undefined;
    mocks.hasSessionStopIntent.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishRead = resolve;
      }),
    );

    const cancellation = createStartupCancellation("session-a");
    expect(mocks.hasSessionStopIntent).toHaveBeenCalledWith("session-a");
    cancellation.dispose();
    finishRead(false);
    await vi.runAllTimersAsync();

    expect(cancellation.signal.aborted).toBe(true);
    expect(mocks.hasSessionStopIntent).toHaveBeenCalledTimes(1);
  });

  it("propagates an existing caller abort", () => {
    const caller = new AbortController();
    const reason = new Error("deadline elapsed");
    caller.abort(reason);

    const cancellation = createStartupCancellation("session-a", caller.signal);

    expect(cancellation.signal.aborted).toBe(true);
    expect(cancellation.signal.reason).toBe(reason);
    expect(mocks.hasSessionStopIntent).not.toHaveBeenCalled();
    cancellation.dispose();
  });
});
