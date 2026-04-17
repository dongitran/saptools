import { describe, expect, it } from "vitest";

import { getAllRegions, getRegion, REGIONS } from "../../src/regions.js";
import { REGION_KEYS } from "../../src/types.js";

describe("regions", () => {
  it("exports one entry per REGION_KEY", () => {
    expect(Object.keys(REGIONS).length).toBe(REGION_KEYS.length);
    for (const key of REGION_KEYS) {
      expect(REGIONS[key]?.key).toBe(key);
    }
  });

  it("all endpoints use https", () => {
    for (const region of getAllRegions()) {
      expect(region.apiEndpoint.startsWith("https://")).toBe(true);
    }
  });

  it("getRegion returns the matching entry", () => {
    const r = getRegion("eu10");
    expect(r.apiEndpoint).toContain("eu10");
  });
});
