import { randomUUID } from "node:crypto";
import { access, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createTraceRun,
  pruneTraceRuns,
  purgeTraceRun,
  writeFullState,
  writeTraceEvent,
} from "../../src/run-store.js";

describe("private trace run store", () => {
  it("atomically writes private redacted artifacts", async () => {
    const root = join(tmpdir(), `cf-function-trace-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
      now: () => new Date("2026-07-18T00:00:00.000Z"),
    });
    try {
      const artifact = await writeFullState(run, 0, { token: "raw-secret-sentinel", count: 1 });
      await writeTraceEvent(run, {
        seq: 0,
        kind: "baseline",
        stateHash: artifact.hash,
        artifactKind: "full",
        changedPaths: [""],
      });
      const raw = await readFile(artifact.path, "utf8");
      expect(raw).not.toContain("raw-secret-sentinel");
      expect((await stat(run.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
      expect((await readdir(run.directory, { recursive: true })).some((name) => name.includes(".tmp-"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("purges only exact validated run IDs", async () => {
    const root = join(tmpdir(), `cf-function-trace-${randomUUID()}`);
    await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    await expect(purgeTraceRun("../data", { saptoolsRoot: root })).rejects.toMatchObject({ code: "INVALID_RUN_ID" });
    expect(await purgeTraceRun("t0123456789abcdef", { saptoolsRoot: root })).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("enforces retention and the maximum run count before adding a new run", async () => {
    const root = join(tmpdir(), `cf-function-trace-${randomUUID()}`);
    const runIds = ["t0000000000000001", "t0000000000000002", "t0000000000000003"] as const;
    try {
      for (const [index, runId] of runIds.entries()) {
        await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
          saptoolsRoot: root,
          runId,
          maxRuns: 2,
          now: () => new Date(Date.UTC(2026, 6, 18, 0, 0, index)),
        });
      }
      const stored = await readdir(join(root, "cf-function-trace", "data"));
      expect(stored.sort()).toEqual([runIds[1], runIds[2]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a manifest whose run ID does not match its directory", async () => {
    const root = join(tmpdir(), `cf-function-trace-${randomUUID()}`);
    const malicious = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0000000000000001",
    });
    const victim = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0000000000000002",
    });
    await writeFile(malicious.manifestPath, JSON.stringify({
      ...malicious.manifest,
      runId: victim.runId,
      expiresAt: "2000-01-01T00:00:00.000Z",
    }), "utf8");
    try {
      await pruneTraceRuns({ saptoolsRoot: root, now: () => new Date("2026-07-18T00:00:00.000Z") });
      await expect(access(victim.manifestPath)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects artifacts that would exceed the configured per-run disk quota", async () => {
    const root = join(tmpdir(), `cf-function-trace-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
      maxRunBytes: 1_024,
    });
    try {
      await expect(writeFullState(run, 0, { payload: "x".repeat(2_000) })).rejects.toMatchObject({
        code: "RUN_STORAGE_LIMIT",
      });
      expect((await readdir(run.statesDirectory)).some((name) => name.includes(".tmp-"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
