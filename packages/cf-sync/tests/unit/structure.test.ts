import { describe, expect, it } from "vitest";

import { findApp, findOrg, findRegion, findSpace } from "../../src/structure.js";
import type { CfStructure } from "../../src/types.js";

const sample: CfStructure = {
  syncedAt: "2026-04-18T00:00:00.000Z",
  regions: [
    {
      key: "ap10",
      label: "Australia (Sydney) - AWS (ap10)",
      apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
      accessible: true,
      orgs: [
        {
          name: "my-org",
          spaces: [
            { name: "dev", apps: [{ name: "app1" }, { name: "app2" }] },
            { name: "staging", apps: [{ name: "app1" }] },
          ],
        },
      ],
    },
  ],
};

describe("structure helpers", () => {
  it("findRegion locates by key", () => {
    const region = findRegion(sample, "ap10");
    expect(region?.accessible).toBe(true);
  });

  it("findRegion returns undefined for unknown key", () => {
    expect(findRegion(sample, "eu10")).toBeUndefined();
  });

  it("findOrg locates org inside region", () => {
    const region = findRegion(sample, "ap10")!;
    expect(findOrg(region, "my-org")?.name).toBe("my-org");
    expect(findOrg(region, "missing")).toBeUndefined();
  });

  it("findSpace locates space inside org", () => {
    const region = findRegion(sample, "ap10")!;
    const org = findOrg(region, "my-org")!;
    expect(findSpace(org, "dev")?.apps).toHaveLength(2);
    expect(findSpace(org, "prod")).toBeUndefined();
  });

  it("findApp locates app inside space", () => {
    const region = findRegion(sample, "ap10")!;
    const org = findOrg(region, "my-org")!;
    const space = findSpace(org, "dev")!;
    expect(findApp(space, "app1")?.name).toBe("app1");
    expect(findApp(space, "missing")).toBeUndefined();
  });
});
