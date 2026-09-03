import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CfOtelError } from "../../src/errors.js";
import {
  assertResultStoreWritable,
  clearResultSessions,
  createResultSession,
  listResultSessions,
  pruneResultSessions,
  readResultSession,
  resultStoreOptionsFromEnv,
} from "../../src/result-store.js";

describe("resultStoreOptionsFromEnv", () => {
  const originalValue = process.env["CF_OTEL_RESULTS_ROOT"];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env["CF_OTEL_RESULTS_ROOT"];
    } else {
      process.env["CF_OTEL_RESULTS_ROOT"] = originalValue;
    }
  });

  it("returns an empty options object when the env var is unset", () => {
    delete process.env["CF_OTEL_RESULTS_ROOT"];
    expect(resultStoreOptionsFromEnv()).toEqual({});
  });

  it("returns an empty options object when the env var is blank", () => {
    process.env["CF_OTEL_RESULTS_ROOT"] = "";
    expect(resultStoreOptionsFromEnv()).toEqual({});
  });

  it("passes the env var through as saptoolsRoot when set", () => {
    process.env["CF_OTEL_RESULTS_ROOT"] = "/tmp/some-root";
    expect(resultStoreOptionsFromEnv()).toEqual({ saptoolsRoot: "/tmp/some-root" });
  });
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cf-otel-result-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("result-store", () => {
  it("creates a session, returns an 8-hex ref, and reads it back exactly", async () => {
    const session = await createResultSession({ command: "find", rows: [{ NAME: "GET" }] }, { saptoolsRoot: root });
    expect(session.ref).toMatch(/^[0-9a-f]{8}$/);

    const read = await readResultSession(session.ref, { saptoolsRoot: root });
    expect(read.rows).toEqual([{ NAME: "GET" }]);
    expect(read.command).toBe("find");
  });

  it("throws for a ref that was never created", async () => {
    await expect(readResultSession("deadbeef", { saptoolsRoot: root })).rejects.toThrow(/not found or expired/);
  });

  it("lists active sessions without needing their full row data", async () => {
    await createResultSession({ command: "find", rows: [{ a: 1 }, { a: 2 }] }, { saptoolsRoot: root });
    const summaries = await listResultSessions({ saptoolsRoot: root });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ command: "find", rowCount: 2 });
  });

  it("prunes expired sessions but keeps active ones", async () => {
    // createResultSession itself auto-prunes on every call, so the expired
    // session must be pruned (and counted) before a second create runs —
    // otherwise that second call's own auto-prune silently absorbs it first.
    const past = new Date(Date.now() - 10 * 60_000);
    await createResultSession({ command: "find", rows: [], ttlMinutes: 1 }, { saptoolsRoot: root, now: () => past });

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 1, retained: 0, failed: 0 });

    const active = await createResultSession({ command: "find", rows: [] }, { saptoolsRoot: root });
    await expect(readResultSession(active.ref, { saptoolsRoot: root })).resolves.toBeDefined();
  });

  it("clears every session regardless of expiry", async () => {
    await createResultSession({ command: "find", rows: [] }, { saptoolsRoot: root });
    await createResultSession({ command: "top", rows: [] }, { saptoolsRoot: root });
    const removed = await clearResultSessions({ saptoolsRoot: root });
    expect(removed).toBe(2);
    expect(await listResultSessions({ saptoolsRoot: root })).toEqual([]);
  });

  it("rejects a saved result exceeding the configured byte limit", async () => {
    await expect(
      createResultSession(
        { command: "find", rows: [{ big: "x".repeat(1000) }] },
        { saptoolsRoot: root, maxBytes: 100 },
      ),
    ).rejects.toThrow(/exceeds the storage limit/);
  });
});

const resultsDir = (): string => join(root, "cf-otel", "results");

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
    command: "find",
    rows: [{ NAME: "GET" }],
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

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, retained: 1, failed: 0 });
    expect(await exists(join(directory, "manifest.json"))).toBe(true);
  });

  it("retains a manifest that is not valid JSON", async () => {
    const directory = await plant("00000003", '{"version":1,"rows":[');

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, retained: 1, failed: 0 });
    expect(await exists(join(directory, "manifest.json"))).toBe(true);
  });

  it.skipIf(!asUnprivilegedUser)("retains a manifest that exists but cannot be read", async () => {
    const directory = await plant("00000004", manifestJson());
    const manifest = join(directory, "manifest.json");
    await chmod(manifest, 0o000);
    try {
      expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, retained: 1, failed: 0 });
      expect(await readdir(directory)).toEqual(["manifest.json"]);
    } finally {
      await chmod(manifest, 0o600);
    }
  });

  it("removes a ref directory that holds nothing at all", async () => {
    await plant("00000005", undefined);

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 1, retained: 0, failed: 0 });
    expect(await readdir(resultsDir())).toEqual([]);
  });

  it.skipIf(!asUnprivilegedUser)("retains a ref directory it cannot confirm is empty", async () => {
    // Traversable but not listable: the manifest lookup returns ENOENT, so the
    // manifest reads as absent, but `readdir` then fails — and a directory
    // whose emptiness cannot be established must not be reclaimed.
    const directory = await plant("00000010", undefined);
    await chmod(directory, 0o100);
    try {
      expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, retained: 1, failed: 0 });
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("retains a ref directory whose payload sits under a filename this version does not know", async () => {
    // Guards the migration path: a future release that renames the manifest
    // must not have its sessions reclaimed as empty crashed saves by an older
    // binary still installed on the same machine.
    const directory = await plant("00000006", undefined, "meta.json");

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, retained: 1, failed: 0 });
    expect(await exists(join(directory, "meta.json"))).toBe(true);
  });
});

describe("expiry can always be resolved", () => {
  it("falls back to createdAt + ttlMinutes when expiresAt is unparseable", async () => {
    await plant("00000007", manifestJson({ expiresAt: "not-a-date", createdAt: new Date().toISOString(), ttlMinutes: 60 }));

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, retained: 0, failed: 0 });
    await expect(readResultSession("00000007", { saptoolsRoot: root })).resolves.toBeDefined();
  });

  it("treats a session with no resolvable expiry as expired rather than immortal", async () => {
    // `Date.parse` returns NaN and `NaN <= now` is false, so this manifest used
    // to survive every prune for ever and still read back.
    await plant("00000008", manifestJson({ expiresAt: "not-a-date", createdAt: "also-not-a-date" }));

    expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 1, retained: 0, failed: 0 });
    await expect(readResultSession("00000008", { saptoolsRoot: root })).rejects.toThrow(/not found or expired/);
  });

  it.skipIf(!asUnprivilegedUser)("expires a stale session on read even when prune could not remove it", async () => {
    // The results directory is read-only, so the implicit prune cannot delete
    // the expired session and `readResultSession` has to enforce the TTL
    // itself. Without the read-only directory this test would pass for the
    // wrong reason: prune would delete the session and the error would come
    // from the absent-manifest path instead of the expiry check.
    await plant("00000009", manifestJson({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    await chmod(resultsDir(), 0o500);
    try {
      await expect(readResultSession("00000009", { saptoolsRoot: root })).rejects.toThrow(/not found or expired/);
      // Proof the session really is still on disk, i.e. prune did not remove it.
      expect(await exists(join(resultsDir(), "00000009", "manifest.json"))).toBe(true);
    } finally {
      await chmod(resultsDir(), 0o700);
    }
  });
});

describe("a broken store never blocks the operation the user asked for", () => {
  it.skipIf(!asUnprivilegedUser)("counts an undeletable expired session instead of aborting the sweep", async () => {
    // Create the live session first: createResultSession prunes before writing,
    // so an expired session planted earlier would already be gone by now.
    const live = await createResultSession({ command: "find", rows: [{ A: 1 }] }, { saptoolsRoot: root });
    await plant("0000000a", manifestJson({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    await chmod(resultsDir(), 0o500);
    try {
      expect(await pruneResultSessions({ saptoolsRoot: root })).toEqual({ removed: 0, retained: 0, failed: 1 });
      // The point of per-session isolation: one undeletable directory used to
      // fail every save, read and list, because all three prune first.
      await expect(readResultSession(live.ref, { saptoolsRoot: root })).resolves.toBeDefined();
      expect(await listResultSessions({ saptoolsRoot: root })).toHaveLength(1);
    } finally {
      await chmod(resultsDir(), 0o700);
    }
  });

  it.skipIf(!asUnprivilegedUser)("still reads a live ref when the results directory cannot even be listed", async () => {
    const live = await createResultSession({ command: "find", rows: [{ A: 1 }] }, { saptoolsRoot: root });
    // Executable but not readable: readdir fails, so the implicit prune throws,
    // while the manifest itself is still reachable by path.
    await chmod(resultsDir(), 0o100);
    try {
      await expect(pruneResultSessions({ saptoolsRoot: root })).rejects.toThrow();
      await expect(readResultSession(live.ref, { saptoolsRoot: root })).resolves.toMatchObject({ command: "find" });
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
      /not in a format this version of cf-otel understands/,
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
    // The two can disagree, and only the directory name resolves — listing the
    // body's copy advertised a ref that `result show` then rejected.
    await plant("0000000e", manifestJson({ ref: "MISMATCH" }));

    const summaries = await listResultSessions({ saptoolsRoot: root });
    expect(summaries.map((summary) => summary.ref)).toEqual(["0000000e"]);
    await expect(readResultSession("0000000e", { saptoolsRoot: root })).resolves.toBeDefined();
  });

  it("omits an expired session it was unable to delete", async () => {
    await plant("0000000f", manifestJson({ expiresAt: "2020-01-01T00:00:00.000Z" }));

    const summaries = await listResultSessions({
      saptoolsRoot: root,
      now: () => new Date("2020-01-02T00:00:00.000Z"),
    });
    expect(summaries).toEqual([]);
  });
});

describe("assertResultStoreWritable", () => {
  it("passes on a store that does not exist yet, creating it", async () => {
    await expect(assertResultStoreWritable({ saptoolsRoot: root })).resolves.toBeUndefined();
    expect(await readdir(resultsDir())).toEqual([]);
  });

  it("leaves no probe file behind", async () => {
    await assertResultStoreWritable({ saptoolsRoot: root });
    await assertResultStoreWritable({ saptoolsRoot: root });
    expect(await readdir(resultsDir())).toEqual([]);
  });

  it("fails when a plain file occupies the results path", async () => {
    await mkdir(join(root, "cf-otel"), { recursive: true, mode: 0o700 });
    await writeFile(resultsDir(), "not a directory\n", { encoding: "utf8", mode: 0o600 });

    const error = await assertResultStoreWritable({ saptoolsRoot: root }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CfOtelError);
    expect((error as CfOtelError).code).toBe("RESULT_STORE_NOT_WRITABLE");
    expect((error as CfOtelError).message).toContain("--save cannot write to the saved-result store");
  });

  it.skipIf(!asUnprivilegedUser)("fails when the store exists but is read-only", async () => {
    await mkdir(resultsDir(), { recursive: true, mode: 0o700 });
    await chmod(resultsDir(), 0o500);
    try {
      await expect(assertResultStoreWritable({ saptoolsRoot: root })).rejects.toMatchObject({
        code: "RESULT_STORE_NOT_WRITABLE",
      });
    } finally {
      await chmod(resultsDir(), 0o700);
    }
  });
});
