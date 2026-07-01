import { beforeEach, describe, expect, it, vi } from "vitest";

import { openCfTunnel } from "../../src/cf/tunnel.js";

const mocks = vi.hoisted(() => ({
  startDebugger: vi.fn(),
}));

vi.mock("@saptools/cf-debugger", () => ({
  startDebugger: mocks.startDebugger,
}));

describe("openCfTunnel", () => {
  beforeEach(() => {
    mocks.startDebugger.mockReset();
  });

  it("reuses an already-running debugger tunnel when the existing port is reported", async () => {
    const err = Object.assign(new Error("A debugger session is already running on port 20000"), {
      code: "SESSION_ALREADY_RUNNING",
    });
    const statuses: string[] = [];
    mocks.startDebugger.mockRejectedValueOnce(err);

    const tunnel = await openCfTunnel({
      region: "eu10",
      org: "org-a",
      space: "dev",
      app: "demo",
      onStatus: (_status, message): void => {
        if (message !== undefined) {
          statuses.push(message);
        }
      },
    });

    expect(tunnel.localPort).toBe(20000);
    expect(tunnel.handle).toBeUndefined();
    expect(statuses).toEqual(["Reusing existing tunnel on port 20000"]);
    await expect(tunnel.dispose()).resolves.toBeUndefined();
  });

  it("rethrows already-running errors when the port cannot be inferred", async () => {
    const err = Object.assign(new Error("A debugger session is already running"), {
      code: "SESSION_ALREADY_RUNNING",
    });
    mocks.startDebugger.mockRejectedValueOnce(err);

    await expect(openCfTunnel({ region: "eu10", org: "org-a", space: "dev", app: "demo" })).rejects.toBe(err);
  });
});
