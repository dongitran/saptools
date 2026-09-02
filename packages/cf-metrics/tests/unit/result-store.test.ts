import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearResultSessions,
  createResultSession,
  listResultSessions,
  pruneResultSessions,
  readResultSession,
  resultStoreOptionsFromEnv,
} from "../../src/result-store.js";

describe("resultStoreOptionsFromEnv", () => {
  const originalValue = process.env["CF_METRICS_SAPTOOLS_ROOT"];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env["CF_METRICS_SAPTOOLS_ROOT"];
    } else {
      process.env["CF_METRICS_SAPTOOLS_ROOT"] = originalValue;
    }
  });

  it("returns an empty options object when the env var is unset", () => {
    delete process.env["CF_METRICS_SAPTOOLS_ROOT"];
    expect(resultStoreOptionsFromEnv()).toEqual({});
  });

  it("returns an empty options object when the env var is blank", () => {
    process.env["CF_METRICS_SAPTOOLS_ROOT"] = "";
    expect(resultStoreOptionsFromEnv()).toEqual({});
  });

  it("passes the env var through as saptoolsRoot when set", () => {
    process.env["CF_METRICS_SAPTOOLS_ROOT"] = "/tmp/some-root";
    expect(resultStoreOptionsFromEnv()).toEqual({ saptoolsRoot: "/tmp/some-root" });
  });
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cf-metrics-result-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("result-store", () => {
  it("creates a session, returns an 8-hex ref, and reads it back exactly", async () => {
    const session = await createResultSession({ command: "history", rows: [{ NAME: "container.cpu.usage" }] }, { saptoolsRoot: root });
    expect(session.ref).toMatch(/^[0-9a-f]{8}$/);

    const read = await readResultSession(session.ref, { saptoolsRoot: root });
    expect(read.rows).toEqual([{ NAME: "container.cpu.usage" }]);
    expect(read.command).toBe("history");
  });

  it("throws for a ref that was never created", async () => {
    await expect(readResultSession("deadbeef", { saptoolsRoot: root })).rejects.toThrow(/not found or expired/);
  });

  it("lists active sessions without needing their full row data", async () => {
    await createResultSession({ command: "history", rows: [{ a: 1 }, { a: 2 }] }, { saptoolsRoot: root });
    const summaries = await listResultSessions({ saptoolsRoot: root });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ command: "history", rowCount: 2 });
  });

  it("prunes expired sessions but keeps active ones", async () => {
    // createResultSession itself auto-prunes on every call, so the expired
    // session must be pruned (and counted) before a second create runs —
    // otherwise that second call's own auto-prune silently absorbs it first.
    const past = new Date(Date.now() - 10 * 60_000);
    await createResultSession({ command: "history", rows: [], ttlMinutes: 1 }, { saptoolsRoot: root, now: () => past });

    const removed = await pruneResultSessions({ saptoolsRoot: root });
    expect(removed).toBe(1);

    const active = await createResultSession({ command: "history", rows: [] }, { saptoolsRoot: root });
    await expect(readResultSession(active.ref, { saptoolsRoot: root })).resolves.toBeDefined();
  });

  it("clears every session regardless of expiry", async () => {
    await createResultSession({ command: "history", rows: [] }, { saptoolsRoot: root });
    await createResultSession({ command: "top", rows: [] }, { saptoolsRoot: root });
    const removed = await clearResultSessions({ saptoolsRoot: root });
    expect(removed).toBe(2);
    expect(await listResultSessions({ saptoolsRoot: root })).toEqual([]);
  });

  it("rejects a saved result exceeding the configured byte limit", async () => {
    await expect(
      createResultSession(
        { command: "history", rows: [{ big: "x".repeat(1000) }] },
        { saptoolsRoot: root, maxBytes: 100 },
      ),
    ).rejects.toThrow(/exceeds the storage limit/);
  });
});
