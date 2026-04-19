import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { COMMON_ENVIRONMENTS, setupApp } from "../../src/setup-app.js";

const regionNode: RegionNode = {
  key: "ap10",
  label: "Singapore",
  apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
  accessible: true,
  orgs: [
    {
      name: "demo",
      spaces: [
        { name: "dev", apps: [{ name: "api" }] },
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

describe("setupApp", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "saptools-bruno-setup-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates app folder with env files and cf vars", async () => {
    const result = await setupApp({
      root,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => true,
        selectEnvironments: async ({ common }) => [common[0] ?? "local"],
      },
    });
    expect(result.created).toBe(true);
    expect(result.ref.region).toBe("ap10");
    expect(result.environments).toHaveLength(1);
    const raw = await readFile(result.environments[0] ?? "", "utf8");
    expect(raw).toContain("__cf_region: ap10");
    expect(raw).toContain("__cf_org: demo");
  });

  it("honors user abort", async () => {
    const result = await setupApp({
      root,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => false,
        selectEnvironments: async () => ["local"],
      },
    });
    expect(result.created).toBe(false);
  });

  it("exposes common environments and existing envs to the prompt", async () => {
    interface Captured {
      readonly common: readonly string[];
      readonly existing: readonly string[];
    }
    const captured: Captured[] = [];
    const result = await setupApp({
      root,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => true,
        selectEnvironments: async (opts) => {
          captured.push({ common: opts.common, existing: opts.existing });
          return ["dev"];
        },
      },
    });
    expect(result.created).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.common).toEqual([...COMMON_ENVIRONMENTS]);
    expect(captured[0]?.existing).toEqual([]);
  });

  it("reuses existing env names on re-setup", async () => {
    const firstRun = await setupApp({
      root,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => true,
        selectEnvironments: async () => ["prod"],
      },
    });
    expect(firstRun.created).toBe(true);

    let offered: readonly string[] = [];
    const secondRun = await setupApp({
      root,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => true,
        selectEnvironments: async ({ existing }) => {
          offered = existing;
          return existing.length > 0 ? [existing[0] ?? "prod"] : ["prod"];
        },
      },
    });
    expect(secondRun.created).toBe(true);
    expect(offered).toEqual(["prod"]);
  });

  it("accepts custom environment names alongside common selections", async () => {
    const result = await setupApp({
      root,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => true,
        selectEnvironments: async () => ["dev", "qa-eu"],
      },
    });
    expect(result.created).toBe(true);
    expect(result.environments).toHaveLength(2);
    expect(result.environments.some((p) => p.endsWith("dev.bru"))).toBe(true);
    expect(result.environments.some((p) => p.endsWith("qa-eu.bru"))).toBe(true);
  });

  it("accepts a custom env name when no common names are selected", async () => {
    const result = await setupApp({
      root,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => true,
        selectEnvironments: async () => ["sandbox"],
      },
    });
    expect(result.created).toBe(true);
    expect(result.environments).toHaveLength(1);
    expect(result.environments[0]).toContain("sandbox.bru");
  });

  it("throws when the prompt returns no environments", async () => {
    await expect(
      setupApp({
        root,
        deps: makeDeps(),
        prompts: {
          selectRegion: async () => "ap10",
          selectOrg: async () => "demo",
          selectSpace: async () => "dev",
          selectApp: async () => "api",
          confirmCreate: async () => true,
          selectEnvironments: async () => [],
        },
      }),
    ).rejects.toThrow(/At least one environment/);
  });

  it("dedupes duplicate names returned by the prompt", async () => {
    const result = await setupApp({
      root,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => true,
        selectEnvironments: async () => ["dev", "dev"],
      },
    });
    expect(result.created).toBe(true);
    expect(result.environments).toHaveLength(1);
  });

  it("rejects an unsafe env name from the prompt", async () => {
    await expect(
      setupApp({
        root,
        deps: makeDeps(),
        prompts: {
          selectRegion: async () => "ap10",
          selectOrg: async () => "demo",
          selectSpace: async () => "dev",
          selectApp: async () => "api",
          confirmCreate: async () => true,
          selectEnvironments: async () => ["../escape"],
        },
      }),
    ).rejects.toThrow(/Invalid environment name/);
  });

  it("throws when no regions cached", async () => {
    await expect(
      setupApp({
        root,
        deps: makeDeps({ readStructureView: async () => undefined }),
        prompts: {
          selectRegion: async () => "ap10",
          selectOrg: async () => "demo",
          selectSpace: async () => "dev",
          selectApp: async () => "api",
          confirmCreate: async () => true,
          selectEnvironments: async () => ["local"],
        },
      }),
    ).rejects.toThrow(/No CF regions/);
  });
});
