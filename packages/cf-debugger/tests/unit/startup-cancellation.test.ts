import { hostname } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActiveSession } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  readSessionSnapshot: vi.fn(),
}));

vi.mock("../../src/state.js", () => ({
  readSessionSnapshot: mocks.readSessionSnapshot,
}));

const { createStartupCancellation } = await import(
  "../../src/debug-session/startup-cancellation.js"
);

const session: ActiveSession = {
  sessionId: "session-a",
  pid: process.pid,
  controllerPid: process.pid,
  hostname: hostname(),
  region: "eu10",
  org: "org-a",
  space: "dev",
  app: "demo-app",
  process: "web",
  instance: 0,
  apiEndpoint: "https://api.example.com",
  localPort: 20_123,
  remotePort: 9229,
  cfHomeDir: "/tmp/cf-debugger-home",
  startedAt: "2026-01-01T00:00:00.000Z",
  status: "signaling",
};

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("startup cancellation monitor", () => {
  it("aborts when a later state snapshot contains a stop request", async () => {
    vi.useFakeTimers();
    mocks.readSessionSnapshot
      .mockResolvedValueOnce([session])
      .mockResolvedValue([{ ...session, stopRequestedAt: "2026-01-01T00:00:01.000Z" }]);

    const cancellation = createStartupCancellation(session.sessionId);
    await vi.advanceTimersByTimeAsync(50);

    expect(cancellation.signal.aborted).toBe(true);
    cancellation.dispose();
  });

  it("aborts when the ownership record disappears", async () => {
    mocks.readSessionSnapshot.mockResolvedValue([]);

    const cancellation = createStartupCancellation(session.sessionId);
    await vi.waitFor(() => { expect(cancellation.signal.aborted).toBe(true); });
    cancellation.dispose();
  });

  it("retries after a transient snapshot read failure", async () => {
    vi.useFakeTimers();
    mocks.readSessionSnapshot
      .mockRejectedValueOnce(new Error("lock busy"))
      .mockResolvedValue([{ ...session, stopRequestedAt: "2026-01-01T00:00:01.000Z" }]);

    const cancellation = createStartupCancellation(session.sessionId);
    await vi.advanceTimersByTimeAsync(50);

    expect(cancellation.signal.aborted).toBe(true);
    cancellation.dispose();
  });

  it("does not abort or reschedule after disposal during an in-flight read", async () => {
    vi.useFakeTimers();
    let finishRead: (sessions: readonly ActiveSession[]) => void = () => undefined;
    mocks.readSessionSnapshot.mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));

    const cancellation = createStartupCancellation(session.sessionId);
    cancellation.dispose();
    finishRead([]);
    await vi.runAllTimersAsync();

    expect(cancellation.signal.aborted).toBe(false);
    expect(mocks.readSessionSnapshot).toHaveBeenCalledTimes(1);
  });

  it("propagates an existing caller abort", () => {
    const caller = new AbortController();
    caller.abort();

    const cancellation = createStartupCancellation(session.sessionId, caller.signal);

    expect(cancellation.signal.aborted).toBe(true);
    expect(mocks.readSessionSnapshot).not.toHaveBeenCalled();
    cancellation.dispose();
  });
});
