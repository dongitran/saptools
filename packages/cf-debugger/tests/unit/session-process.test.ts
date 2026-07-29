import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_STARTUP_TIMEOUT_MS,
  STARTUP_STALE_SLACK_MS,
} from "../../src/debug-session/constants.js";
import {
  inspectRecordedProcess,
  startupAgeLimit,
  startupExpired,
} from "../../src/debug-session/session-process.js";
import type { ActiveSession } from "../../src/types.js";

function startingSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionId: "session-process-test",
    pid: process.pid,
    controllerPid: process.pid,
    hostname: "test-host",
    region: "eu10",
    org: "org-a",
    space: "dev",
    app: "demo-app",
    process: "web",
    instance: 0,
    apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
    localPort: 20_000,
    remotePort: 9_229,
    cfHomeDir: "/tmp/cf-debugger-session-process-test",
    startedAt: "2026-07-29T00:00:00.000Z",
    status: "starting",
    ...overrides,
  };
}

describe("recorded session process inspection", () => {
  afterEach((): void => {
    vi.useRealTimers();
  });

  it("derives the startup age from the persisted budget with a compatibility default", () => {
    expect(startupAgeLimit(startingSession({ startupTimeoutMs: 12_345 }))).toBe(
      12_345 + STARTUP_STALE_SLACK_MS,
    );
    expect(startupAgeLimit(startingSession())).toBe(
      MAX_STARTUP_TIMEOUT_MS + STARTUP_STALE_SLACK_MS,
    );
  });

  it("expires only after the supported startup age and rejects invalid timestamps", () => {
    vi.useFakeTimers();
    const session = startingSession({ startupTimeoutMs: 10_000 });
    const limit = startupAgeLimit(session);

    vi.setSystemTime(Date.parse(session.startedAt) + limit);
    expect(startupExpired(session)).toBe(false);

    vi.setSystemTime(Date.parse(session.startedAt) + limit + 1);
    expect(startupExpired(session)).toBe(true);
    expect(startupExpired(startingSession({ startedAt: "not-a-date" }))).toBe(true);
  });

  it("does not inspect identity after the liveness probe proves the PID dead", async () => {
    await expect(
      inspectRecordedProcess(44_001, "linux:v1:123", (): boolean => false),
    ).resolves.toBe("dead");
  });

  it("retains PID-only compatibility when the optional identity is absent", async () => {
    await expect(
      inspectRecordedProcess(44_001, undefined, (): boolean => true),
    ).resolves.toBe("match");
  });

  it("honours cancellation before probing PID liveness", async () => {
    const controller = new AbortController();
    const isAlive = vi.fn((): boolean => true);
    controller.abort();

    await expect(
      inspectRecordedProcess(44_001, undefined, isAlive, controller.signal),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(isAlive).not.toHaveBeenCalled();
  });
});
