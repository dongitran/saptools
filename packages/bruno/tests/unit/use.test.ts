import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CfStructure,
  RegionNode,
  RegionsView,
  RegionView,
  StructureView,
} from "@saptools/cf-sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CfInfoDeps } from "../../src/cf-info.js";
import { readContext } from "../../src/context.js";
import { parseContextShorthand, useContext } from "../../src/use.js";

const regionNode: RegionNode = {
  key: "ap10",
  label: "Singapore",
  apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
  accessible: true,
  orgs: [{ name: "o", spaces: [{ name: "s", apps: [{ name: "a" }] }] }],
};

const structure: CfStructure = { syncedAt: "2026", regions: [regionNode] };

function makeDeps(): CfInfoDeps {
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
  };
}

describe("parseContextShorthand", () => {
  it("parses 4 segments", () => {
    expect(parseContextShorthand("ap10/o/s/a")).toEqual({ region: "ap10", org: "o", space: "s", app: "a" });
  });
  it("rejects short input", () => {
    expect(parseContextShorthand("ap10/o")).toBeUndefined();
  });
});

describe("useContext", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "saptools-bruno-use-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;
  });
  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("writes context after verifying against the structure", async () => {
    const ctx = await useContext({ shorthand: "ap10/o/s/a", deps: makeDeps() });
    expect(ctx.app).toBe("a");
    const read = await readContext();
    expect(read?.org).toBe("o");
  });

  it("rejects unknown region", async () => {
    await expect(useContext({ shorthand: "zz99/o/s/a", deps: makeDeps() })).rejects.toThrow(/Unknown region/);
  });

  it("skips verification when verify=false", async () => {
    const ctx = await useContext({
      shorthand: "ap10/ghost/s/a",
      verify: false,
    });
    expect(ctx.org).toBe("ghost");
  });

  it("rejects when ref not found in structure", async () => {
    await expect(
      useContext({ shorthand: "ap10/ghost/s/a", deps: makeDeps() }),
    ).rejects.toThrow(/cf-sync sync/);
  });
});
