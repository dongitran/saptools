import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as OsModule from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome = "";

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "saptools-cf-logs-test-"));
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

describe("store", () => {
  it("readStore returns an empty store when the file is missing", async () => {
    const { readStore } = await import("../../src/store.js");

    await expect(readStore()).resolves.toEqual({ version: 1, entries: [] });
  });

  it("writeStore persists entries readable by readStore", async () => {
    const { readStore, writeStore } = await import("../../src/store.js");
    const store = {
      version: 1 as const,
      entries: [
        {
          key: {
            apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
            org: "sample-org",
            space: "sample",
            app: "demo-app",
          },
          rawText: "sample-line",
          fetchedAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z",
          rowCount: 1,
          truncated: false,
        },
      ],
    };

    await writeStore(store);

    await expect(readStore()).resolves.toEqual(store);
  });

  it("readStore ignores malformed data gracefully", async () => {
    const { cfLogsStorePath } = await import("../../src/paths.js");
    const { readStore } = await import("../../src/store.js");

    await mkdir(dirname(cfLogsStorePath()), { recursive: true });
    await writeFile(cfLogsStorePath(), JSON.stringify({ version: 2 }), "utf8");

    await expect(readStore()).resolves.toEqual({ version: 1, entries: [] });
  });

  it("persistSnapshot upserts by scope key and bounds oversized raw text", async () => {
    const { findStoreEntry, persistSnapshot, readStore } = await import("../../src/store.js");
    const rows = [
      {
        id: 1,
        timestamp: "09:14:40",
        timestampRaw: "2026-04-12T09:14:40.00+0700",
        source: "APP/0",
        stream: "OUT" as const,
        format: "text" as const,
        level: "info" as const,
        logger: "app",
        component: "",
        org: "",
        space: "",
        host: "app",
        method: "",
        request: "sample",
        status: "",
        latency: "",
        tenant: "",
        clientIp: "",
        requestId: "",
        message: "sample",
        rawBody: "sample",
        jsonPayload: null,
        searchableText: "sample",
      },
    ];

    const first = await persistSnapshot({
      key: {
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        org: "sample-org",
        space: "sample",
        app: "demo-app",
      },
      rawText: "a".repeat(600_000),
      rows,
      logLimit: 300,
      fetchedAt: "2026-04-18T00:00:00.000Z",
    });

    expect(first.key.app).toBe("demo-app");
    expect(first.rawText.length).toBeLessThan(600_000);
    expect(first.truncated).toBe(true);

    await persistSnapshot({
      key: first.key,
      rawText: "updated",
      rows,
      logLimit: 300,
      fetchedAt: "2026-04-18T00:10:00.000Z",
    });

    const store = await readStore();
    expect(store.entries).toHaveLength(1);
    expect(findStoreEntry(store, first.key)?.rawText).toBe("updated");
  });
});
