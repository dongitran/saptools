import { describe, expect, it } from "vitest";

import { parseHanaBindings as parseHanaBindingsFromShim } from "../../src/db-parser.js";
import {
  cfStructurePath as cfStructurePathFromIndex,
  getRegion as getRegionFromIndex,
  parseHanaBindings as parseHanaBindingsFromIndex,
  readStructureView as readStructureViewFromIndex,
  runSync as runSyncFromIndex,
} from "../../src/index.js";
import { cfStructurePath as cfStructurePathFromShim } from "../../src/paths.js";
import { getRegion as getRegionFromShim } from "../../src/regions.js";
import { readStructureView as readStructureViewFromShim } from "../../src/structure.js";
import { runSync as runSyncFromShim } from "../../src/sync.js";

describe("public exports", () => {
  it("keeps index and compatibility shims aligned after source folder moves", () => {
    expect(cfStructurePathFromIndex()).toBe(cfStructurePathFromShim());
    expect(getRegionFromIndex("ap10")).toEqual(getRegionFromShim("ap10"));
    expect(parseHanaBindingsFromIndex).toBe(parseHanaBindingsFromShim);
    expect(readStructureViewFromIndex).toBe(readStructureViewFromShim);
    expect(runSyncFromIndex).toBe(runSyncFromShim);
  });
});
