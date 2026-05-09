import { describe, expect, it } from "vitest";

import { diffAppCatalogs } from "../../src/discovery.js";

describe("diffAppCatalogs", () => {
  it("computes added and removed app names", () => {
    const before = [
      { name: "alpha", runningInstances: 1 },
      { name: "beta", runningInstances: 1 },
    ];
    const after = [
      { name: "beta", runningInstances: 1 },
      { name: "gamma", runningInstances: 1 },
    ];
    const diff = diffAppCatalogs(before, after);
    expect(diff.addedApps).toEqual(["gamma"]);
    expect(diff.removedApps).toEqual(["alpha"]);
  });

  it("returns empty arrays when catalogs match", () => {
    const apps = [{ name: "a", runningInstances: 1 }];
    const diff = diffAppCatalogs(apps, apps);
    expect(diff.addedApps).toEqual([]);
    expect(diff.removedApps).toEqual([]);
  });
});
