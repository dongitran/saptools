import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CfLogsRuntime } from "../../src/runtime.js";

class FakeReadable extends EventEmitter {
  emitData(chunk: string): void {
    this.emit("data", chunk);
  }
}

class FakeProcess extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
}

describe("CfLogsRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetchSnapshot populates state and emits a snapshot event", async () => {
    const prepareSession = vi.fn().mockResolvedValue(undefined);
    const fetchRecentLogsFromTarget = vi.fn().mockResolvedValue(
      "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT sample ready",
    );
    const persistSnapshot = vi.fn().mockResolvedValue({
      key: {
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        org: "sample-org",
        space: "sample",
        app: "demo-app",
      },
      rawText: "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT sample ready",
      fetchedAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:00.000Z",
      rowCount: 1,
      truncated: false,
    });
    const runtime = new CfLogsRuntime(
      {
        persistSnapshots: true,
        now: () => new Date("2026-04-18T00:00:00.000Z"),
      },
      {
        prepareSession,
        fetchRecentLogsFromTarget,
        persistSnapshot,
      },
    );
    const events: string[] = [];
    runtime.subscribe((event) => {
      events.push(event.type);
    });
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    const snapshot = await runtime.fetchSnapshot("demo-app");

    expect(snapshot.rows).toHaveLength(1);
    expect(runtime.getState("demo-app")?.rows).toHaveLength(1);
    expect(events).toContain("snapshot");
    expect(persistSnapshot).toHaveBeenCalledTimes(1);
  });

  it("setActiveApps starts a stream, appends lines, and ignores unknown apps", async () => {
    const process = new FakeProcess();
    const stop = vi.fn();
    const spawnLogStreamFromTarget = vi.fn().mockReturnValue({ process, stop });
    const runtime = new CfLogsRuntime(
      {
        flushIntervalMs: 25,
        now: () => new Date("2026-04-18T00:00:00.000Z"),
      },
      {
        prepareSession: vi.fn().mockResolvedValue(undefined),
        fetchRecentLogsFromTarget: vi.fn(),
        spawnLogStreamFromTarget,
      },
    );
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    await runtime.setActiveApps(["demo-app", "missing-app"]);
    process.stdout.emitData(
      "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT sample ready\n",
    );
    await vi.advanceTimersByTimeAsync(30);

    expect(spawnLogStreamFromTarget).toHaveBeenCalledTimes(1);
    expect(runtime.getState("demo-app")?.rows).toHaveLength(1);
    expect(runtime.getState("demo-app")?.streamState?.status).toBe("streaming");
  });

  it("restarts an active stream after an unexpected exit", async () => {
    const firstProcess = new FakeProcess();
    const secondProcess = new FakeProcess();
    const spawnLogStreamFromTarget = vi
      .fn()
      .mockReturnValueOnce({ process: firstProcess, stop: vi.fn() })
      .mockReturnValueOnce({ process: secondProcess, stop: vi.fn() });
    const runtime = new CfLogsRuntime(
      {
        retryInitialMs: 100,
        retryMaxMs: 200,
      },
      {
        prepareSession: vi.fn().mockResolvedValue(undefined),
        fetchRecentLogsFromTarget: vi.fn(),
        spawnLogStreamFromTarget,
      },
    );
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    await runtime.setActiveApps(["demo-app"]);
    firstProcess.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(100);

    expect(spawnLogStreamFromTarget).toHaveBeenCalledTimes(2);
    expect(runtime.getState("demo-app")?.streamState?.status).toBe("streaming");
  });

  it("stopping an active app stops its stream and marks the state stopped", async () => {
    const process = new FakeProcess();
    const stop = vi.fn();
    const runtime = new CfLogsRuntime(
      {},
      {
        prepareSession: vi.fn().mockResolvedValue(undefined),
        fetchRecentLogsFromTarget: vi.fn(),
        spawnLogStreamFromTarget: vi.fn().mockReturnValue({ process, stop }),
      },
    );
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    await runtime.setActiveApps(["demo-app"]);
    await runtime.setActiveApps([]);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(runtime.getState("demo-app")?.streamState?.status).toBe("stopped");
  });

  it("redacts credentials before persisting snapshots", async () => {
    const persistSnapshot = vi.fn().mockResolvedValue({
      key: {
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        org: "sample-org",
        space: "sample",
        app: "demo-app",
      },
      rawText: "***",
      fetchedAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:00.000Z",
      rowCount: 1,
      truncated: false,
    });
    const runtime = new CfLogsRuntime(
      {
        persistSnapshots: true,
      },
      {
        prepareSession: vi.fn().mockResolvedValue(undefined),
        fetchRecentLogsFromTarget: vi.fn().mockResolvedValue(
          "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT sample-password sample@example.com",
        ),
        persistSnapshot,
      },
    );
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    await runtime.fetchSnapshot("demo-app");

    expect(persistSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        rawText: expect.not.stringContaining("sample-password"),
      }),
    );
    expect(persistSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        rawText: expect.not.stringContaining("sample@example.com"),
      }),
    );
  });

  it("throws when fetching a snapshot without a session or with an unknown app", async () => {
    const runtime = new CfLogsRuntime();
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    await expect(runtime.fetchSnapshot("demo-app")).rejects.toThrow("No CF session configured.");

    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });

    await expect(runtime.fetchSnapshot("missing-app")).rejects.toThrow("Unknown app: missing-app");
  });

  it("retries when stream startup fails before eventually connecting", async () => {
    const process = new FakeProcess();
    const runtime = new CfLogsRuntime(
      {
        retryInitialMs: 100,
        retryMaxMs: 200,
      },
      {
        prepareSession: vi.fn().mockResolvedValue(undefined),
        fetchRecentLogsFromTarget: vi.fn(),
        spawnLogStreamFromTarget: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error("sample start failure");
          })
          .mockReturnValueOnce({ process, stop: vi.fn() }),
      },
    );
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    await runtime.setActiveApps(["demo-app"]);
    expect(runtime.getState("demo-app")?.streamState?.status).toBe("error");

    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.getState("demo-app")?.streamState?.status).toBe("streaming");
  });

  it("persists stream appends when configured", async () => {
    const process = new FakeProcess();
    const persistSnapshot = vi.fn().mockResolvedValue({
      key: {
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        org: "sample-org",
        space: "sample",
        app: "demo-app",
      },
      rawText: "sample",
      fetchedAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:00.000Z",
      rowCount: 1,
      truncated: false,
    });
    const runtime = new CfLogsRuntime(
      {
        flushIntervalMs: 25,
        persistStreamAppends: true,
      },
      {
        prepareSession: vi.fn().mockResolvedValue(undefined),
        fetchRecentLogsFromTarget: vi.fn(),
        spawnLogStreamFromTarget: vi.fn().mockReturnValue({ process, stop: vi.fn() }),
        persistSnapshot,
      },
    );
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    await runtime.setActiveApps(["demo-app"]);
    process.stdout.emitData(
      "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT sample append\n",
    );
    await vi.advanceTimersByTimeAsync(30);

    expect(persistSnapshot).toHaveBeenCalled();
  });

  it("applies custom runtime redaction rules during snapshot persistence", async () => {
    const persistSnapshot = vi.fn().mockResolvedValue({
      key: {
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        org: "sample-org",
        space: "sample",
        app: "demo-app",
      },
      rawText: "***",
      fetchedAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:00.000Z",
      rowCount: 1,
      truncated: false,
    });
    const runtime = new CfLogsRuntime(
      {
        persistSnapshots: true,
        redactionRules: [{ value: "sample-secret", replacement: "[secure]" }],
      },
      {
        prepareSession: vi.fn().mockResolvedValue(undefined),
        fetchRecentLogsFromTarget: vi.fn().mockResolvedValue(
          "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT sample-secret",
        ),
        persistSnapshot,
      },
    );
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    await runtime.fetchSnapshot("demo-app");

    expect(persistSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        rawText: expect.not.stringContaining("sample-secret"),
      }),
    );
  });

  it("re-prepares the session and retries when the CF target has drifted (stale-target recovery)", async () => {
    const prepareSession = vi.fn().mockResolvedValue(undefined);
    const fetchRecentLogsFromTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch recent logs for app "demo-app". (cli: not logged in)'))
      .mockResolvedValueOnce(
        "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT recovered",
      );
    const runtime = new CfLogsRuntime(
      {},
      {
        prepareSession,
        fetchRecentLogsFromTarget,
      },
    );
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    const snapshot = await runtime.fetchSnapshot("demo-app");

    expect(snapshot.rows).toHaveLength(1);
    expect(prepareSession).toHaveBeenCalledTimes(2);
    expect(fetchRecentLogsFromTarget).toHaveBeenCalledTimes(2);
  });

  it("propagates non-stale errors without re-preparing", async () => {
    const prepareSession = vi.fn().mockResolvedValue(undefined);
    const fetchRecentLogsFromTarget = vi
      .fn()
      .mockRejectedValue(new Error('Failed to fetch recent logs for app "demo-app". (cli: app not found)'));
    const runtime = new CfLogsRuntime(
      {},
      {
        prepareSession,
        fetchRecentLogsFromTarget,
      },
    );
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    await expect(runtime.fetchSnapshot("demo-app")).rejects.toThrow(/app not found/);
    expect(prepareSession).toHaveBeenCalledTimes(1);
    expect(fetchRecentLogsFromTarget).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent prepareSession calls", async () => {
    let resolvePrepare: (() => void) | undefined;
    const prepareSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    const firstProcess = new FakeProcess();
    const secondProcess = new FakeProcess();
    const spawnLogStreamFromTarget = vi
      .fn()
      .mockReturnValueOnce({ process: firstProcess, stop: vi.fn() })
      .mockReturnValueOnce({ process: secondProcess, stop: vi.fn() });
    const runtime = new CfLogsRuntime(
      {},
      {
        prepareSession,
        fetchRecentLogsFromTarget: vi.fn(),
        spawnLogStreamFromTarget,
      },
    );
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([
      { name: "demo-app-a", runningInstances: 1 },
      { name: "demo-app-b", runningInstances: 1 },
    ]);

    const activePromise = runtime.setActiveApps(["demo-app-a", "demo-app-b"]);
    await vi.advanceTimersByTimeAsync(0);
    resolvePrepare?.();
    await activePromise;

    expect(prepareSession).toHaveBeenCalledTimes(1);
    expect(spawnLogStreamFromTarget).toHaveBeenCalledTimes(2);
  });

  it("clears pending reconnect and flush timers when the app is deactivated", async () => {
    const process = new FakeProcess();
    const stop = vi.fn();
    const spawnLogStreamFromTarget = vi.fn().mockReturnValue({ process, stop });
    const runtime = new CfLogsRuntime(
      {
        flushIntervalMs: 50,
        retryInitialMs: 100,
      },
      {
        prepareSession: vi.fn().mockResolvedValue(undefined),
        fetchRecentLogsFromTarget: vi.fn(),
        spawnLogStreamFromTarget,
      },
    );
    runtime.setSession({
      region: "ap10",
      email: "sample@example.com",
      password: "sample-password",
      org: "sample-org",
      space: "sample",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    });
    runtime.setAvailableApps([{ name: "demo-app", runningInstances: 1 }]);

    await runtime.setActiveApps(["demo-app"]);
    process.stdout.emitData(
      "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT sample append\n",
    );
    process.emit("exit", 1, null);
    await runtime.setActiveApps([]);
    await vi.advanceTimersByTimeAsync(150);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(spawnLogStreamFromTarget).toHaveBeenCalledTimes(1);
  });
});
