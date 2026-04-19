import type {
  CfStructure,
  RegionNode,
  RegionsView,
  RegionView,
  StructureView,
} from "@saptools/cf-sync";
import { describe, expect, it } from "vitest";

import type { CfInfoDeps } from "../../src/cf-info.js";
import {
  findApp,
  findOrg,
  findSpace,
  getRegion,
  getStructureSnapshot,
  isValidRegionKey,
  listRegionsWithContent,
  resolveRef,
} from "../../src/cf-info.js";

const regionNode: RegionNode = {
  key: "ap10",
  label: "Singapore",
  apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
  accessible: true,
  orgs: [
    {
      name: "demo",
      spaces: [
        { name: "dev", apps: [{ name: "api" }, { name: "web" }] },
        { name: "prod", apps: [] },
      ],
    },
  ],
};

const structure: CfStructure = {
  syncedAt: "2026-04-18T00:00:00Z",
  regions: [regionNode],
};

function makeDeps(overrides: Partial<CfInfoDeps> = {}): CfInfoDeps {
  const structureView: StructureView = { source: "stable", structure, metadata: undefined };
  const regionsView: RegionsView = {
    source: "stable",
    regions: [{ key: "ap10", label: "Singapore", apiEndpoint: regionNode.apiEndpoint }],
    metadata: undefined,
  };
  const regionView: RegionView = { source: "stable", region: regionNode, metadata: undefined };

  return {
    readStructureView: async () => structureView,
    readRegionsView: async () => regionsView,
    readRegionView: async () => regionView,
    getRegionView: async () => regionView,
    ...overrides,
  };
}

describe("isValidRegionKey", () => {
  it("accepts known keys", () => {
    expect(isValidRegionKey("ap10")).toBe(true);
  });
  it("rejects unknown keys", () => {
    expect(isValidRegionKey("xx99")).toBe(false);
  });
});

describe("getStructureSnapshot", () => {
  it("returns empty when there is no view", async () => {
    const snap = await getStructureSnapshot(
      makeDeps({ readStructureView: async () => undefined }),
    );
    expect(snap.source).toBe("empty");
    expect(snap.structure).toBeUndefined();
    expect(snap.stale).toBe(true);
  });

  it("marks runtime with status=running as stale", async () => {
    const snap = await getStructureSnapshot(
      makeDeps({
        readStructureView: async () => ({
          source: "runtime",
          structure,
          metadata: {
            syncId: "x",
            status: "running",
            startedAt: "2026-04-18T00:00:00Z",
            updatedAt: "2026-04-18T00:00:05Z",
            requestedRegionKeys: ["ap10"],
            completedRegionKeys: [],
            pendingRegionKeys: ["ap10"],
          },
        }),
      }),
    );
    expect(snap.stale).toBe(true);
    expect(snap.message).toContain("partial data");
  });

  it("returns stable data as not-stale", async () => {
    const snap = await getStructureSnapshot(makeDeps());
    expect(snap.source).toBe("stable");
    expect(snap.stale).toBe(false);
  });
});

describe("listRegionsWithContent", () => {
  it("returns regions with orgs only", async () => {
    const regions = await listRegionsWithContent(makeDeps());
    expect(regions).toEqual([{ key: "ap10", label: "Singapore", orgCount: 1 }]);
  });

  it("returns empty when no structure", async () => {
    const regions = await listRegionsWithContent(
      makeDeps({ readStructureView: async () => undefined }),
    );
    expect(regions).toEqual([]);
  });
});

describe("navigators", () => {
  it("find org / space / app", () => {
    const org = findOrg(regionNode, "demo");
    expect(org?.name).toBe("demo");
    const space = findSpace(org!, "dev");
    expect(space?.name).toBe("dev");
    const app = findApp(space!, "api");
    expect(app?.name).toBe("api");
    expect(findApp(space!, "missing")).toBeUndefined();
  });
});

describe("getRegion", () => {
  it("returns the region node", async () => {
    const region = await getRegion("ap10", makeDeps());
    expect(region?.key).toBe("ap10");
  });
});

describe("resolveRef", () => {
  it("resolves a full ref", async () => {
    const resolved = await resolveRef(
      { region: "ap10", org: "demo", space: "dev", app: "api" },
      makeDeps(),
    );
    expect(resolved?.app.name).toBe("api");
  });

  it("returns undefined when any level missing", async () => {
    expect(
      await resolveRef({ region: "ap10", org: "ghost", space: "dev", app: "api" }, makeDeps()),
    ).toBeUndefined();
  });
});
