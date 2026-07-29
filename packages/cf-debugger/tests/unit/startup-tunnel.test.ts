import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveSession, StartDebuggerOptions } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  formatTunnelDiagnostics: vi.fn(),
  getTunnelDiagnostics: vi.fn(),
  inspectPortOwnership: vi.fn(),
  isPortFree: vi.fn(),
  probeInspectorReady: vi.fn(),
  probeTunnelReady: vi.fn(),
  spawnSshTunnel: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock("../../src/cf.js", () => ({
  formatTunnelDiagnostics: mocks.formatTunnelDiagnostics,
  getTunnelDiagnostics: mocks.getTunnelDiagnostics,
  spawnSshTunnel: mocks.spawnSshTunnel,
}));

vi.mock("../../src/port.js", () => ({
  inspectPortOwnership: mocks.inspectPortOwnership,
  isPortFree: mocks.isPortFree,
  probeInspectorReady: mocks.probeInspectorReady,
  probeTunnelReady: mocks.probeTunnelReady,
}));

vi.mock("../../src/state.js", () => ({
  updateSessionPid: mocks.updateSessionPid,
}));

const { openReadyTunnel } = await import("../../src/debug-session/startup-tunnel.js");

function createChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    exitCode: null,
    pid,
    signalCode: null,
  });
  return child;
}

const options: StartDebuggerOptions = {
  region: "eu10",
  org: "example-org",
  space: "dev",
  app: "example-app",
};

function createSession(): ActiveSession {
  return {
    ...options,
    sessionId: "session-a",
    pid: 41_001,
    controllerPid: 41_001,
    hostname: "test-host",
    process: "web",
    instance: 0,
    apiEndpoint: "https://api.example.test",
    localPort: 20_123,
    remotePort: 9229,
    cfHomeDir: "/tmp/cf-debugger-session-a",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "tunneling",
  };
}

describe("openReadyTunnel", () => {
  beforeEach(() => {
    mocks.formatTunnelDiagnostics.mockReturnValue(undefined);
    mocks.getTunnelDiagnostics.mockReturnValue({
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    mocks.inspectPortOwnership.mockResolvedValue({
      status: "owned",
      pids: [42_001],
    });
    mocks.isPortFree.mockResolvedValue(true);
    mocks.probeInspectorReady.mockResolvedValue({ status: "ready" });
    mocks.probeTunnelReady.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("reserves inspector time inside the readiness deadline and removes race listeners", async () => {
    const child = createChild(42_001);
    const session = createSession();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.spawnSshTunnel.mockReturnValue(child);
    mocks.updateSessionPid.mockResolvedValue({
      ...session,
      pid: 42_001,
      tunnelPid: 42_001,
    });
    mocks.probeTunnelReady.mockImplementation(async (_port: number, timeoutMs: number) => {
      now += timeoutMs;
      return true;
    });
    mocks.inspectPortOwnership.mockImplementation(async () => {
      now += 2_500;
      return {
        status: "owned" as const,
        pids: [42_001],
      };
    });

    await openReadyTunnel({
      options,
      target: { process: "web", instance: 0 },
      session,
      context: {
        cfHome: session.cfHomeDir,
        deadlineAt: now + 20_000,
        startupTimeoutMs: 20_000,
      },
      tunnelReadyTimeoutMs: 20_000,
      onChild: vi.fn(),
    });

    expect(mocks.probeTunnelReady).toHaveBeenCalledWith(
      session.localPort,
      5_000,
      expect.any(AbortSignal),
    );
    expect(mocks.probeInspectorReady).toHaveBeenCalledWith(
      session.localPort,
      10_000,
      expect.any(AbortSignal),
    );
    expect(mocks.inspectPortOwnership).toHaveBeenCalledTimes(2);
    expect(child.listenerCount("close")).toBe(0);
  });

  it("bounds ownership inspection before it can consume the inspector reserve", async () => {
    const child = createChild(42_001);
    const session = createSession();
    mocks.spawnSshTunnel.mockReturnValue(child);
    mocks.updateSessionPid.mockResolvedValue({
      ...session,
      pid: 42_001,
      tunnelPid: 42_001,
    });
    mocks.inspectPortOwnership.mockImplementation(
      async (_port: number, _pid: number, signal?: AbortSignal) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("ownership probe aborted"));
            },
            { once: true },
          );
        }),
    );

    await expect(openReadyTunnel({
      options,
      target: { process: "web", instance: 0 },
      session,
      context: {
        cfHome: session.cfHomeDir,
        deadlineAt: Date.now() + 1_000,
        startupTimeoutMs: 1_000,
      },
      tunnelReadyTimeoutMs: 100,
      onChild: vi.fn(),
    })).rejects.toMatchObject({
      code: "TUNNEL_OWNER_UNVERIFIED",
      message: expect.stringContaining("readiness budget"),
    });
    expect(mocks.probeInspectorReady).not.toHaveBeenCalled();
  });
});
