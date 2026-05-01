import { setTimeout as sleep } from "node:timers/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createExplorer,
  findRemote,
  grepRemote,
  inspectCandidates,
  listInstances,
  roots,
  viewRemote,
} from "../../src/api.js";
import { CfExplorerError } from "../../src/errors.js";

const mocks = vi.hoisted(() => ({
  cfApp: vi.fn<
    (
      target: unknown,
      context: unknown,
      options: unknown,
    ) => Promise<string>
  >(),
  executeRemoteScript: vi.fn<
    (input: { readonly instance: number }) => Promise<{
      readonly stdout: string;
      readonly durationMs: number;
      readonly truncated: boolean;
    }>
  >(),
  executeRemoteScriptWithContext: vi.fn<
    (input: { readonly instance: number }, context: unknown) => Promise<{
      readonly stdout: string;
      readonly durationMs: number;
      readonly truncated: boolean;
    }>
  >(),
}));

vi.mock("../../src/cf.js", () => ({
  cfApp: mocks.cfApp,
}));

vi.mock("../../src/runner.js", () => ({
  executeRemoteScript: mocks.executeRemoteScript,
  executeRemoteScriptWithContext: mocks.executeRemoteScriptWithContext,
  withPreparedCfSession: async (
    _target: unknown,
    _runtime: unknown,
    work: (context: { readonly cfHomeDir: string }) => Promise<unknown>,
  ): Promise<unknown> => await work({ cfHomeDir: "/tmp/cf-home" }),
}));

const target = { region: "ap10", org: "org", space: "dev", app: "demo-app" } as const;

describe("discovery API", () => {
  beforeEach(() => {
    mocks.cfApp.mockReset();
    mocks.executeRemoteScript.mockReset();
    mocks.executeRemoteScriptWithContext.mockReset();
    // All-instance flows share one prepared CF session via
    // executeRemoteScriptWithContext; delegate to the same fake so existing
    // executeRemoteScript expectations remain useful.
    mocks.executeRemoteScriptWithContext.mockImplementation(async (input) => await mocks.executeRemoteScript(input));
  });

  it("measures all-instance duration after the instance work completes", async () => {
    mocks.cfApp.mockResolvedValue([
      "instances: 2/2",
      "     state     since",
      "#0   running   today",
      "#1   running   today",
    ].join("\n"));
    mocks.executeRemoteScript.mockImplementation(async (input) => {
      await sleep(20);
      return {
        stdout: `CFX\tGREP\t/workspace/app/src/${input.instance.toString()}.js\t1\tneedle\n`,
        durationMs: 20,
        truncated: false,
      };
    });

    const result = await grepRemote({
      target,
      root: "/workspace/app",
      text: "needle",
      allInstances: true,
    });

    expect(result.instances).toHaveLength(2);
    expect(result.instances?.every((item) => item.durationMs >= 15)).toBe(true);
  });

  it("passes effective timeout and output limits to cf app instance reads", async () => {
    mocks.cfApp.mockResolvedValue("instances: 1/1\n#0 running today\n");

    await listInstances({ target, timeoutMs: 1234, maxBytes: 5678 });
    expect(mocks.cfApp).toHaveBeenLastCalledWith(
      target,
      expect.objectContaining({ cfHomeDir: "/tmp/cf-home" }),
      { timeoutMs: 1234, maxBytes: 5678 },
    );

    await listInstances({ target, runtime: { timeoutMs: 2222, maxBytes: 3333 } });
    expect(mocks.cfApp).toHaveBeenLastCalledWith(
      target,
      expect.objectContaining({ cfHomeDir: "/tmp/cf-home" }),
      { timeoutMs: 2222, maxBytes: 3333 },
    );
  });

  it("aggregates all-instance successes and partial failures", async () => {
    mocks.cfApp.mockResolvedValue([
      "instances: 2/2",
      "     state     since",
      "#0   running   today",
      "#1   running   today",
    ].join("\n"));
    mocks.executeRemoteScript.mockImplementation(async (input) => {
      if (input.instance === 1) {
        throw new CfExplorerError("REMOTE_COMMAND_FAILED", "remote failed");
      }
      return {
        stdout: "CFX\tFIND\tfile\t/workspace/app/src/connect.js\n",
        durationMs: 4,
        truncated: false,
      };
    });

    const result = await findRemote({
      target,
      root: "/workspace/app",
      name: "connect",
      allInstances: true,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.instances).toEqual([
      expect.objectContaining({ instance: 0, ok: true }),
      expect.objectContaining({
        instance: 1,
        ok: false,
        error: { code: "REMOTE_COMMAND_FAILED", message: "remote failed" },
      }),
    ]);
  });

  it("propagates all-instance truncation metadata", async () => {
    mocks.cfApp.mockResolvedValue([
      "instances: 2/2",
      "     state     since",
      "#0   running   today",
      "#1   running   today",
    ].join("\n"));
    mocks.executeRemoteScript.mockImplementation(async (input) => ({
      stdout: "CFX\tROOT\t/workspace/app\n",
      durationMs: 3,
      truncated: input.instance === 1,
    }));

    const result = await roots({ target, allInstances: true });

    expect(result.meta.truncated).toBe(true);
    expect(result.instances?.[0]).toMatchObject({ truncated: false });
    expect(result.instances?.[1]).toMatchObject({ truncated: true });
  });

  it("runs root and inspect discovery across all running instances", async () => {
    mocks.cfApp.mockResolvedValue([
      "instances: 2/2",
      "     state     since",
      "#0   running   today",
      "#1   running   today",
    ].join("\n"));
    mocks.executeRemoteScript.mockImplementation(async (input) => ({
      stdout: [
        "CFX\tROOT\t/workspace/app",
        `CFX\tFIND\tfile\t/workspace/app/src/${input.instance.toString()}.js`,
        `CFX\tGREP\t/workspace/app/src/${input.instance.toString()}.js\t1\tneedle`,
      ].join("\n"),
      durationMs: 5,
      truncated: false,
    }));

    await expect(roots({ target, allInstances: true })).resolves.toMatchObject({
      roots: ["/workspace/app"],
      instances: [expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })],
    });
    await expect(inspectCandidates({
      target,
      root: "/workspace/app",
      text: "needle",
      allInstances: true,
    })).resolves.toMatchObject({
      contentMatches: [{ line: 1 }, { line: 1 }],
      suggestedBreakpoints: [{ line: 1 }, { line: 1 }],
    });
  });

  it("keeps all-instance root aggregation stable when one instance fails", async () => {
    mocks.cfApp.mockResolvedValue([
      "instances: 2/2",
      "     state     since",
      "#0   running   today",
      "#1   running   today",
    ].join("\n"));
    mocks.executeRemoteScript.mockImplementation(async (input) => {
      if (input.instance === 1) {
        throw new Error("boom");
      }
      return {
        stdout: "CFX\tROOT\t/workspace/app\n",
        durationMs: 2,
        truncated: false,
      };
    });

    const result = await roots({ target, allInstances: true, process: "worker" });
    expect(result.meta.process).toBe("worker");
    expect(result.roots).toEqual(["/workspace/app"]);
    expect(result.instances?.[0]).toMatchObject({ ok: true });
    expect(result.instances?.[1]).toMatchObject({
      ok: false,
      error: { code: "REMOTE_COMMAND_FAILED" },
    });
  });

  it("builds one-shot discovery result shapes", async () => {
    mocks.cfApp.mockResolvedValue("instances: 1/1\n#0 running today\n");
    mocks.executeRemoteScript
      .mockResolvedValueOnce({
        stdout: "CFX\tROOT\t/workspace/app\n",
        durationMs: 4,
        truncated: false,
      })
      .mockResolvedValueOnce({
        stdout: "CFX\tFIND\tfile\t/workspace/app/src/connect.js\n",
        durationMs: 5,
        truncated: false,
      })
      .mockResolvedValueOnce({
        stdout: "CFX\tLINE\t2\tneedle\n",
        durationMs: 6,
        truncated: false,
      })
      .mockResolvedValueOnce({
        stdout: [
          "CFX\tROOT\t/workspace/app",
          "CFX\tFIND\tfile\t/workspace/app/src/connect.js",
          "CFX\tGREP\t/workspace/app/src/connect.js\t2\tneedle",
        ].join("\n"),
        durationMs: 7,
        truncated: false,
      });

    await expect(listInstances({ target })).resolves.toMatchObject({
      instances: [{ index: 0, state: "running", since: "today" }],
    });
    await expect(roots({ target })).resolves.toMatchObject({ roots: ["/workspace/app"] });
    await expect(findRemote({ target, root: "/workspace/app", name: "connect" }))
      .resolves.toMatchObject({ matches: [{ path: "/workspace/app/src/connect.js" }] });
    await expect(viewRemote({ target, file: "/workspace/app/src/connect.js", line: 2 }))
      .resolves.toMatchObject({ startLine: 2, endLine: 2 });
    await expect(viewRemote({
      target,
      file: "/workspace/app/src/connect.js",
      line: 2,
      allInstances: true,
    })).rejects.toMatchObject({ code: "UNSAFE_INPUT" });
    await expect(inspectCandidates({ target, root: "/workspace/app", text: "needle" }))
      .resolves.toMatchObject({ suggestedBreakpoints: [{ line: 2 }] });
  });

  it("shares one prepared CF session across parallel instance work", async () => {
    mocks.cfApp.mockResolvedValue([
      "instances: 3/3",
      "     state     since",
      "#0   running   today",
      "#1   running   today",
      "#2   running   today",
    ].join("\n"));
    mocks.executeRemoteScript.mockResolvedValue({
      stdout: "CFX\tROOT\t/workspace/app\n",
      durationMs: 1,
      truncated: false,
    });
    await roots({ target, allInstances: true });
    expect(mocks.executeRemoteScriptWithContext).toHaveBeenCalledTimes(3);
  });

  it("throws INSTANCE_NOT_FOUND when no instances are running for all-instances aggregate", async () => {
    mocks.cfApp.mockResolvedValue([
      "instances: 0/2",
      "     state",
      "#0   stopped",
      "#1   crashed",
    ].join("\n"));
    await expect(roots({ target, allInstances: true }))
      .rejects.toMatchObject({ code: "INSTANCE_NOT_FOUND" });
  });

  it("runs single-instance grep with optional preview", async () => {
    mocks.executeRemoteScript.mockResolvedValue({
      stdout: "CFX\tGREP\t/workspace/app/src/connect.js\t2\tneedle preview\n",
      durationMs: 8,
      truncated: true,
    });

    await expect(grepRemote({
      target,
      root: "/workspace/app",
      text: "needle",
      preview: true,
      timeoutMs: 5000,
      maxBytes: 256,
    })).resolves.toMatchObject({
      meta: { instance: 0, truncated: true },
      matches: [{ preview: "needle preview" }],
    });
  });

  it("drops incomplete protocol rows from truncated one-shot output", async () => {
    mocks.executeRemoteScript
      .mockResolvedValueOnce({
        stdout: "CFX\tROOT\t/workspace/app\nCFX\tROOT\t/workspace/incomplete",
        durationMs: 4,
        truncated: true,
      })
      .mockResolvedValueOnce({
        stdout: "CFX\tFIND\tfile\t/workspace/app/src/connect.js\nCFX\tFIND\tfile\t/workspace/app/src/partial",
        durationMs: 5,
        truncated: true,
      });

    await expect(roots({ target })).resolves.toMatchObject({
      meta: { truncated: true },
      roots: ["/workspace/app"],
    });
    await expect(findRemote({ target, root: "/workspace/app", name: "connect" }))
      .resolves.toMatchObject({
        meta: { truncated: true },
        matches: [{ path: "/workspace/app/src/connect.js" }],
      });
  });

  it("creates an explorer facade over the public APIs", async () => {
    mocks.executeRemoteScript.mockResolvedValue({
      stdout: "CFX\tROOT\t/workspace/app\n",
      durationMs: 3,
      truncated: false,
    });
    const explorer = await createExplorer({ target, process: "worker" });
    await expect(explorer.roots()).resolves.toMatchObject({
      meta: { process: "worker" },
      roots: ["/workspace/app"],
    });
    mocks.cfApp.mockResolvedValue("instances: 1/1\n#0 running today\n");
    await expect(explorer.instances()).resolves.toMatchObject({
      meta: { process: "worker" },
      instances: [{ index: 0 }],
    });
    await expect(explorer.dispose()).resolves.toBeUndefined();
  });
});
