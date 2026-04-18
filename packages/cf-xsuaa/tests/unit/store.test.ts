import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const { readStore } = await import("../../src/store.js");
    expect(await readStore()).toEqual({ version: 1, entries: [] });
  });

  it("writeStore persists entries readable by readStore", async () => {
    const { writeStore, readStore } = await import("../../src/store.js");
    const store: XsuaaStore = {
      version: 1,
      entries: [{ ...ref, credentials: creds, fetchedAt: "2026-04-18T00:00:00.000Z" }],
    };
    await writeStore(store);
    expect(await readStore()).toEqual(store);
  });

  it("readStore ignores malformed data gracefully", async () => {
    const { readStore } = await import("../../src/store.js");
    const { xsuaaDataPath } = await import("../../src/paths.js");
    await mkdir(dirname(xsuaaDataPath()), { recursive: true });
    await writeFile(xsuaaDataPath(), JSON.stringify({ version: 2 }), "utf8");
    expect(await readStore()).toEqual({ version: 1, entries: [] });
  });

  it("upsertSecret creates new entry", async () => {
    const { upsertSecret } = await import("../../src/store.js");
    const now = new Date("2026-04-18T00:00:00.000Z");
    const next = upsertSecret({ version: 1, entries: [] }, ref, creds, now);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).toMatchObject({ ...ref, credentials: creds, fetchedAt: now.toISOString() });
  });

  it("upsertSecret updates existing entry in place", async () => {
    const { upsertSecret } = await import("../../src/store.js");
    const base = upsertSecret({ version: 1, entries: [] }, ref, creds, new Date(0));
    const next = upsertSecret(base, ref, { ...creds, clientSecret: "NEW" }, new Date(1000));
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]?.credentials.clientSecret).toBe("NEW");
  });

  it("findEntry matches by (region, org, space, app)", async () => {
    const { findEntry, upsertSecret } = await import("../../src/store.js");
    const store = upsertSecret({ version: 1, entries: [] }, ref, creds);
    expect(findEntry(store, ref)).toBeDefined();
    expect(findEntry(store, { ...ref, app: "other" })).toBeUndefined();
  });

  it("upsertToken adds token to existing entry", async () => {
    const { upsertSecret, upsertToken, findEntry } = await import("../../src/store.js");
    const store = upsertSecret({ version: 1, entries: [] }, ref, creds);
    const next = upsertToken(store, ref, { accessToken: "tok", expiresAt: "2026-04-18T01:00:00.000Z" });
    expect(findEntry(next, ref)?.token?.accessToken).toBe("tok");
  });

  it("upsertToken throws when entry missing", async () => {
    const { upsertToken } = await import("../../src/store.js");
    expect(() =>
      upsertToken({ version: 1, entries: [] }, ref, {
        accessToken: "t",
        expiresAt: "2026-04-18T01:00:00.000Z",
      }),
    ).toThrow(/entry not found/);
  });
});
