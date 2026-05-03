import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type * as OsModule from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRef, XsuaaCredentials, XsuaaStore } from "../../src/types.js";

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "saptools-xsuaa-test-"));
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof OsModule>("node:os");
    return { ...actual, homedir: () => tempHome };
  });
});

afterEach(async () => {
  vi.doUnmock("node:os");
  await rm(tempHome, { recursive: true, force: true });
});

const ref: AppRef = { region: "ap10", org: "o", space: "s", app: "a" };
const creds: XsuaaCredentials = {
  clientId: "cid",
  clientSecret: "csec",
  url: "https://uaa",
};

describe("store", () => {
  it("readStore returns empty store when file missing", async () => {
    const { readStore } = await import("../../src/store/index.js");
    expect(await readStore()).toEqual({ version: 1, entries: [] });
  });

  it("writeStore persists entries readable by readStore", async () => {
    const { writeStore, readStore } = await import("../../src/store/index.js");
    const store: XsuaaStore = {
      version: 1,
      entries: [{ ...ref, credentials: creds, fetchedAt: "2026-04-18T00:00:00.000Z" }],
    };
    await writeStore(store);
    expect(await readStore()).toEqual(store);
  });

  it("writeStore creates the cache with owner-only permissions", async () => {
    const { writeStore } = await import("../../src/store/index.js");
    const { xsuaaDataPath } = await import("../../src/paths.js");
    await writeStore({ version: 1, entries: [] });
    const mode = (await stat(xsuaaDataPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writeStore tightens permissions on an existing cache", async () => {
    const { writeStore } = await import("../../src/store/index.js");
    const { xsuaaDataPath } = await import("../../src/paths.js");
    await mkdir(dirname(xsuaaDataPath()), { recursive: true });
    await writeFile(xsuaaDataPath(), JSON.stringify({ version: 1, entries: [] }), {
      encoding: "utf8",
      mode: 0o644,
    });

    await writeStore({ version: 1, entries: [] });

    const mode = (await stat(xsuaaDataPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("readStore ignores malformed data gracefully", async () => {
    const { readStore } = await import("../../src/store/index.js");
    const { xsuaaDataPath } = await import("../../src/paths.js");
    await mkdir(dirname(xsuaaDataPath()), { recursive: true });
    await writeFile(xsuaaDataPath(), JSON.stringify({ version: 2 }), "utf8");
    expect(await readStore()).toEqual({ version: 1, entries: [] });
  });

  it("readStore ignores stores whose entries are not an array", async () => {
    const { readStore } = await import("../../src/store/index.js");
    const { xsuaaDataPath } = await import("../../src/paths.js");
    await mkdir(dirname(xsuaaDataPath()), { recursive: true });
    await writeFile(xsuaaDataPath(), JSON.stringify({ version: 1, entries: {} }), "utf8");
    expect(await readStore()).toEqual({ version: 1, entries: [] });
  });

  it("readStore propagates invalid JSON", async () => {
    const { readStore } = await import("../../src/store/index.js");
    const { xsuaaDataPath } = await import("../../src/paths.js");
    await mkdir(dirname(xsuaaDataPath()), { recursive: true });
    await writeFile(xsuaaDataPath(), "{not-json}", "utf8");
    await expect(readStore()).rejects.toThrow(SyntaxError);
  });

  it("writeStore writes a trailing newline", async () => {
    const { writeStore } = await import("../../src/store/index.js");
    const { xsuaaDataPath } = await import("../../src/paths.js");
    await writeStore({ version: 1, entries: [] });
    await expect(readFile(xsuaaDataPath(), "utf8")).resolves.toMatch(/\n$/);
  });

  it("upsertSecret creates new entry", async () => {
    const { upsertSecret } = await import("../../src/store/index.js");
    const now = new Date("2026-04-18T00:00:00.000Z");
    const next = upsertSecret({ version: 1, entries: [] }, ref, creds, now);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).toMatchObject({ ...ref, credentials: creds, fetchedAt: now.toISOString() });
  });

  it("upsertSecret updates existing entry in place", async () => {
    const { upsertSecret } = await import("../../src/store/index.js");
    const base = upsertSecret({ version: 1, entries: [] }, ref, creds, new Date(0));
    const next = upsertSecret(base, ref, { ...creds, clientSecret: "NEW" }, new Date(1000));
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]?.credentials.clientSecret).toBe("NEW");
  });

  it("upsertSecret preserves an existing token when credentials rotate", async () => {
    const { upsertSecret, upsertToken } = await import("../../src/store/index.js");
    const base = upsertSecret({ version: 1, entries: [] }, ref, creds, new Date(0));
    const withToken = upsertToken(base, ref, {
      accessToken: "cached-token",
      expiresAt: "2026-04-18T01:00:00.000Z",
    });

    const next = upsertSecret(withToken, ref, { ...creds, clientSecret: "rotated" }, new Date(1000));

    expect(next.entries[0]?.credentials.clientSecret).toBe("rotated");
    expect(next.entries[0]?.token?.accessToken).toBe("cached-token");
  });

  it("upsertSecret preserves unrelated entries and order", async () => {
    const { upsertSecret } = await import("../../src/store/index.js");
    const otherRef: AppRef = { ...ref, app: "other" };
    const first = upsertSecret({ version: 1, entries: [] }, otherRef, creds, new Date(0));
    const second = upsertSecret(first, ref, creds, new Date(1000));
    const next = upsertSecret(second, ref, { ...creds, clientId: "new-client" }, new Date(2000));

    expect(next.entries.map((entry) => entry.app)).toEqual(["other", "a"]);
    expect(next.entries[0]?.credentials.clientId).toBe("cid");
    expect(next.entries[1]?.credentials.clientId).toBe("new-client");
  });

  it("findEntry matches by (region, org, space, app)", async () => {
    const { findEntry, upsertSecret } = await import("../../src/store/index.js");
    const store = upsertSecret({ version: 1, entries: [] }, ref, creds);
    expect(findEntry(store, ref)).toBeDefined();
    expect(findEntry(store, { ...ref, app: "other" })).toBeUndefined();
  });

  it("matchesRef checks every AppRef field", async () => {
    const { matchesRef, upsertSecret } = await import("../../src/store/index.js");
    const store = upsertSecret({ version: 1, entries: [] }, ref, creds);
    const entry = store.entries[0];

    expect(entry).toBeDefined();
    if (!entry) {
      throw new Error("Expected test store entry");
    }
    expect(matchesRef(entry, ref)).toBe(true);
    expect(matchesRef(entry, { ...ref, region: "other" })).toBe(false);
    expect(matchesRef(entry, { ...ref, org: "other" })).toBe(false);
    expect(matchesRef(entry, { ...ref, space: "other" })).toBe(false);
    expect(matchesRef(entry, { ...ref, app: "other" })).toBe(false);
  });

  it("upsertToken adds token to existing entry", async () => {
    const { upsertSecret, upsertToken, findEntry } = await import("../../src/store/index.js");
    const store = upsertSecret({ version: 1, entries: [] }, ref, creds);
    const next = upsertToken(store, ref, { accessToken: "tok", expiresAt: "2026-04-18T01:00:00.000Z" });
    expect(findEntry(next, ref)?.token?.accessToken).toBe("tok");
  });

  it("upsertToken preserves credentials, fetchedAt, unrelated entries, and order", async () => {
    const { upsertSecret, upsertToken } = await import("../../src/store/index.js");
    const otherRef: AppRef = { ...ref, app: "other" };
    const first = upsertSecret({ version: 1, entries: [] }, ref, creds, new Date(0));
    const second = upsertSecret(first, otherRef, { ...creds, clientId: "other-client" }, new Date(1000));
    const next = upsertToken(second, ref, {
      accessToken: "tok",
      expiresAt: "2026-04-18T01:00:00.000Z",
    });

    expect(next.entries.map((entry) => entry.app)).toEqual(["a", "other"]);
    expect(next.entries[0]?.credentials).toEqual(creds);
    expect(next.entries[0]?.fetchedAt).toBe(new Date(0).toISOString());
    expect(next.entries[1]?.credentials.clientId).toBe("other-client");
  });

  it("upsertToken throws when entry missing", async () => {
    const { upsertToken } = await import("../../src/store/index.js");
    expect(() =>
      upsertToken({ version: 1, entries: [] }, ref, {
        accessToken: "t",
        expiresAt: "2026-04-18T01:00:00.000Z",
      }),
    ).toThrow(/entry not found/);
  });
});
