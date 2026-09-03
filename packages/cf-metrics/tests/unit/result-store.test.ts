import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 1, failed: 0, retainedRefs: [] });

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

const resultsDir = (): string => join(root, "cf-metrics", "results");

/** Plant a session directory by hand, so a manifest can be malformed in ways `createResultSession` never writes. */
async function plant(ref: string, manifest: string | undefined, extraFile?: string): Promise<string> {
  const directory = join(resultsDir(), ref);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (manifest !== undefined) {
    await writeFile(join(directory, "manifest.json"), manifest, { encoding: "utf8", mode: 0o600 });
  }
  if (extraFile !== undefined) {
    await writeFile(join(directory, extraFile), "payload\n", { encoding: "utf8", mode: 0o600 });
  }
  return directory;
}

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    ref: "00000001",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ttlMinutes: 10_080,
    command: "history",
    rows: [{ METRIC: "cpu" }],
    ...overrides,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** chmod-based tests are meaningless as root, which bypasses the permission bits entirely. */
const asUnprivilegedUser = process.getuid !== undefined && process.getuid() !== 0;

describe("prune never deletes what it cannot read", () => {
  it("retains a manifest written by a newer version instead of deleting it", async () => {
    const directory = await plant("00000002", manifestJson({ version: 2 }));

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, failed: 0, retainedRefs: ["00000002"] });
    expect(await exists(join(directory, "manifest.json"))).toBe(true);
  });

  it("retains a manifest that is not valid JSON", async () => {
    const directory = await plant("00000003", '{"version":1,"rows":[');

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, failed: 0, retainedRefs: ["00000003"] });
    expect(await exists(join(directory, "manifest.json"))).toBe(true);
  });

  it.skipIf(!asUnprivilegedUser)("retains a manifest that exists but cannot be read", async () => {
    const directory = await plant("00000004", manifestJson());
    const manifest = join(directory, "manifest.json");
    await chmod(manifest, 0o000);
    try {
      expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, failed: 0, retainedRefs: ["00000004"] });
      expect(await readdir(directory)).toEqual(["manifest.json"]);
    } finally {
      await chmod(manifest, 0o600);
    }
  });

  it("removes a ref directory that holds nothing at all", async () => {
    await plant("00000005", undefined);

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 1, failed: 0, retainedRefs: [] });
    expect(await readdir(resultsDir())).toEqual([]);
  });

  it("retains a ref directory whose payload sits under a filename this version does not know", async () => {
    const directory = await plant("00000006", undefined, "some-future-name.json");

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, failed: 0, retainedRefs: ["00000006"] });
    expect(await exists(join(directory, "some-future-name.json"))).toBe(true);
  });

  it.skipIf(!asUnprivilegedUser)("retains a ref directory it cannot confirm is empty", async () => {
    const directory = await plant("00000010", undefined);
    await chmod(directory, 0o100);
    try {
      expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, failed: 0, retainedRefs: ["00000010"] });
    } finally {
      await chmod(directory, 0o700);
    }
  });
});

describe("expiry can always be resolved", () => {
  it("falls back to createdAt + ttlMinutes when expiresAt is unparseable", async () => {
    await plant("00000007", manifestJson({ expiresAt: "not-a-date", createdAt: new Date().toISOString(), ttlMinutes: 60 }));

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, failed: 0, retainedRefs: [] });
    await expect(readResultSession("00000007", { saptoolsRoot: root })).resolves.toBeDefined();
  });

  it("retains a session whose ttlMinutes is too large to add, rather than dating it", async () => {
    // `Number.isFinite(1e308)` is true, but `1e308 * 60_000` overflows to
    // `Infinity`. A `Date` also cannot hold anything past ±8.64e15 ms, so a
    // merely-finite product is not enough — the expiry has to be representable.
    await plant("00000011", manifestJson({ expiresAt: "not-a-date", createdAt: "2026-09-01T00:00:00.000Z", ttlMinutes: 1e308 }));

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({
      removed: 0,
      failed: 0,
      retainedRefs: ["00000011"],
    });
    await expect(readResultSession("00000011", { saptoolsRoot: root })).rejects.toThrow(
      /not in a format this version of/,
    );
  });

  it("retains a session whose ttlMinutes is a safe integer but dates past any clock", async () => {
    // The bound is what a `Date` can hold, not what a float can hold: `Number.isSafeInteger`
    // admits a ttlMinutes whose product reaches 5.4e20 — a *finite*
    // expiry no clock can ever reach — immortal, and previously uncounted.
    await plant("00000011", manifestJson({ expiresAt: "not-a-date", createdAt: "2026-09-01T00:00:00.000Z", ttlMinutes: 1_000_000_000_000 }));

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({
      removed: 0,
      failed: 0,
      retainedRefs: ["00000011"],
    });
    expect(await listResultSessions({ saptoolsRoot: root })).toEqual([]);
  });

  it("retains a session with no resolvable expiry, rather than deleting readable rows", async () => {
    // Deleting this would destroy rows the store can read perfectly well, and
    // would single out the one unreadable case that *is* recoverable — for
    // instance a newer version that changed only the timestamp encoding.
    await plant("00000008", manifestJson({ expiresAt: "not-a-date", createdAt: "also-not-a-date" }));

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({
      removed: 0,
      failed: 0,
      retainedRefs: ["00000008"],
    });
    await expect(readResultSession("00000008", { saptoolsRoot: root })).rejects.toThrow(
      /not in a format this version of/,
    );
  });

  it.skipIf(!asUnprivilegedUser)("expires a stale session on read even when prune could not remove it", async () => {
    await plant("00000009", manifestJson({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    await chmod(resultsDir(), 0o500);
    try {
      await expect(readResultSession("00000009", { saptoolsRoot: root })).rejects.toThrow(/not found or expired/);
      expect(await exists(join(resultsDir(), "00000009", "manifest.json"))).toBe(true);
    } finally {
      await chmod(resultsDir(), 0o700);
    }
  });
});

describe("a broken store never blocks the operation the user asked for", () => {
  it.skipIf(!asUnprivilegedUser)("counts an undeletable expired session instead of aborting the sweep", async () => {
    const live = await createResultSession({ command: "history", rows: [{ A: 1 }] }, { saptoolsRoot: root });
    await plant("0000000a", manifestJson({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    await chmod(resultsDir(), 0o500);
    try {
      expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, failed: 1, retainedRefs: [] });
      await expect(readResultSession(live.ref, { saptoolsRoot: root })).resolves.toBeDefined();
      expect(await listResultSessions({ saptoolsRoot: root })).toHaveLength(1);
    } finally {
      await chmod(resultsDir(), 0o700);
    }
  });

  it.skipIf(!asUnprivilegedUser)("still reads a live ref when the results directory cannot even be listed", async () => {
    const live = await createResultSession({ command: "history", rows: [{ A: 1 }] }, { saptoolsRoot: root });
    await chmod(resultsDir(), 0o100);
    try {
      await expect(pruneResultSessions({ saptoolsRoot: root })).rejects.toThrow();
      await expect(readResultSession(live.ref, { saptoolsRoot: root })).resolves.toMatchObject({ command: "history" });
    } finally {
      await chmod(resultsDir(), 0o700);
    }
  });
});

describe("read failures are distinguishable", () => {
  it.skipIf(!asUnprivilegedUser)("reports an unreadable manifest as unreadable, not as missing", async () => {
    const directory = await plant("0000000b", manifestJson());
    await chmod(join(directory, "manifest.json"), 0o000);
    try {
      await expect(readResultSession("0000000b", { saptoolsRoot: root })).rejects.toThrow(/could not be read/);
      await expect(readResultSession("0000000b", { saptoolsRoot: root })).rejects.toMatchObject({
        code: "RESULT_UNREADABLE",
      });
    } finally {
      await chmod(join(directory, "manifest.json"), 0o600);
    }
  });

  it("reports an unrecognized manifest as a format it does not understand, and leaves it alone", async () => {
    const directory = await plant("0000000c", manifestJson({ version: 2 }));

    await expect(readResultSession("0000000c", { saptoolsRoot: root })).rejects.toThrow(
      /not in a format this version of cf-metrics understands/,
    );
    expect(await exists(join(directory, "manifest.json"))).toBe(true);
  });

  it("still reports a genuinely absent ref as not found", async () => {
    await expect(readResultSession("0000000d", { saptoolsRoot: root })).rejects.toMatchObject({
      code: "RESULT_NOT_FOUND",
    });
  });
});

describe("listResultSessions", () => {
  it("shows the addressable directory ref, not the manifest's own copy", async () => {
    await plant("0000000e", manifestJson({ ref: "MISMATCH" }));

    const summaries = await listResultSessions({ saptoolsRoot: root });
    expect(summaries.map((summary) => summary.ref)).toEqual(["0000000e"]);
    await expect(readResultSession("0000000e", { saptoolsRoot: root })).resolves.toBeDefined();
  });

  it.skipIf(!asUnprivilegedUser)("omits an expired session it was unable to delete", async () => {
    // The read-only results directory is what makes this test test anything: the
    // injected `now` also reaches the implicit prune, so without it the fixture
    // would simply be deleted and the empty result would come from there rather
    // than from the list-side expiry filter.
    await plant("0000000f", manifestJson({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    await chmod(resultsDir(), 0o500);
    try {
      const summaries = await listResultSessions({
        saptoolsRoot: root,
        now: () => new Date("2020-01-02T00:00:00.000Z"),
      });
      expect(summaries).toEqual([]);
      expect(await exists(join(resultsDir(), "0000000f", "manifest.json"))).toBe(true);
    } finally {
      await chmod(resultsDir(), 0o700);
    }
  });
});
