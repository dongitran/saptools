import { chmod, mkdir, mkdtemp, readFile, readdir, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearResultSessions,
  createResultSession,
  listResultSessions,
  pruneResultSessions,
  readResultSession,
  tryCreateResultSession,
} from "../../src/result-store.js";
import type { HanaClientInfo, QueryResult } from "../../src/types.js";

let rootDir: string;

const info: HanaClientInfo = {
  selector: "eu10/neutral-org/dev/neutral-app",
  appName: "neutral-app",
  host: "hana.example.internal",
  schema: "APP_SCHEMA",
  role: "runtime",
  driver: "fake",
  credentialSource: "live",
};

function sampleResult(): QueryResult {
  return {
    rows: [
      {
        ID: 1,
        CONTENT: "full\ntext",
        PAYLOAD: '{"items":[{"name":"Alpha"}]}',
        DATA: Buffer.from([0, 1, 255]),
        WHEN: new Date("2026-06-25T00:00:00.000Z"),
        ACTIVE: true,
        EMPTY: null,
      },
    ],
    columns: [
      { name: "ID", typeName: "INTEGER" },
      { name: "CONTENT", typeName: "NCLOB" },
      { name: "PAYLOAD", typeName: "NCLOB" },
      { name: "DATA", typeName: "BLOB" },
      { name: "WHEN", typeName: "TIMESTAMP" },
      { name: "ACTIVE", typeName: "BOOLEAN" },
      { name: "EMPTY", typeName: "NVARCHAR" },
    ],
    rowCount: 1,
    statement: "select",
    truncated: true,
    elapsedMs: 5,
  };
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "cf-hana-results-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("result store", () => {
  it("round-trips exact typed result values", async () => {
    const created = await createResultSession(
      { result: sampleResult(), info, ttlMinutes: 60 },
      {
        saptoolsRoot: rootDir,
        now: () => new Date("2026-06-25T00:00:00.000Z"),
        ref: "qabc12345",
      },
    );

    const loaded = await readResultSession("qabc12345", {
      saptoolsRoot: rootDir,
      now: () => new Date("2026-06-25T00:30:00.000Z"),
    });

    expect(created.expiresAt).toBe("2026-06-25T01:00:00.000Z");
    expect(loaded.result).toEqual(sampleResult());
    expect(loaded.info).toEqual(info);
  });

  it("defaults saved result refs to a seven-day TTL", async () => {
    const created = await createResultSession(
      { result: sampleResult(), info },
      {
        saptoolsRoot: rootDir,
        now: () => new Date("2026-06-25T00:00:00.000Z"),
        ref: "qabc12345",
      },
    );

    expect(created.ttlMinutes).toBe(10_080);
    expect(created.expiresAt).toBe("2026-07-02T00:00:00.000Z");
  });

  it("creates restricted result directories and files", async () => {
    const session = await createResultSession(
      { result: sampleResult(), info },
      { saptoolsRoot: rootDir, ref: "qabc12345" },
    );

    const directoryMode = (await stat(session.directory)).mode & 0o777;
    const fileMode = (await stat(session.path)).mode & 0o777;

    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("rejects duplicate display names before saving", async () => {
    const result: QueryResult = {
      ...sampleResult(),
      columns: [
        { name: "ID", typeName: "INTEGER" },
        { name: "ID", typeName: "INTEGER" },
      ],
    };

    await expect(
      createResultSession({ result, info }, { saptoolsRoot: rootDir }),
    ).rejects.toThrow(/unique SQL aliases/);
  });

  it("rejects a session that exceeds its byte ceiling", async () => {
    await expect(
      createResultSession(
        { result: sampleResult(), info },
        { saptoolsRoot: rootDir, maxBytes: 10 },
      ),
    ).rejects.toThrow(/storage limit/);
  });

  it("fails soft when an automatic result save exceeds its byte ceiling", async () => {
    await expect(
      tryCreateResultSession(
        { result: sampleResult(), info },
        { saptoolsRoot: rootDir, maxBytes: 10 },
      ),
    ).resolves.toBeUndefined();
    await expect(listResultSessions({ saptoolsRoot: rootDir })).resolves.toEqual([]);
  });

  it("lists active sessions and prunes expired sessions", async () => {
    await createResultSession(
      { result: sampleResult(), info, ttlMinutes: 60 },
      {
        saptoolsRoot: rootDir,
        now: () => new Date("2026-06-25T00:00:00.000Z"),
        ref: "qabc12345",
      },
    );

    const active = await listResultSessions({
      saptoolsRoot: rootDir,
      now: () => new Date("2026-06-25T00:30:00.000Z"),
    });
    const removed = await pruneResultSessions({
      saptoolsRoot: rootDir,
      now: () => new Date("2026-06-25T01:01:00.000Z"),
    });

    expect(active).toEqual([
      expect.objectContaining({ ref: "qabc12345", rowCount: 1 }),
    ]);
    expect(removed).toEqual({ removed: 1, failed: 0, retainedRefs: [] });
    await expect(
      readResultSession("qabc12345", { saptoolsRoot: rootDir }),
    ).rejects.toThrow(/not found or expired/);
  });

  it("clears every result session", async () => {
    await createResultSession(
      { result: sampleResult(), info },
      { saptoolsRoot: rootDir, ref: "qabc12345" },
    );
    await createResultSession(
      { result: sampleResult(), info },
      { saptoolsRoot: rootDir, ref: "qdef67890" },
    );

    expect(await clearResultSessions({ saptoolsRoot: rootDir })).toBe(2);
    expect(await listResultSessions({ saptoolsRoot: rootDir })).toEqual([]);
  });
});

const resultsDir = (): string => join(rootDir, "cf-hana", "results");

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
    ref: "q00000001",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ttlMinutes: 10_080,
    info,
    result: {
      columns: [{ name: "ID", typeName: "INTEGER" }],
      rows: [[{ kind: "number", value: 1 }]],
      rowCount: 1,
      statement: "select",
      truncated: false,
      elapsedMs: 1,
    },
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
    const directory = await plant("q00000002", manifestJson({ version: 2 }));

    expect(await pruneResultSessions({ saptoolsRoot: rootDir })).toEqual({ removed: 0, failed: 0, retainedRefs: ["q00000002"] });
    expect(await exists(join(directory, "manifest.json"))).toBe(true);
  });

  it("retains a manifest that is not valid JSON", async () => {
    const directory = await plant("q00000003", '{"version":1,"result":{');

    expect(await pruneResultSessions({ saptoolsRoot: rootDir })).toEqual({ removed: 0, failed: 0, retainedRefs: ["q00000003"] });
    expect(await exists(join(directory, "manifest.json"))).toBe(true);
  });

  it.skipIf(!asUnprivilegedUser)("retains a manifest that exists but cannot be read", async () => {
    const directory = await plant("q00000004", manifestJson());
    const manifest = join(directory, "manifest.json");
    await chmod(manifest, 0o000);
    try {
      expect(await pruneResultSessions({ saptoolsRoot: rootDir })).toEqual({ removed: 0, failed: 0, retainedRefs: ["q00000004"] });
      expect(await readdir(directory)).toEqual(["manifest.json"]);
    } finally {
      await chmod(manifest, 0o600);
    }
  });

  it("removes a ref directory that holds nothing at all", async () => {
    await plant("q00000005", undefined);

    expect(await pruneResultSessions({ saptoolsRoot: rootDir })).toEqual({ removed: 1, failed: 0, retainedRefs: [] });
    expect(await readdir(resultsDir())).toEqual([]);
  });

  it.skipIf(!asUnprivilegedUser)("retains a ref directory it cannot confirm is empty", async () => {
    // Traversable but not listable: the manifest lookup returns ENOENT, so the
    // manifest reads as absent, but `readdir` then fails — and a directory whose
    // emptiness cannot be established must not be reclaimed.
    const directory = await plant("q00000010", undefined);
    await chmod(directory, 0o100);
    try {
      expect(await pruneResultSessions({ saptoolsRoot: rootDir })).toEqual({ removed: 0, failed: 0, retainedRefs: ["q00000010"] });
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("retains a ref directory whose payload sits under a filename this version does not know", async () => {
    const directory = await plant("q00000006", undefined, "some-future-name.json");

    expect(await pruneResultSessions({ saptoolsRoot: rootDir })).toEqual({ removed: 0, failed: 0, retainedRefs: ["q00000006"] });
    expect(await exists(join(directory, "some-future-name.json"))).toBe(true);
  });
});

describe("expiry can always be resolved", () => {
  it("falls back to createdAt + ttlMinutes when expiresAt is unparseable", async () => {
    await plant("q00000007", manifestJson({ expiresAt: "not-a-date", createdAt: new Date().toISOString(), ttlMinutes: 60 }));

    expect(await pruneResultSessions({ saptoolsRoot: rootDir })).toEqual({ removed: 0, failed: 0, retainedRefs: [] });
    await expect(readResultSession("q00000007", { saptoolsRoot: rootDir })).resolves.toBeDefined();
  });

  it("retains a session whose ttlMinutes is too large to add, rather than dating it", async () => {
    // `Number.isFinite(1e308)` is true, but `1e308 * 60_000` overflows to
    // `Infinity`. A `Date` also cannot hold anything past ±8.64e15 ms, so a
    // merely-finite product is not enough — the expiry has to be representable.
    await plant("q00000011", manifestJson({ expiresAt: "not-a-date", createdAt: "2026-09-01T00:00:00.000Z", ttlMinutes: 1e308 }));

    expect(await pruneResultSessions({ saptoolsRoot: rootDir })).toEqual({
      removed: 0,
      failed: 0,
      retainedRefs: ["q00000011"],
    });
    await expect(readResultSession("q00000011", { saptoolsRoot: rootDir })).rejects.toThrow(
      /not in a format this version of/,
    );
  });

  it("retains a session whose ttlMinutes is a safe integer but dates past any clock", async () => {
    // The bound is what a `Date` can hold, not what a float can hold: `Number.isSafeInteger`
    // admits a ttlMinutes whose product reaches 5.4e20 — a *finite*
    // expiry no clock can ever reach — immortal, and previously uncounted.
    await plant("q00000011", manifestJson({ expiresAt: "not-a-date", createdAt: "2026-09-01T00:00:00.000Z", ttlMinutes: 1_000_000_000_000 }));

    expect(await pruneResultSessions({ saptoolsRoot: rootDir })).toEqual({
      removed: 0,
      failed: 0,
      retainedRefs: ["q00000011"],
    });
    expect(await listResultSessions({ saptoolsRoot: rootDir })).toEqual([]);
  });

  it("retains a session with no resolvable expiry, rather than deleting readable rows", async () => {
    // Deleting this would destroy rows the store can read perfectly well, and
    // would single out the one unreadable case that *is* recoverable — for
    // instance a newer version that changed only the timestamp encoding.
    await plant("q00000008", manifestJson({ expiresAt: "not-a-date", createdAt: "also-not-a-date" }));

    expect(await pruneResultSessions({ saptoolsRoot: rootDir })).toEqual({
      removed: 0,
      failed: 0,
      retainedRefs: ["q00000008"],
    });
    await expect(readResultSession("q00000008", { saptoolsRoot: rootDir })).rejects.toThrow(
      /not in a format this version of/,
    );
  });

  it.skipIf(!asUnprivilegedUser)("expires a stale session on read even when prune could not remove it", async () => {
    await plant("q00000009", manifestJson({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    await chmod(resultsDir(), 0o500);
    try {
      await expect(readResultSession("q00000009", { saptoolsRoot: rootDir })).rejects.toThrow(/not found or expired/);
      expect(await exists(join(resultsDir(), "q00000009", "manifest.json"))).toBe(true);
    } finally {
      await chmod(resultsDir(), 0o700);
    }
  });
});

describe("a broken store never blocks the operation the user asked for", () => {
  it.skipIf(!asUnprivilegedUser)("counts an undeletable expired session instead of aborting the sweep", async () => {
    const live = await createResultSession({ result: sampleResult(), info }, { saptoolsRoot: rootDir });
    await plant("q0000000a", manifestJson({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    await chmod(resultsDir(), 0o500);
    try {
      expect(await pruneResultSessions({ saptoolsRoot: rootDir })).toEqual({ removed: 0, failed: 1, retainedRefs: [] });
      await expect(readResultSession(live.ref, { saptoolsRoot: rootDir })).resolves.toBeDefined();
      expect(await listResultSessions({ saptoolsRoot: rootDir })).toHaveLength(1);
    } finally {
      await chmod(resultsDir(), 0o700);
    }
  });

  it.skipIf(!asUnprivilegedUser)("still reads a live ref when the results directory cannot even be listed", async () => {
    const live = await createResultSession({ result: sampleResult(), info }, { saptoolsRoot: rootDir });
    await chmod(resultsDir(), 0o100);
    try {
      await expect(pruneResultSessions({ saptoolsRoot: rootDir })).rejects.toThrow();
      await expect(readResultSession(live.ref, { saptoolsRoot: rootDir })).resolves.toMatchObject({ ref: live.ref });
    } finally {
      await chmod(resultsDir(), 0o700);
    }
  });
});

describe("read failures are distinguishable", () => {
  it.skipIf(!asUnprivilegedUser)("reports an unreadable manifest as unreadable, not as missing", async () => {
    const directory = await plant("q0000000b", manifestJson());
    await chmod(join(directory, "manifest.json"), 0o000);
    try {
      await expect(readResultSession("q0000000b", { saptoolsRoot: rootDir })).rejects.toThrow(/could not be read/);
      await expect(readResultSession("q0000000b", { saptoolsRoot: rootDir })).rejects.toMatchObject({
        code: "RESULT_UNREADABLE",
      });
    } finally {
      await chmod(join(directory, "manifest.json"), 0o600);
    }
  });

  it("reports an unrecognized manifest as a format it does not understand, and leaves it alone", async () => {
    const directory = await plant("q0000000c", manifestJson({ version: 2 }));

    await expect(readResultSession("q0000000c", { saptoolsRoot: rootDir })).rejects.toThrow(
      /not in a format this version of cf-hana understands/,
    );
    expect(await exists(join(directory, "manifest.json"))).toBe(true);
  });

  it("still reports a genuinely absent ref as not found", async () => {
    await expect(readResultSession("q0000000d", { saptoolsRoot: rootDir })).rejects.toThrow(/not found or expired/);
  });
});

describe("the addressable ref wins over the manifest's own copy", () => {
  it("lists and resolves by directory name, and points directory/path at it", async () => {
    await plant("q0000000e", manifestJson({ ref: "q11112222" }));

    const summaries = await listResultSessions({ saptoolsRoot: rootDir });
    expect(summaries.map((summary) => summary.ref)).toEqual(["q0000000e"]);

    const session = await readResultSession("q0000000e", { saptoolsRoot: rootDir });
    expect(session.ref).toBe("q0000000e");
    expect(session.directory).toBe(join(resultsDir(), "q0000000e"));
    expect(session.path).toBe(join(resultsDir(), "q0000000e", "manifest.json"));
  });

  it.skipIf(!asUnprivilegedUser)("omits an expired session it was unable to delete", async () => {
    // The read-only results directory is what makes this test test anything: the
    // injected `now` also reaches the implicit prune, so without it the fixture
    // would simply be deleted and the empty result would come from there rather
    // than from the list-side expiry filter.
    await plant("q0000000f", manifestJson({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    await chmod(resultsDir(), 0o500);
    try {
      const summaries = await listResultSessions({
        saptoolsRoot: rootDir,
        now: () => new Date("2020-01-02T00:00:00.000Z"),
      });
      expect(summaries).toEqual([]);
      expect(await exists(join(resultsDir(), "q0000000f", "manifest.json"))).toBe(true);
    } finally {
      await chmod(resultsDir(), 0o700);
    }
  });
});

describe("tryCreateResultSession still swallows failures for the auto-save path", () => {
  it("returns undefined rather than throwing", async () => {
    expect(
      await tryCreateResultSession({ result: sampleResult(), info }, { saptoolsRoot: rootDir, maxBytes: 1 }),
    ).toBeUndefined();
  });
});
