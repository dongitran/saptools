import { beforeEach, describe, expect, it, vi } from "vitest";

import { openCfTunnel, openOwnedCfTunnel } from "../../src/cf/tunnel.js";

const mocks = vi.hoisted(() => ({
  startDebugger: vi.fn(),
  fetchInspectorVersion: vi.fn(),
}));

vi.mock("@saptools/cf-debugger", () => ({
  startDebugger: mocks.startDebugger,
}));

vi.mock("../../src/inspector/discovery.js", () => ({
  fetchInspectorVersion: mocks.fetchInspectorVersion,
}));

describe("openCfTunnel", () => {
  beforeEach(() => {
    mocks.startDebugger.mockReset();
    mocks.fetchInspectorVersion.mockReset();
    mocks.fetchInspectorVersion.mockResolvedValue({ browser: "node", protocolVersion: "1.3" });
  });

  it("refuses to reuse an already-running tunnel whose exact target cannot be proven", async () => {
    const err = Object.assign(new Error("A debugger session is already running on port 20000"), {
      code: "SESSION_ALREADY_RUNNING",
    });
    mocks.startDebugger.mockRejectedValueOnce(err);

    await expect(openOwnedCfTunnel({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo",
      nodePid: 314,
    })).rejects.toBe(err);
  });

  it("preserves legacy verified-port reuse for existing openCfTunnel consumers", async () => {
    const err = Object.assign(new Error("A debugger session is already running on port 20000"), {
      code: "SESSION_ALREADY_RUNNING",
    });
    mocks.startDebugger.mockRejectedValueOnce(err);

    const tunnel = await openCfTunnel({ region: "eu10", org: "org-a", space: "dev", app: "demo" });

    expect(tunnel.localPort).toBe(20_000);
    expect(mocks.fetchInspectorVersion).toHaveBeenCalledWith("127.0.0.1", 20_000, 5_000);
    expect(tunnel.handle).toBeUndefined();
    await expect(tunnel.dispose()).resolves.toBeUndefined();
  });

  it("reports an actionable error when a claimed reused tunnel never becomes live", async () => {
    const err = Object.assign(new Error("A debugger session is already running on port 20000"), {
      code: "SESSION_ALREADY_RUNNING",
    });
    mocks.startDebugger.mockRejectedValueOnce(err);
    mocks.fetchInspectorVersion.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    await expect(openCfTunnel({ region: "eu10", org: "org-a", space: "dev", app: "demo" }))
      .rejects.toMatchObject({
        code: "INSPECTOR_DISCOVERY_FAILED",
        message: expect.stringMatching(/claims tunnel port 20000.*stale or still finishing setup/i) as unknown as string,
      });
  });

  it("waits for a claimed reused tunnel that becomes live during the grace window", async () => {
    const err = Object.assign(new Error("A debugger session is already running on port 20002"), {
      code: "SESSION_ALREADY_RUNNING",
    });
    mocks.startDebugger.mockRejectedValueOnce(err);
    mocks.fetchInspectorVersion.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return { browser: "node", protocolVersion: "1.3" };
    });

    await expect(openCfTunnel({ region: "eu10", org: "org-a", space: "dev", app: "demo" }))
      .resolves.toMatchObject({ localPort: 20_002 });
  });

  it("rethrows already-running errors without parsing their message", async () => {
    const err = Object.assign(new Error("A debugger session is already running"), {
      code: "SESSION_ALREADY_RUNNING",
    });
    mocks.startDebugger.mockRejectedValueOnce(err);

    await expect(openCfTunnel({ region: "eu10", org: "org-a", space: "dev", app: "demo" })).rejects.toBe(err);
  });

  it("forwards process, instance, and remote Node PID to cf-debugger", async () => {
    const controller = new AbortController();
    const dispose = vi.fn(async (): Promise<void> => undefined);
    mocks.startDebugger.mockResolvedValueOnce({
      session: { localPort: 20_001 },
      dispose,
      waitForExit: vi.fn(),
    });

    const tunnel = await openCfTunnel({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo",
      process: "worker",
      instance: 2,
      nodePid: 314,
      allowSshEnableRestart: false,
      signal: controller.signal,
    });

    expect(mocks.startDebugger).toHaveBeenCalledWith(expect.objectContaining({
      process: "worker",
      instance: 2,
      nodePid: 314,
      allowSshEnableRestart: false,
      signal: controller.signal,
    }));
    expect(tunnel.localPort).toBe(20_001);
    await tunnel.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
