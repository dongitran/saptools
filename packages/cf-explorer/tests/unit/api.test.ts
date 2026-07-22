import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createExplorer,
  findRemote,
  grepRemote,
  inspectCandidates,
  listInstances,
  lsRemote,
  roots,
  viewRemote,
} from "../../src/discovery/api.js";

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
  prepareSshAccess: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../../src/cf/client.js", () => ({
  cfApp: mocks.cfApp,
}));

vi.mock("../../src/discovery/runner.js", () => ({
  executeRemoteScript: mocks.executeRemoteScript,
  executeRemoteScriptWithContext: mocks.executeRemoteScriptWithContext,
  prepareSshAccess: mocks.prepareSshAccess,
  withPreparedCfSession: async (
    _target: unknown,
    _runtime: unknown,
    work: (context: { readonly cfHomeDir: string }) => Promise<unknown>,
  ): Promise<unknown> => await work({ cfHomeDir: "/tmp/cf-home" }),
}));

const target = { region: "ap10", org: "org", space: "dev", app: "demo-app" } as const;

function remoteOutput(
  rows: readonly string[],
  durationMs: number,
  truncated = false,
): { readonly stdout: string; readonly durationMs: number; readonly truncated: boolean } {
  return {
    stdout: `${rows.join("\n")}\n`,
    durationMs,
    truncated,
  };
}

describe("discovery API", () => {
  beforeEach(() => {
    mocks.cfApp.mockReset();
    mocks.executeRemoteScript.mockReset();
    mocks.executeRemoteScriptWithContext.mockReset();
    mocks.prepareSshAccess.mockReset();
    mocks.prepareSshAccess.mockResolvedValue(false);
    // All-instance flows share one prepared CF session via
    // executeRemoteScriptWithContext; delegate to the same fake so existing
    // executeRemoteScript expectations remain useful.
    mocks.executeRemoteScriptWithContext.mockImplementation(async (input) => await mocks.executeRemoteScript(input));
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

    await listInstances({ target, runtime: { timeoutMs: 1111 } });
    expect(mocks.cfApp).toHaveBeenLastCalledWith(
      target,
      expect.objectContaining({ cfHomeDir: "/tmp/cf-home" }),
      { timeoutMs: 1111 },
    );

    await listInstances({ target });
    expect(mocks.cfApp).toHaveBeenLastCalledWith(
      target,
      expect.objectContaining({ cfHomeDir: "/tmp/cf-home" }),
      undefined,
    );
  });



  it("defaults to instance zero, honors explicit instance, and compacts inspect files", async () => {
    mocks.executeRemoteScript
      .mockResolvedValueOnce({
        stdout: "CFX\tGREP\t/workspace/app/src/default.js\t1\tneedle\n",
        durationMs: 2,
        truncated: false,
      })
      .mockResolvedValueOnce({
        stdout: "CFX\tGREP\t/workspace/app/src/worker.js\t3\tneedle\n",
        durationMs: 3,
        truncated: false,
      })
      .mockResolvedValueOnce({
        stdout: [
          "CFX\tROOT\t/workspace/app",
          "CFX\tFIND\tfile\t/workspace/app/src/connect.js",
          "CFX\tGREP\t/workspace/app/src/connect.js\t2\tneedle",
        ].join("\n"),
        durationMs: 4,
        truncated: false,
      })
      .mockResolvedValueOnce({
        stdout: [
          "CFX\tROOT\t/workspace/app",
          "CFX\tFIND\tfile\t/workspace/app/src/connect.js",
          "CFX\tGREP\t/workspace/app/src/connect.js\t2\tneedle",
        ].join("\n"),
        durationMs: 5,
        truncated: false,
      });

    await expect(grepRemote({ target, root: "/workspace/app", text: "needle" }))
      .resolves.toMatchObject({ meta: { instance: 0 } });
    await expect(grepRemote({ target, root: "/workspace/app", text: "needle", instance: 2 }))
      .resolves.toMatchObject({ meta: { instance: 2 }, matches: [{ instance: 2 }] });
    await expect(inspectCandidates({ target, root: "/workspace/app", text: "needle" }))
      .resolves.not.toHaveProperty("files");
    await expect(inspectCandidates({ target, root: "/workspace/app", text: "needle", includeFiles: true }))
      .resolves.toMatchObject({ files: [{ path: "/workspace/app/src/connect.js" }] });
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
        stdout: "CFX\tLS\tdirectory\tsrc\t/workspace/app/src\n",
        durationMs: 5,
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
    await expect(lsRemote({ target, path: "/workspace/app" }))
      .resolves.toMatchObject({ entries: [{ name: "src", kind: "directory" }] });
    await expect(findRemote({ target, root: "/workspace/app", name: "connect" }))
      .resolves.toMatchObject({ matches: [{ path: "/workspace/app/src/connect.js" }] });
    await expect(viewRemote({ target, file: "/workspace/app/src/connect.js", line: 2 }))
      .resolves.toMatchObject({ startLine: 2, endLine: 2 });
    await expect(inspectCandidates({ target, root: "/workspace/app", text: "needle" }))
      .resolves.toMatchObject({ suggestedBreakpoints: [{ line: 2 }] });
  });

  it("trims only probe-overflow rows and marks capped one-shot discovery results", async () => {
    mocks.executeRemoteScript
      .mockResolvedValueOnce(remoteOutput([
        "CFX\tROOT\t/workspace/a",
        "CFX\tROOT\t/workspace/b",
      ], 1))
      .mockResolvedValueOnce(remoteOutput([
        "CFX\tROOT\t/workspace/a",
        "CFX\tROOT\t/workspace/b",
        "CFX\tROOT\t/workspace/c",
      ], 2))
      .mockResolvedValueOnce(remoteOutput([
        "CFX\tLS\tfile\ta.js\t/workspace/app/a.js",
        "CFX\tLS\tfile\tb.js\t/workspace/app/b.js",
      ], 3))
      .mockResolvedValueOnce(remoteOutput([
        "CFX\tLS\tfile\ta.js\t/workspace/app/a.js",
        "CFX\tLS\tfile\tb.js\t/workspace/app/b.js",
        "CFX\tLS\tfile\tc.js\t/workspace/app/c.js",
      ], 4))
      .mockResolvedValueOnce(remoteOutput([
        "CFX\tFIND\tfile\t/workspace/app/a.js",
        "CFX\tFIND\tfile\t/workspace/app/b.js",
      ], 5))
      .mockResolvedValueOnce(remoteOutput([
        "CFX\tFIND\tfile\t/workspace/app/a.js",
        "CFX\tFIND\tfile\t/workspace/app/b.js",
        "CFX\tFIND\tfile\t/workspace/app/c.js",
      ], 6))
      .mockResolvedValueOnce(remoteOutput([
        "CFX\tGREP\t/workspace/app/a.js\t1\t",
        "CFX\tGREP\t/workspace/app/b.js\t2\t",
      ], 7))
      .mockResolvedValueOnce(remoteOutput([
        "CFX\tGREP\t/workspace/app/a.js\t1\t",
        "CFX\tGREP\t/workspace/app/b.js\t2\t",
        "CFX\tGREP\t/workspace/app/c.js\t3\t",
      ], 8))
      .mockResolvedValueOnce(remoteOutput([
        "CFX\tROOT\t/workspace/a",
        "CFX\tROOT\t/workspace/b",
        "CFX\tFIND\tfile\t/workspace/a/a.js",
        "CFX\tFIND\tfile\t/workspace/b/b.js",
        "CFX\tGREP\t/workspace/a/a.js\t1\t",
        "CFX\tGREP\t/workspace/b/b.js\t2\t",
      ], 9))
      .mockResolvedValueOnce(remoteOutput([
        "CFX\tROOT\t/workspace/a",
        "CFX\tROOT\t/workspace/b",
        "CFX\tROOT\t/workspace/c",
        "CFX\tFIND\tfile\t/workspace/a/a.js",
        "CFX\tFIND\tfile\t/workspace/b/b.js",
        "CFX\tFIND\tfile\t/workspace/c/c.js",
        "CFX\tGREP\t/workspace/a/a.js\t1\t",
        "CFX\tGREP\t/workspace/b/b.js\t2\t",
        "CFX\tGREP\t/workspace/c/c.js\t3\t",
      ], 10));

    const exactRoots = await roots({ target, maxFiles: 2 });
    const cappedRoots = await roots({ target, maxFiles: 2 });
    expect(exactRoots.meta.truncated).toBe(false);
    expect(exactRoots.roots).toEqual(["/workspace/a", "/workspace/b"]);
    expect(cappedRoots.meta.truncated).toBe(true);
    expect(cappedRoots.roots).toEqual(["/workspace/a", "/workspace/b"]);

    const exactLs = await lsRemote({ target, path: "/workspace/app", maxFiles: 2 });
    const cappedLs = await lsRemote({ target, path: "/workspace/app", maxFiles: 2 });
    expect(exactLs.meta.truncated).toBe(false);
    expect(exactLs.entries.map((entry) => entry.name)).toEqual(["a.js", "b.js"]);
    expect(cappedLs.meta.truncated).toBe(true);
    expect(cappedLs.entries.map((entry) => entry.name)).toEqual(["a.js", "b.js"]);

    const exactFind = await findRemote({ target, root: "/workspace/app", name: "*.js", maxFiles: 2 });
    const cappedFind = await findRemote({ target, root: "/workspace/app", name: "*.js", maxFiles: 2 });
    expect(exactFind.meta.truncated).toBe(false);
    expect(exactFind.matches.map((match) => match.path)).toEqual([
      "/workspace/app/a.js",
      "/workspace/app/b.js",
    ]);
    expect(cappedFind.meta.truncated).toBe(true);
    expect(cappedFind.matches.map((match) => match.path)).toEqual([
      "/workspace/app/a.js",
      "/workspace/app/b.js",
    ]);

    const exactGrep = await grepRemote({
      target,
      root: "/workspace/app",
      text: "needle",
      maxMatches: 2,
    });
    const cappedGrep = await grepRemote({
      target,
      root: "/workspace/app",
      text: "needle",
      maxMatches: 2,
    });
    expect(exactGrep.meta.truncated).toBe(false);
    expect(exactGrep.matches.map((match) => match.line)).toEqual([1, 2]);
    expect(cappedGrep.meta.truncated).toBe(true);
    expect(cappedGrep.matches.map((match) => match.line)).toEqual([1, 2]);

    const inspectInput = {
      target,
      text: "needle",
      includeFiles: true,
      maxFiles: 2,
      maxMatches: 2,
    } as const;
    const exactInspect = await inspectCandidates(inspectInput);
    const cappedInspect = await inspectCandidates(inspectInput);
    expect(exactInspect.meta.truncated).toBe(false);
    expect(exactInspect.roots).toEqual(["/workspace/a", "/workspace/b"]);
    expect(exactInspect.files?.map((match) => match.path)).toEqual([
      "/workspace/a/a.js",
      "/workspace/b/b.js",
    ]);
    expect(exactInspect.contentMatches.map((match) => match.line)).toEqual([1, 2]);
    expect(exactInspect.suggestedBreakpoints.map((breakpoint) => breakpoint.line)).toEqual([1, 2]);
    expect(cappedInspect.meta.truncated).toBe(true);
    expect(cappedInspect.roots).toEqual(["/workspace/a", "/workspace/b"]);
    expect(cappedInspect.files?.map((match) => match.path)).toEqual([
      "/workspace/a/a.js",
      "/workspace/b/b.js",
    ]);
    expect(cappedInspect.contentMatches.map((match) => match.line)).toEqual([1, 2]);
    expect(cappedInspect.suggestedBreakpoints.map((breakpoint) => breakpoint.line)).toEqual([1, 2]);
  });




  it("preserves byte truncation while running single-instance grep with optional preview", async () => {
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
