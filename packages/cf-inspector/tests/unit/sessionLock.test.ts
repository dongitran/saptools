import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Target } from "../../src/cli/commandTypes.js";
import {
  acquireDebugSessionLock,
  debugTargetIdentity,
} from "../../src/cli/sessionLock.js";
import { CfInspectorError } from "../../src/types.js";

const roots: string[] = [];
const portTarget: Target = { kind: "port", host: "127.0.0.1", port: 9229 };

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cf-inspector-lock-test-"));
  roots.push(root);
  return root;
}

describe("debug session lock", () => {
  it("acquires when free and releases only its own lock file", async () => {
    const root = await stateRoot();
    const lock = await acquireDebugSessionLock(portTarget, {
      stateRoot: root,
      pid: 101,
      token: () => "owner",
      isProcessAlive: () => true,
    });
    const stored = JSON.parse(await readFile(lock.path, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({ pid: 101, token: "owner" });

    await lock.release();
    await expect(readFile(lock.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("refuses a second live owner with an actionable dedicated error", async () => {
    const root = await stateRoot();
    const first = await acquireDebugSessionLock(portTarget, {
      stateRoot: root,
      pid: 201,
      token: () => "first",
      now: () => new Date("2026-07-23T01:02:03.000Z"),
      isProcessAlive: () => true,
    });
    let error: unknown;
    try {
      await acquireDebugSessionLock(portTarget, {
        stateRoot: root,
        pid: 202,
        token: () => "second",
        isProcessAlive: () => true,
      });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CfInspectorError);
    expect(error).toMatchObject({ code: "TARGET_ALREADY_DEBUGGED" });
    expect((error as Error).message).toContain("PID 201");
    expect((error as Error).message).toContain("disrupt real application traffic");
    await first.release();
  });

  it("reclaims a lock whose recorded process is dead", async () => {
    const root = await stateRoot();
    const stale = await acquireDebugSessionLock(portTarget, {
      stateRoot: root,
      pid: 301,
      token: () => "stale",
      isProcessAlive: () => true,
    });
    const replacement = await acquireDebugSessionLock(portTarget, {
      stateRoot: root,
      pid: 302,
      token: () => "replacement",
      isProcessAlive: (pid) => pid !== 301,
    });

    await expect(readFile(stale.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await replacement.release();
  });

  it("does not delete a replacement lock when an old owner releases late", async () => {
    const root = await stateRoot();
    const stale = await acquireDebugSessionLock(portTarget, {
      stateRoot: root,
      pid: 401,
      token: () => "stale",
      isProcessAlive: () => true,
    });
    const replacement = await acquireDebugSessionLock(portTarget, {
      stateRoot: root,
      pid: 402,
      token: () => "replacement",
      isProcessAlive: (pid) => pid !== 401,
    });

    await stale.release();
    await expect(readFile(replacement.path, "utf8")).resolves.toContain("replacement");
    await replacement.release();
  });

  it("uses one identity for implicit target zero and localhost aliases", () => {
    expect(debugTargetIdentity(portTarget)).toBe(debugTargetIdentity({
      kind: "port",
      host: "localhost",
      port: 9229,
      targetIndex: 0,
      workerId: "7",
    }));
  });

  it("keys CF locks by app identity even when one invocation supplies an API override", () => {
    const base: Target = {
      kind: "cf",
      region: "eu10",
      org: "example-org",
      space: "dev",
      app: "worker-app",
      tunnelTimeoutMs: 180_000,
    };
    expect(debugTargetIdentity(base)).toBe(debugTargetIdentity({
      ...base,
      apiEndpoint: "https://api.cf.eu10.example",
      workerId: "3",
    }));
  });

  it("fails closed on a newly-created corrupt contender", async () => {
    const root = await stateRoot();
    const lock = await acquireDebugSessionLock(portTarget, {
      stateRoot: root,
      pid: 501,
      token: () => "owner",
      isProcessAlive: () => true,
    });
    await writeFile(lock.path, "incomplete", "utf8");

    await expect(acquireDebugSessionLock(portTarget, {
      stateRoot: root,
      pid: 502,
      token: () => "contender",
      isProcessAlive: () => true,
    })).rejects.toMatchObject({ code: "TARGET_ALREADY_DEBUGGED" });
  });

  it("elects exactly one owner when two first contenders acquire simultaneously", async () => {
    const root = await stateRoot();
    const attempts = await Promise.allSettled([
      acquireDebugSessionLock(portTarget, {
        stateRoot: root,
        pid: 601,
        token: () => "a",
        isProcessAlive: () => true,
        getProcessStart: () => undefined,
      }),
      acquireDebugSessionLock(portTarget, {
        stateRoot: root,
        pid: 602,
        token: () => "b",
        isProcessAlive: () => true,
        getProcessStart: () => undefined,
      }),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "TARGET_ALREADY_DEBUGGED" });
    if (fulfilled[0]?.status === "fulfilled") {
      await fulfilled[0].value.release();
    }
  });

  it("reclaims a live PID when its process-start fingerprint no longer matches", async () => {
    const root = await stateRoot();
    let start = "old-process-start";
    const stale = await acquireDebugSessionLock(portTarget, {
      stateRoot: root,
      pid: 701,
      token: () => "stale",
      isProcessAlive: () => true,
      getProcessStart: () => start,
    });
    start = "reused-pid-start";
    const replacement = await acquireDebugSessionLock(portTarget, {
      stateRoot: root,
      pid: 702,
      token: () => "replacement",
      isProcessAlive: () => true,
      getProcessStart: (pid) => pid === 701 ? start : "replacement-start",
    });

    await expect(readFile(stale.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await replacement.release();
  });
});
