import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeRemoteScript, withPreparedCfSession } from "../../src/discovery/runner.js";

const mocks = vi.hoisted(() => ({
  cfSshOneShot: vi.fn<
    (
      target: unknown,
      script: string,
      context: { readonly cfHomeDir: string },
      processName: string,
      instance: number,
      options: unknown,
    ) => Promise<{ readonly stdout: string; readonly durationMs: number; readonly truncated: boolean }>
  >(),
  prepareCfCliSession: vi.fn<
    (target: unknown, cfHomeDir: string, runtime: unknown) => Promise<{
      readonly context: { readonly cfHomeDir: string };
      readonly target: unknown;
    }>
  >(),
}));

vi.mock("../../src/cf/client.js", () => ({
  cfSshOneShot: mocks.cfSshOneShot,
  prepareCfCliSession: mocks.prepareCfCliSession,
}));

describe("one-shot remote runner", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "cf-explorer-runner-"));
    mocks.cfSshOneShot.mockReset();
    mocks.prepareCfCliSession.mockReset();
    mocks.prepareCfCliSession.mockImplementation(async (_target, cfHomeDir) => ({
      context: { cfHomeDir },
      target: _target,
    }));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("prepares an isolated temporary CF home and removes it after work", async () => {
    let observedCfHome = "";
    const result = await withPreparedCfSession(
      { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      { homeDir },
      async (context) => {
        observedCfHome = context.cfHomeDir;
        return "ok";
      },
    );

    await expect(stat(join(homeDir, "tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(result).toBe("ok");
    expect(observedCfHome).toContain(join(homeDir, "tmp"));
  });

  it("executes a generated script through one CF SSH command", async () => {
    mocks.cfSshOneShot.mockResolvedValue({
      stdout: "CFX\tROOT\t/workspace/app\n",
      durationMs: 12,
      truncated: false,
    });

    const result = await executeRemoteScript({
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      processName: "web",
      instance: 1,
      script: "printf ok",
      runtime: { homeDir },
      timeoutMs: 5000,
      maxBytes: 1024,
    });

    expect(result.stdout).toContain("/workspace/app");
    expect(mocks.cfSshOneShot).toHaveBeenCalledWith(
      expect.objectContaining({ app: "demo-app" }),
      "printf ok",
      expect.objectContaining({ cfHomeDir: expect.any(String) }),
      "web",
      1,
      { timeoutMs: 5000, maxBytes: 1024 },
    );
  });

  it("omits optional execution limits when callers do not provide them", async () => {
    mocks.cfSshOneShot.mockResolvedValue({
      stdout: "ok\n",
      durationMs: 1,
      truncated: false,
    });
    await executeRemoteScript({
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      processName: "web",
      instance: 0,
      script: "printf ok",
      runtime: { homeDir },
    });
    expect(mocks.cfSshOneShot).toHaveBeenLastCalledWith(
      expect.any(Object),
      "printf ok",
      expect.any(Object),
      "web",
      0,
      {},
    );
  });

  it("falls back to runtime timeout/maxBytes when per-call values are absent", async () => {
    mocks.cfSshOneShot.mockResolvedValue({
      stdout: "ok\n",
      durationMs: 1,
      truncated: false,
    });
    await executeRemoteScript({
      target: { region: "ap10", org: "org", space: "dev", app: "demo-app" },
      processName: "web",
      instance: 0,
      script: "printf ok",
      runtime: { homeDir, timeoutMs: 9000, maxBytes: 4096 },
    });
    expect(mocks.cfSshOneShot).toHaveBeenLastCalledWith(
      expect.any(Object),
      "printf ok",
      expect.any(Object),
      "web",
      0,
      { timeoutMs: 9000, maxBytes: 4096 },
    );
  });
});
