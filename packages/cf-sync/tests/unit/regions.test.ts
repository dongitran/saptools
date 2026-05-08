import { describe, expect, it } from "vitest";

import { getAllRegions, getRegion, REGIONS } from "../../src/regions.js";
import type { RegionKey } from "../../src/types.js";
import { REGION_KEYS } from "../../src/types.js";

const SCALE_OUT_REGIONS = [
  {
    key: "eu10-002",
    parentKey: "eu10",
    label: "Europe (Frankfurt) - AWS (eu10-002)",
    apiEndpoint: "https://api.cf.eu10-002.hana.ondemand.com",
  },
  {
    key: "eu10-003",
    parentKey: "eu10",
    label: "Europe (Frankfurt) - AWS (eu10-003)",
    apiEndpoint: "https://api.cf.eu10-003.hana.ondemand.com",
  },
  {
    key: "eu10-004",
    parentKey: "eu10",
    label: "Europe (Frankfurt) - AWS (eu10-004)",
    apiEndpoint: "https://api.cf.eu10-004.hana.ondemand.com",
  },
  {
    key: "eu10-005",
    parentKey: "eu10",
    label: "Europe (Frankfurt) - AWS (eu10-005)",
    apiEndpoint: "https://api.cf.eu10-005.hana.ondemand.com",
  },
  {
    key: "eu20-001",
    parentKey: "eu20",
    label: "Europe (Netherlands) - Azure (eu20-001)",
    apiEndpoint: "https://api.cf.eu20-001.hana.ondemand.com",
  },
  {
    key: "eu20-002",
    parentKey: "eu20",
    label: "Europe (Netherlands) - Azure (eu20-002)",
    apiEndpoint: "https://api.cf.eu20-002.hana.ondemand.com",
  },
  {
    key: "us10-001",
    parentKey: "us10",
    label: "US East (VA) - AWS (us10-001)",
    apiEndpoint: "https://api.cf.us10-001.hana.ondemand.com",
  },
  {
    key: "us10-002",
    parentKey: "us10",
    label: "US East (VA) - AWS (us10-002)",
    apiEndpoint: "https://api.cf.us10-002.hana.ondemand.com",
  },
] as const satisfies readonly {
  readonly key: RegionKey;
  readonly parentKey: RegionKey;
  readonly label: string;
  readonly apiEndpoint: string;
}[];

describe("regions", () => {
  it("exports one entry per REGION_KEY", () => {
    expect(Object.keys(REGIONS).length).toBe(REGION_KEYS.length);
    for (const key of REGION_KEYS) {
      expect(REGIONS[key].key).toBe(key);
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

  it("exports scale-out sub-regions with numbered endpoints", () => {
    for (const expected of SCALE_OUT_REGIONS) {
      expect(getRegion(expected.key)).toEqual({
        key: expected.key,
        label: expected.label,
        apiEndpoint: expected.apiEndpoint,
      });
    }
  });

  it("keeps scale-out sub-regions immediately after their parent region", () => {
    const keys = getAllRegions().map((region) => region.key);

    expect(keys.slice(keys.indexOf("eu10"), keys.indexOf("eu10") + 5)).toEqual([
      "eu10",
      "eu10-002",
      "eu10-003",
      "eu10-004",
      "eu10-005",
    ]);
    expect(keys.slice(keys.indexOf("eu20"), keys.indexOf("eu20") + 3)).toEqual([
      "eu20",
      "eu20-001",
      "eu20-002",
    ]);
    expect(keys.slice(keys.indexOf("us10"), keys.indexOf("us10") + 3)).toEqual([
      "us10",
      "us10-001",
      "us10-002",
    ]);
  });
});
