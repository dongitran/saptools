import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearTailStore, persistTailSnapshot, readTailStore } from "../../src/store.js";
import type { AppSnapshotResult } from "../../src/types.js";

let tmpDir = "";
let storePath = "";

function buildApp(name: string, rowCount: number): AppSnapshotResult {
  return {
    appName: name,
    rawText: "raw",
    rows: Array.from({ length: rowCount }, (_, index) => ({
      id: index + 1,
      timestamp: "12:14:40",
      timestampRaw: "2026-04-12T09:14:40.00+0700",
      source: "APP/PROC/WEB/0",
      stream: "OUT",
      format: "text",
      level: "info",
      logger: "app",
      component: "",
      org: "",
      space: "",
      host: "app",
      method: "",
      request: "ready",
      status: "",
      latency: "",
      tenant: "",
      clientIp: "",
      requestId: "",
      message: "ready",
      rawBody: "ready",
      jsonPayload: null,
      searchableText: "ready",
    })),
    fetchedAt: "2026-04-12T09:14:40.000Z",
    truncated: false,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cf-tail-store-"));
  storePath = join(tmpDir, "store.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("tail store", () => {
  it("returns an empty store before any writes", async () => {
    const store = await readTailStore(storePath);
    expect(store.entries).toEqual([]);
  });

  it("persists and re-reads aggregate entries", async () => {
    const entry = await persistTailSnapshot({
      key: {
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        org: "sample-org",
        space: "sample",
      },
      fetchedAt: "2026-04-12T09:14:40.000Z",
      apps: [buildApp("alpha", 2), buildApp("beta", 1)],
      storePath,
    });
    expect(entry.appCount).toBe(2);
    expect(entry.rowCount).toBe(3);
    const store = await readTailStore(storePath);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]?.apps.map((app) => app.appName)).toEqual(["alpha", "beta"]);
  });

  it("clears all entries", async () => {
    await persistTailSnapshot({
      key: {
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        org: "sample-org",
        space: "sample",
      },
      fetchedAt: "2026-04-12T09:14:40.000Z",
      apps: [buildApp("alpha", 1)],
      storePath,
    });
    await clearTailStore(storePath);
    const store = await readTailStore(storePath);
    expect(store.entries).toEqual([]);
  });
});
