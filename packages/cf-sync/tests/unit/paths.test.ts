import { sep } from "node:path";

import { describe, expect, it } from "vitest";

import { cfStructurePath, cfSyncHistoryPath, saptoolsDir } from "../../src/paths.js";

describe("paths", () => {
  it("saptoolsDir ends with .saptools", () => {
    expect(saptoolsDir().endsWith(`${sep}.saptools`)).toBe(true);
  });

  it("cfStructurePath ends with cf-structure.json", () => {
    expect(cfStructurePath().endsWith("cf-structure.json")).toBe(true);
  });

  it("cfSyncHistoryPath ends with cf-sync-history.jsonl", () => {
    expect(cfSyncHistoryPath().endsWith("cf-sync-history.jsonl")).toBe(true);
  });
});
