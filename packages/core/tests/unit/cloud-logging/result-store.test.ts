import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertResultStoreWritable,
  clearResultSessions,
  createResultSession,
  listResultSessions,
  pruneResultSessions,
  readResultSession,
} from "../../../src/cloud-logging/result-store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "core-result-store-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createResultSession / readResultSession", () => {
  it("saves rows and reads them back by ref", async () => {
    const session = await createResultSession({ cliName: "cf-log-search", command: "search", rows: [{ A: 1 }] }, { saptoolsRoot: root });
    const read = await readResultSession(session.ref, { cliName: "cf-log-search", saptoolsRoot: root });
    expect(read.rows).toEqual([{ A: 1 }]);
    expect(read.command).toBe("search");
  });

  it("throws RESULT_NOT_FOUND for an unknown ref", async () => {
    await expect(readResultSession("00000000", { cliName: "cf-log-search", saptoolsRoot: root })).rejects.toThrow(/not found or expired/);
  });

  it("scopes sessions by cliName so cf-otel's and cf-log-search's stores never collide", async () => {
    const session = await createResultSession({ cliName: "cf-otel", command: "spans", rows: [] }, { saptoolsRoot: root });
    await expect(readResultSession(session.ref, { cliName: "cf-log-search", saptoolsRoot: root })).rejects.toThrow();
  });
});

describe("assertResultStoreWritable", () => {
  it("resolves without writing a lasting file when the store directory is writable", async () => {
    await expect(assertResultStoreWritable({ cliName: "cf-log-search", saptoolsRoot: root })).resolves.toBeUndefined();
  });
});

describe("pruneResultSessions — stray temp-directory sweep", () => {
  it("removes a stray '<ref>.tmp-<pid>' left by an interrupted save from a dead process", async () => {
    const storeDir = join(root, "cf-log-search", "results");
    mkdirSync(storeDir, { recursive: true });
    const strandedPid = 999_999_999; // astronomically unlikely to be a live pid
    mkdirSync(join(storeDir, `abcd1234.tmp-${String(strandedPid)}`), { recursive: true });

    const outcome = await pruneResultSessions({ cliName: "cf-log-search", saptoolsRoot: root });

    expect(outcome.strandedRemoved).toBe(1);
  });

  it("retains a manifest this version cannot parse, never deletes it", async () => {
    await createResultSession({ cliName: "cf-log-search", command: "search", rows: [] }, { saptoolsRoot: root });
    const summariesBefore = await listResultSessions({ cliName: "cf-log-search", saptoolsRoot: root });
    const ref = summariesBefore[0]!.ref;
    expect(ref).toBeDefined();
    // Corrupt the manifest.
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(root, "cf-log-search", "results", ref, "manifest.json"), "not json", "utf8");

    const outcome = await pruneResultSessions({ cliName: "cf-log-search", saptoolsRoot: root });

    expect(outcome.removed).toBe(0);
    expect(outcome.retainedRefs).toContain(ref);
  });
});

describe("clearResultSessions", () => {
  it("removes every session and reports how many there were", async () => {
    await createResultSession({ cliName: "cf-log-search", command: "search", rows: [] }, { saptoolsRoot: root });
    await createResultSession({ cliName: "cf-log-search", command: "search", rows: [] }, { saptoolsRoot: root });
    const count = await clearResultSessions({ cliName: "cf-log-search", saptoolsRoot: root });
    expect(count).toBe(2);
    expect(await listResultSessions({ cliName: "cf-log-search", saptoolsRoot: root })).toEqual([]);
  });

  it("returns 0 when there are no sessions", async () => {
    const count = await clearResultSessions({ cliName: "cf-log-search", saptoolsRoot: root });
    expect(count).toBe(0);
  });
});

describe("pruneResultSessions — expiry handling", () => {
  it("removes sessions that have expired", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const session = await createResultSession(
      { cliName: "cf-log-search", command: "search", rows: [], ttlMinutes: 10 },
      { saptoolsRoot: root, now: () => now }
    );

    const futureNow = new Date("2026-01-01T00:15:00Z");
    const outcome = await pruneResultSessions({ cliName: "cf-log-search", saptoolsRoot: root, now: () => futureNow });

    expect(outcome.removed).toBe(1);
    await expect(readResultSession(session.ref, { cliName: "cf-log-search", saptoolsRoot: root, now: () => futureNow })).rejects.toThrow(/not found or expired/);
  });

  it("retains sessions that have not yet expired", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const session = await createResultSession(
      { cliName: "cf-log-search", command: "search", rows: [], ttlMinutes: 10 },
      { saptoolsRoot: root, now: () => now }
    );

    const futureNow = new Date("2026-01-01T00:05:00Z");
    const outcome = await pruneResultSessions({ cliName: "cf-log-search", saptoolsRoot: root, now: () => futureNow });

    expect(outcome.removed).toBe(0);
    const read = await readResultSession(session.ref, { cliName: "cf-log-search", saptoolsRoot: root, now: () => futureNow });
    expect(read.ref).toBe(session.ref);
  });
});

describe("createResultSession — size limits", () => {
  it("throws when the result exceeds maxBytes", async () => {
    const largeRows = Array(1000).fill({ data: "x".repeat(1000) });
    await expect(createResultSession({ cliName: "cf-log-search", command: "search", rows: largeRows }, { saptoolsRoot: root, maxBytes: 100 })).rejects.toThrow(/exceeds the storage limit/);
  });
});

describe("listResultSessions", () => {
  it("lists multiple sessions in lexicographic order by ref", async () => {
    await createResultSession({ cliName: "cf-log-search", command: "cmd1", rows: [] }, { saptoolsRoot: root });
    await createResultSession({ cliName: "cf-log-search", command: "cmd2", rows: [] }, { saptoolsRoot: root });

    const summaries = await listResultSessions({ cliName: "cf-log-search", saptoolsRoot: root });

    expect(summaries).toHaveLength(2);
    const [first, second] = summaries;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first && second) {
      expect(first.command).toBeDefined();
      expect(second.command).toBeDefined();
      expect(first.ref <= second.ref).toBe(true);
    }
  });

  it("excludes expired sessions from the list", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await createResultSession(
      { cliName: "cf-log-search", command: "search", rows: [], ttlMinutes: 10 },
      { saptoolsRoot: root, now: () => now }
    );

    const futureNow = new Date("2026-01-01T00:15:00Z");
    const summaries = await listResultSessions({ cliName: "cf-log-search", saptoolsRoot: root, now: () => futureNow });

    expect(summaries).toHaveLength(0);
  });

  it("returns empty array when results directory does not exist", async () => {
    const summaries = await listResultSessions({ cliName: "nonexistent", saptoolsRoot: root });
    expect(summaries).toEqual([]);
  });
});

describe("pruneResultSessions — error handling", () => {
  it("tracks failed removals but continues processing", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await createResultSession(
      { cliName: "cf-log-search", command: "search", rows: [], ttlMinutes: 10 },
      { saptoolsRoot: root, now: () => now }
    );

    const futureNow = new Date("2026-01-01T00:15:00Z");
    const outcome = await pruneResultSessions({ cliName: "cf-log-search", saptoolsRoot: root, now: () => futureNow });

    expect(outcome.failed).toBeGreaterThanOrEqual(0);
    expect(outcome.removed + outcome.failed).toBeGreaterThanOrEqual(0);
  });

  it("handles corrupted sessions gracefully during pruning", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const session = await createResultSession(
      { cliName: "cf-log-search", command: "search", rows: [], ttlMinutes: 10 },
      { saptoolsRoot: root, now: () => now }
    );

    const fs = await import("node:fs/promises");
    await fs.writeFile(join(root, "cf-log-search", "results", session.ref, "manifest.json"), "invalid", "utf8");

    const outcome = await pruneResultSessions({ cliName: "cf-log-search", saptoolsRoot: root });

    expect(outcome.retainedRefs).toContain(session.ref);
    expect(outcome.removed).toBe(0);
  });
});

describe("readResultSession — error messages", () => {
  it("returns appropriate error when result is unrecognized", async () => {
    const session = await createResultSession(
      { cliName: "cf-log-search", command: "search", rows: [] },
      { saptoolsRoot: root }
    );

    const fs = await import("node:fs/promises");
    await fs.writeFile(join(root, "cf-log-search", "results", session.ref, "manifest.json"), "not valid json", "utf8");

    await expect(readResultSession(session.ref, { cliName: "cf-log-search", saptoolsRoot: root })).rejects.toThrow(/not in a format this version understands/);
  });
});

describe("createResultSession — atomic write", () => {
  it("handles invalid ref format", async () => {
    await expect(
      createResultSession({ cliName: "cf-log-search", command: "search", rows: [] }, { saptoolsRoot: root, ref: "invalid-ref-format" })
    ).rejects.toThrow(/Invalid saved result ref/);
  });

  it("handles invalid ttlMinutes", async () => {
    await expect(
      createResultSession({ cliName: "cf-log-search", command: "search", rows: [], ttlMinutes: -1 }, { saptoolsRoot: root })
    ).rejects.toThrow(/Result TTL must be a positive safe integer/);
  });

  it("handles zero ttlMinutes", async () => {
    await expect(
      createResultSession({ cliName: "cf-log-search", command: "search", rows: [], ttlMinutes: 0 }, { saptoolsRoot: root })
    ).rejects.toThrow(/Result TTL must be a positive safe integer/);
  });

  it("handles non-integer ttlMinutes", async () => {
    await expect(
      createResultSession({ cliName: "cf-log-search", command: "search", rows: [], ttlMinutes: 1.5 }, { saptoolsRoot: root })
    ).rejects.toThrow(/Result TTL must be a positive safe integer/);
  });
});

describe("resolveExpiryMillis edge cases", () => {
  it("correctly calculates expiry for sessions with derived expiry", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const session = await createResultSession(
      { cliName: "cf-log-search", command: "search", rows: [], ttlMinutes: 5 },
      { saptoolsRoot: root, now: () => now }
    );

    const read = await readResultSession(session.ref, { cliName: "cf-log-search", saptoolsRoot: root, now: () => now });
    expect(read.expiresAt).toBeDefined();
    expect(new Date(read.expiresAt).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("stray temp directory detection", () => {
  it("skips temp directories where the owner process is still alive", async () => {
    const storeDir = join(root, "cf-log-search", "results");
    mkdirSync(storeDir, { recursive: true });
    const livePid = process.pid;
    mkdirSync(join(storeDir, `abcd1234.tmp-${String(livePid)}`), { recursive: true });

    const outcome = await pruneResultSessions({ cliName: "cf-log-search", saptoolsRoot: root });

    expect(outcome.strandedRemoved).toBe(0);
  });

  it("handles readdir errors gracefully during stranded cleanup", async () => {
    const outcome = await pruneResultSessions({ cliName: "nonexistent-cli", saptoolsRoot: root });

    expect(outcome.strandedRemoved).toBe(0);
    expect(outcome.removed).toBe(0);
  });
});

describe("pruneResultSessions — unreadable directories", () => {
  it("retains non-empty directories that cannot be read", async () => {
    const storeDir = join(root, "cf-log-search", "results");
    mkdirSync(storeDir, { recursive: true });
    const refDir = join(storeDir, "ffffffff");
    mkdirSync(refDir, { recursive: true });
    const { writeFile: writeFileAsync } = await import("node:fs/promises");
    await writeFileAsync(join(refDir, "somefile.txt"), "data", "utf8");

    const outcome = await pruneResultSessions({ cliName: "cf-log-search", saptoolsRoot: root });

    expect(outcome.retainedRefs).toContain("ffffffff");
    expect(outcome.removed).toBe(0);
  });

  it("removes empty directories for sessions with absent manifests", async () => {
    const storeDir = join(root, "cf-log-search", "results");
    mkdirSync(storeDir, { recursive: true });
    const emptyRefDir = join(storeDir, "aabbccdd");
    mkdirSync(emptyRefDir, { recursive: true });

    const outcome = await pruneResultSessions({ cliName: "cf-log-search", saptoolsRoot: root });

    expect(outcome.removed).toBe(1);
    expect(outcome.retainedRefs).not.toContain("aabbccdd");
  });
});

describe("createResultSession — various row shapes", () => {
  it("handles sessions with complex object rows", async () => {
    const rows = [{ id: 1, nested: { data: "test" } }, { id: 2, nested: { data: "test2" } }];
    const session = await createResultSession(
      { cliName: "cf-log-search", command: "search", rows },
      { saptoolsRoot: root }
    );

    const read = await readResultSession(session.ref, { cliName: "cf-log-search", saptoolsRoot: root });
    expect(read.rows).toEqual(rows);
  });

  it("handles sessions with large number of rows", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ index: i, value: `row-${i.toString()}` }));
    const session = await createResultSession(
      { cliName: "cf-log-search", command: "search", rows },
      { saptoolsRoot: root, maxBytes: 1024 * 1024 }
    );

    const read = await readResultSession(session.ref, { cliName: "cf-log-search", saptoolsRoot: root });
    expect(read.rows).toHaveLength(1000);
  });
});
