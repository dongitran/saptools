import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identityMocks = vi.hoisted(() => ({
  inspectProcessIdentity: vi.fn(),
  readProcessIdentity: vi.fn(),
}));

vi.mock("../../src/debug-session/process-identity.js", () => ({
  inspectProcessIdentity: identityMocks.inspectProcessIdentity,
  readProcessIdentity: identityMocks.readProcessIdentity,
}));

const { withFileLock } = await import("../../src/lock.js");

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-recovery-race-"));
  identityMocks.inspectProcessIdentity.mockResolvedValue("match");
  identityMocks.readProcessIdentity.mockResolvedValue("linux:v1:1");
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe("recovery lock reclamation", () => {
  it("does not unlink a new live main-lock owner that replaces the observed stale owner", async () => {
    const lockPath = join(tempDir, "state.lock");
    await writeFile(lockPath, JSON.stringify({
      hostname: hostname(),
      pid: process.pid,
      processIdentity: "linux:v1:0",
      token: "observed-stale-owner",
      version: "1",
    }), "utf8");

    let finishInspection: (verdict: "mismatch") => void = () => undefined;
    let inspectionStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      inspectionStarted = resolve;
    });
    identityMocks.inspectProcessIdentity
      .mockImplementationOnce(async () => await new Promise<"mismatch">((resolve) => {
        finishInspection = resolve;
        inspectionStarted();
      }))
      .mockResolvedValue("match");

    const acquisition = withFileLock(
      lockPath,
      async (): Promise<string> => "unexpectedly-acquired",
      { pollMs: 5, staleMs: 10, timeoutMs: 80 },
    );
    await started;
    await writeFile(lockPath, JSON.stringify({
      hostname: hostname(),
      pid: process.pid,
      processIdentity: "linux:v1:1",
      token: "new-live-owner",
      version: "1",
    }), "utf8");
    finishInspection("mismatch");

    await expect(acquisition).rejects.toMatchObject({ code: "STATE_LOCK_TIMEOUT" });
    const retained = JSON.parse(await readFile(lockPath, "utf8")) as {
      readonly token?: unknown;
    };
    expect(retained.token).toBe("new-live-owner");
  });

  it("does not unlink a new live owner that replaces the observed stale owner", async () => {
    const lockPath = join(tempDir, "state.lock");
    const recoveryPath = `${lockPath}.recovery`;
    await writeFile(lockPath, JSON.stringify({
      hostname: hostname(),
      pid: 2_147_483_647,
      token: "dead-state-owner",
      version: "1",
    }), "utf8");
    await writeFile(recoveryPath, JSON.stringify({
      hostname: hostname(),
      pid: process.pid,
      processIdentity: "linux:v1:0",
      token: "observed-stale-owner",
      version: "1",
    }), "utf8");

    let finishInspection: (verdict: "mismatch") => void = () => undefined;
    let inspectionStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      inspectionStarted = resolve;
    });
    identityMocks.inspectProcessIdentity
      .mockImplementationOnce(async () => await new Promise<"mismatch">((resolve) => {
        finishInspection = resolve;
        inspectionStarted();
      }))
      .mockResolvedValue("match");

    const acquisition = withFileLock(
      lockPath,
      async (): Promise<string> => "unexpectedly-acquired",
      { pollMs: 5, staleMs: 10, timeoutMs: 80 },
    );
    await started;
    await writeFile(recoveryPath, JSON.stringify({
      hostname: hostname(),
      pid: process.pid,
      processIdentity: "linux:v1:1",
      token: "new-live-owner",
      version: "1",
    }), "utf8");
    finishInspection("mismatch");

    await expect(acquisition).rejects.toMatchObject({ code: "STATE_LOCK_TIMEOUT" });
    const retained = JSON.parse(await readFile(recoveryPath, "utf8")) as {
      readonly token?: unknown;
    };
    expect(retained.token).toBe("new-live-owner");
  });
});
