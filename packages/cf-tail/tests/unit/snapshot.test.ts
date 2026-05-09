import type { LogStoreEntry, PersistSnapshotInput } from "@saptools/cf-logs";
import { describe, expect, it, vi } from "vitest";

import { fetchSnapshotsForApps } from "../../src/snapshot.js";

const sampleSession = {
  apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
  email: "user@example.com",
  password: "secret",
  org: "sample-org",
  space: "sample",
} as const;

describe("fetchSnapshotsForApps", () => {
  it("returns an empty result when no apps match", async () => {
    const result = await fetchSnapshotsForApps({
      session: { ...sampleSession },
      apps: [],
    });
    expect(result.apps).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.merged).toEqual([]);
  });

  it("fetches each app with bounded redaction and merges chronologically", async () => {
    const prepareSession = vi.fn(async () => undefined);
    const fetchRecentLogsFromTarget = vi.fn(async ({ appName }: { readonly appName: string }) => {
      if (appName === "alpha") {
        return [
          "Retrieving logs for app alpha in org sample-org / space sample as user@example.com...",
          "2026-04-12T09:14:42.00+0700 [APP/PROC/WEB/0] OUT alpha-late",
          "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT secret",
        ].join("\n");
      }
      return "2026-04-12T09:14:41.00+0700 [APP/PROC/WEB/0] OUT beta-mid\n";
    });
    const persistSnapshot = vi.fn(async (input: PersistSnapshotInput): Promise<LogStoreEntry> => ({
      key: input.key,
      rawText: input.rawText,
      fetchedAt: input.fetchedAt ?? "2026-04-12T09:14:40.000Z",
      updatedAt: input.fetchedAt ?? "2026-04-12T09:14:40.000Z",
      rowCount: input.rows.length,
      truncated: false,
    }));

    const result = await fetchSnapshotsForApps({
      session: { ...sampleSession },
      apps: [
        { name: "alpha", runningInstances: 1 },
        { name: "beta", runningInstances: 1 },
      ],
      persist: true,
      now: () => new Date("2026-04-12T02:14:43.000Z"),
      dependencies: {
        prepareSession,
        fetchRecentLogsFromTarget,
        persistSnapshot,
      },
    });

    expect(prepareSession).toHaveBeenCalledOnce();
    expect(fetchRecentLogsFromTarget).toHaveBeenCalledTimes(2);
    expect(persistSnapshot).toHaveBeenCalledTimes(2);
    expect(result.apps.map((entry) => entry.appName)).toEqual(["alpha", "beta"]);
    expect(result.errors).toEqual([]);
    expect(result.merged.map((row) => row.appName)).toEqual(["alpha", "beta", "alpha"]);
    const alphaSnapshot = result.apps.find((entry) => entry.appName === "alpha");
    expect(alphaSnapshot?.rawText).not.toContain("secret");
    expect(alphaSnapshot?.rawText).toContain("***");
  });

  it("captures per-app errors without failing the batch", async () => {
    const fetchRecentLogsFromTarget = vi.fn(
      async ({ appName }: { readonly appName: string }): Promise<string> => {
        if (appName === "broken") {
          throw new Error("boom");
        }
        return "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT ok\n";
      },
    );
    const result = await fetchSnapshotsForApps({
      session: { ...sampleSession },
      apps: [
        { name: "ok-app", runningInstances: 1 },
        { name: "broken", runningInstances: 1 },
      ],
      dependencies: {
        prepareSession: async () => undefined,
        fetchRecentLogsFromTarget,
      },
    });
    expect(result.apps.map((entry) => entry.appName)).toEqual(["ok-app"]);
    expect(result.errors).toEqual([{ appName: "broken", error: "boom" }]);
  });
});
