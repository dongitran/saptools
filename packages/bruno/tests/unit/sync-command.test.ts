import type { SyncResult } from "@saptools/cf-sync";
import { describe, expect, it, vi } from "vitest";

import { parseOnlyRegions, runSyncCommand } from "../../src/sync-command.js";

const syncResult: SyncResult = {
  structure: {
    syncedAt: "2026-04-21T00:00:00Z",
    regions: [],
  },
  accessibleRegions: ["ap10"],
  inaccessibleRegions: ["eu10"],
};

describe("parseOnlyRegions", () => {
  it("returns validated region keys", () => {
    expect(parseOnlyRegions("ap10, eu10")).toEqual(["ap10", "eu10"]);
  });

  it("rejects an empty --only value", () => {
    expect(() => parseOnlyRegions(" , ")).toThrow(/at least one region key/);
  });

  it("rejects unknown region keys", () => {
    expect(() => parseOnlyRegions("ap10,zz99")).toThrow(/Unknown region key/);
  });
});

describe("runSyncCommand", () => {
  it("passes validated options through to @saptools/cf-sync", async () => {
    const runSync = vi.fn<(_: unknown) => Promise<SyncResult>>(async () => syncResult);
    const writes: string[] = [];

    await runSyncCommand(
      { only: "ap10", verbose: true, interactive: true },
      {
        env: { SAP_EMAIL: "user@example.com", SAP_PASSWORD: "secret", CI: "true" },
        stdoutIsTTY: true,
        runSync,
        writeStdout: (message) => {
          writes.push(message);
        },
      },
    );

    expect(runSync).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "secret",
      verbose: true,
      interactive: false,
      onlyRegions: ["ap10"],
    });
    expect(writes[0]).toContain("Structure written to");
  });

  it("requires SAP credentials", async () => {
    await expect(
      runSyncCommand(
        {},
        {
          env: { SAP_EMAIL: "user@example.com" },
          stdoutIsTTY: false,
          runSync: async () => syncResult,
        },
      ),
    ).rejects.toThrow(/SAP_PASSWORD/);
  });
});
