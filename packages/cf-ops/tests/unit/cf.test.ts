import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LifecyclePlan, ScalePlan } from "../../src/types.js";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function succeedWith(stdout: string) {
  return (_cmd: string, _args: readonly string[], _opts: unknown, cb: ExecFileCallback): void => {
    cb(null, stdout, "");
  };
}

function failWith(message: string, stderr: string) {
  return (_cmd: string, _args: readonly string[], _opts: unknown, cb: ExecFileCallback): void => {
    cb(Object.assign(new Error(message), { stderr }), "", stderr);
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("node:child_process");
});

describe("runCf", () => {
  it("runs cf commands with argument arrays", async () => {
    const execFileMock = vi.fn(succeedWith("ok\n"));
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { runCf } = await import("../../src/cf.js");
    await expect(runCf(["apps"], { command: "cf-test" })).resolves.toBe("ok\n");
    expect(execFileMock).toHaveBeenCalledWith(
      "cf-test",
      ["apps"],
      expect.objectContaining({ maxBuffer: 16 * 1024 * 1024 }),
      expect.any(Function),
    );
  });

  it("redacts SAP credential environment variables from child process env", async () => {
    const execFileMock = vi.fn(succeedWith("ok"));
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { runCf } = await import("../../src/cf.js");
    await runCf(["apps"], { env: { SAP_EMAIL: "user@example.com", SAP_PASSWORD: "secret" } });
    const options = execFileMock.mock.calls[0]?.[2] as { readonly env: NodeJS.ProcessEnv };
    expect(options.env["SAP_EMAIL"]).toBeUndefined();
    expect(options.env["SAP_PASSWORD"]).toBeUndefined();
  });

  it("runs JavaScript fake CF binaries through the current Node executable", async () => {
    const execFileMock = vi.fn(succeedWith("ok"));
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { runCf } = await import("../../src/cf.js");
    await runCf(["apps"], { command: "/tmp/fake-cf.mjs" });
    expect(execFileMock).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/fake-cf.mjs", "apps"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("wraps cf failures with the command and stderr detail", async () => {
    const execFileMock = vi.fn(failWith("boom", "app not found"));
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { runCf } = await import("../../src/cf.js");
    await expect(runCf(["restart", "ghost"])).rejects.toThrow("cf restart ghost failed: app not found");
  });
});

describe("command argument builders", () => {
  it("builds lifecycle and scale command arrays without executing cf", async () => {
    const { lifecycleCommandArgs, scaleCommandArgs } = await import("../../src/cf.js");
    expect(lifecycleCommandArgs({ appName: "orders-srv", action: "restart", strategy: "rolling" })).toEqual([
      "restart",
      "orders-srv",
      "--strategy",
      "rolling",
    ]);
    expect(
      scaleCommandArgs({
        appName: "orders-srv",
        args: ["scale", "orders-srv", "-i", "2"],
        restartAfterScale: { appName: "orders-srv", action: "restart", strategy: "default" },
      }),
    ).toEqual([
      ["scale", "orders-srv", "-i", "2"],
      ["restart", "orders-srv"],
    ]);
  });
});

describe("runLifecycle", () => {
  it("runs non-rolling lifecycle actions directly", async () => {
    const calls: string[][] = [];
    const execFileMock = vi.fn(
      (_cmd: string, args: string[], _opts: unknown, cb: ExecFileCallback): void => {
        calls.push(args);
        cb(null, "ok", "");
      },
    );
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { runLifecycle } = await import("../../src/cf.js");
    const plan: LifecyclePlan = { appName: "orders-srv", action: "restage", strategy: "default" };
    await runLifecycle(plan);
    expect(calls).toEqual([["restage", "orders-srv"]]);
  });

  it("uses cf restart --strategy rolling for rolling restarts", async () => {
    const calls: readonly string[][] = [];
    const execFileMock = vi.fn(
      (_cmd: string, args: string[], _opts: unknown, cb: ExecFileCallback): void => {
        (calls as string[][]).push(args);
        cb(null, "ok", "");
      },
    );
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { runLifecycle } = await import("../../src/cf.js");
    const plan: LifecyclePlan = { appName: "orders-srv", action: "restart", strategy: "rolling" };
    await runLifecycle(plan);
    expect(calls).toEqual([["restart", "orders-srv", "--strategy", "rolling"]]);
  });
});

describe("runScale", () => {
  it("runs scale before optional restart", async () => {
    const calls: string[][] = [];
    const execFileMock = vi.fn(
      (_cmd: string, args: string[], _opts: unknown, cb: ExecFileCallback): void => {
        calls.push(args);
        cb(null, "ok", "");
      },
    );
    vi.doMock("node:child_process", () => ({ execFile: execFileMock }));
    const { runScale } = await import("../../src/cf.js");
    const plan: ScalePlan = {
      appName: "orders-srv",
      args: ["scale", "orders-srv", "-i", "2"],
      restartAfterScale: { appName: "orders-srv", action: "restart", strategy: "default" },
    };
    await runScale(plan);
    expect(calls).toEqual([
      ["scale", "orders-srv", "-i", "2"],
      ["restart", "orders-srv"],
    ]);
  });
});
