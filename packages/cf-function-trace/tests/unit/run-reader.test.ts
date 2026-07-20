import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalizeState } from "../../src/canonical-state.js";
import {
  listTraceRuns,
  readStateAt,
  readStatePath,
  readTraceEvents,
  readTraceManifest,
  resolveTraceRun,
} from "../../src/run-reader.js";
import { createTraceRun, writeFullState, writePatchState, writeTraceEvent } from "../../src/run-store.js";
import { diffStates } from "../../src/state-diff.js";

describe("trace run reader", () => {
  it("lists latest runs and replays full plus patch states", async () => {
    const root = join(tmpdir(), `cf-function-trace-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
      now: () => new Date("2026-07-18T00:00:00.000Z"),
    });
    try {
      const full = await writeFullState(run, 0, { order: { status: "new" } });
      const patch = diffStates({ order: { status: "new" } }, { order: { status: "done" } });
      await writePatchState(run, 1, 0, patch);
      await writeTraceEvent(run, {
        seq: 0,
        kind: "baseline",
        stateHash: full.hash,
        artifactKind: "full",
        changedPaths: [""],
      });
      await writeTraceEvent(run, {
        seq: 1,
        kind: "pause",
        stateHash: patch.after.hash,
        artifactKind: "patch",
        changedPaths: patch.changedPaths,
      });

      expect((await listTraceRuns({ saptoolsRoot: root }))[0]?.runId).toBe(run.runId);
      expect((await resolveTraceRun("latest", { saptoolsRoot: root })).runId).toBe(run.runId);
      expect(await readStateAt(run.runId, 1, { saptoolsRoot: root })).toEqual(patch.after.value);
      expect(await readStatePath(run.runId, 1, "/order/status", { saptoolsRoot: root })).toBe("done");
      await expect(readStatePath(run.runId, 1, "/toString", { saptoolsRoot: root })).rejects.toThrow("not found");
      await expect(readStatePath(run.runId, 1, "/order/~2invalid", { saptoolsRoot: root }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects artifacts whose embedded sequence differs from the file name", async () => {
    const root = join(tmpdir(), `cf-function-trace-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    const canonical = canonicalizeState({ order: { status: "new" } });
    try {
      await writeFile(join(run.statesDirectory, "000002.full.json"), JSON.stringify({
        version: 1,
        kind: "full",
        seq: 99,
        hash: canonical.hash,
        state: canonical.value,
      }), "utf8");
      await writeFile(join(run.eventsDirectory, "000002.json"), JSON.stringify({
        version: 1,
        seq: 99,
        kind: "pause",
        stateHash: canonical.hash,
        artifactKind: "full",
        changedPaths: [],
      }), "utf8");

      await expect(readStateAt(run.runId, 2, { saptoolsRoot: root })).rejects.toMatchObject({
        code: "INVALID_ARTIFACT",
      });
      await expect(readTraceEvents(run.runId, { saptoolsRoot: root })).rejects.toMatchObject({
        code: "INVALID_ARTIFACT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a manifest whose run ID differs from its directory", async () => {
    const root = join(tmpdir(), `cf-function-trace-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    try {
      await writeFile(run.manifestPath, JSON.stringify({
        ...run.manifest,
        runId: "t1111111111111111",
      }), "utf8");

      await expect(readTraceManifest(run.runId, { saptoolsRoot: root })).rejects.toMatchObject({
        code: "INVALID_ARTIFACT",
      });
      expect(await listTraceRuns({ saptoolsRoot: root })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps a nonexistent but well-formed run ID to RUN_NOT_FOUND without leaking a filesystem path", async () => {
    // P0-9: readTraceManifest previously wrapped ANY manifest read failure,
    // including plain ENOENT for a run that simply doesn't exist, as
    // INVALID_ARTIFACT with the raw underlying fs error text (an absolute
    // local path). A well-formed but nonexistent run ID must get the same
    // clean RUN_NOT_FOUND code the "latest, but store is empty" path already
    // uses, with no filesystem path in the message.
    const root = join(tmpdir(), `cf-function-trace-${randomUUID()}`);
    try {
      let caught: unknown;
      try {
        await readTraceManifest("t0000000000000000", { saptoolsRoot: root });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).toMatchObject({ code: "RUN_NOT_FOUND" });
      expect(caught instanceof Error ? caught.message : "").not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an exact event sequence and verifies its replayed state hash", async () => {
    const root = join(tmpdir(), `cf-function-trace-${randomUUID()}`);
    const run = await createTraceRun({ sourceUrl: "file:///app.js", functionSelector: "run" }, {
      saptoolsRoot: root,
      runId: "t0123456789abcdef",
    });
    try {
      const full = await writeFullState(run, 0, { status: "stable" });
      await writeTraceEvent(run, {
        seq: 0,
        kind: "baseline",
        stateHash: full.hash,
        artifactKind: "full",
        changedPaths: [""],
      });
      await writeTraceEvent(run, {
        seq: 1,
        kind: "pause",
        stateHash: full.hash,
        artifactKind: "unchanged",
        changedPaths: [],
      });

      await expect(readStateAt(run.runId, 1, { saptoolsRoot: root })).resolves.toEqual({ status: "stable" });
      await expect(readStateAt(run.runId, 2, { saptoolsRoot: root })).rejects.toMatchObject({
        code: "STATE_NOT_FOUND",
      });

      await writeFile(join(run.eventsDirectory, "000001.json"), JSON.stringify({
        version: 1,
        seq: 1,
        kind: "pause",
        stateHash: "0".repeat(64),
        artifactKind: "unchanged",
        changedPaths: [],
      }), "utf8");
      await expect(readStateAt(run.runId, 1, { saptoolsRoot: root })).rejects.toMatchObject({
        code: "STATE_HASH_MISMATCH",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
