import { beforeEach, describe, expect, it, vi } from "vitest";

import { CfExplorerError } from "../../src/errors.js";
import { enableSsh, prepareSsh, restartApp, sshStatus } from "../../src/lifecycle.js";

const mocks = vi.hoisted(() => ({
  cfEnableSsh: vi.fn<(target: unknown, context: unknown, options: unknown) => Promise<void>>(),
  cfRestartApp: vi.fn<(target: unknown, context: unknown, options: unknown) => Promise<void>>(),
  cfSshEnabled: vi.fn<(target: unknown, context: unknown, options: unknown) => Promise<boolean>>(),
  markSessionsStaleForTarget: vi.fn<() => Promise<readonly unknown[]>>(),
}));

vi.mock("../../src/cf/client.js", () => ({
  cfEnableSsh: mocks.cfEnableSsh,
  cfRestartApp: mocks.cfRestartApp,
  cfSshEnabled: mocks.cfSshEnabled,
}));

vi.mock("../../src/discovery/runner.js", () => ({
  withPreparedCfSession: async (
    _target: unknown,
    _runtime: unknown,
    work: (context: { readonly cfHomeDir: string }) => Promise<unknown>,
  ): Promise<unknown> => await work({ cfHomeDir: "/tmp/cf-home" }),
}));

vi.mock("../../src/session/storage.js", () => ({
  markSessionsStaleForTarget: mocks.markSessionsStaleForTarget,
}));

const target = { region: "ap10", org: "org", space: "dev", app: "demo-app" } as const;

describe("lifecycle API", () => {
  beforeEach(() => {
    mocks.cfEnableSsh.mockReset();
    mocks.cfRestartApp.mockReset();
    mocks.cfSshEnabled.mockReset();
    mocks.markSessionsStaleForTarget.mockReset();
    mocks.markSessionsStaleForTarget.mockResolvedValue([]);
  });

  it("reports SSH status without mutating app state", async () => {
    mocks.cfSshEnabled.mockResolvedValue(true);
    const result = await sshStatus({ target });
    expect(result.status).toBe("enabled");
    expect(result.changed).toBe(false);
    expect(mocks.cfEnableSsh).not.toHaveBeenCalled();

    mocks.cfSshEnabled.mockResolvedValue(false);
    await expect(sshStatus({ target, process: "worker" }))
      .resolves.toMatchObject({ status: "disabled", meta: { process: "worker" } });

    mocks.cfSshEnabled.mockResolvedValue(true);
    await sshStatus({ target, runtime: { timeoutMs: 1234, maxBytes: 5678 } });
    expect(mocks.cfSshEnabled).toHaveBeenLastCalledWith(
      target,
      expect.objectContaining({ cfHomeDir: "/tmp/cf-home" }),
      { timeoutMs: 1234, maxBytes: 5678 },
    );
  });

  it("rejects instance selectors for app-level lifecycle operations", async () => {
    await expect(sshStatus({ target, instance: 1 })).rejects.toMatchObject({ code: "UNSAFE_INPUT" });
    await expect(restartApp({ target, confirmImpact: true, allInstances: true }))
      .rejects.toMatchObject({ code: "UNSAFE_INPUT" });
    expect(mocks.cfRestartApp).not.toHaveBeenCalled();
  });

  it("requires confirmation before enabling SSH", async () => {
    await expect(enableSsh({ target })).rejects.toThrow(CfExplorerError);
    await enableSsh({ target, confirmImpact: true });
    expect(mocks.cfEnableSsh).toHaveBeenCalledTimes(1);
  });

  it("marks matching sessions stale after restart", async () => {
    const result = await restartApp({ target, confirmImpact: true });
    expect(result.status).toBe("restarted");
    await restartApp({
      target,
      confirmImpact: true,
      runtime: { homeDir: "/tmp/explorer-home", timeoutMs: 4321, maxBytes: 8765 },
    });
    expect(mocks.cfRestartApp).toHaveBeenCalledTimes(2);
    expect(mocks.cfRestartApp).toHaveBeenLastCalledWith(
      target,
      expect.objectContaining({ cfHomeDir: "/tmp/cf-home" }),
      { timeoutMs: 4321, maxBytes: 8765 },
    );
    expect(mocks.markSessionsStaleForTarget).toHaveBeenCalledWith(
      expect.any(String),
      target,
      "App restart invalidated the SSH session.",
    );
    expect(mocks.markSessionsStaleForTarget).toHaveBeenCalledWith(
      "/tmp/explorer-home",
      target,
      "App restart invalidated the SSH session.",
    );
  });

  it("prepares SSH only when it is currently disabled", async () => {
    mocks.cfSshEnabled.mockResolvedValueOnce(true);
    await expect(prepareSsh({ target })).resolves.toMatchObject({ changed: false });

    mocks.cfSshEnabled.mockResolvedValueOnce(false);
    await expect(prepareSsh({ target })).rejects.toThrow(CfExplorerError);

    mocks.cfSshEnabled.mockResolvedValueOnce(false);
    const result = await prepareSsh({ target, confirmImpact: true });
    expect(result.changed).toBe(true);
    expect(mocks.cfEnableSsh).toHaveBeenCalledTimes(1);
    expect(mocks.cfRestartApp).toHaveBeenCalledTimes(1);
  });
});
