import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type {
  CfStructure,
  RegionNode,
  RegionsView,
  RegionView,
  StructureView,
} from "@saptools/cf-sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseBruEnvFile } from "../../src/bruno/parser.js";
import type { CfInfoDeps } from "../../src/cf/info.js";
import { COMMON_ENVIRONMENTS, setupApp } from "../../src/commands/setup-app.js";

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
    const collectionConfig = JSON.parse(await readFile(join(result.appPath, "bruno.json"), "utf8")) as {
      readonly name: string;
      readonly type: string;
    };
    expect(collectionConfig).toMatchObject({
      name: basename(result.appPath),
      type: "collection",
    });
    const raw = await readFile(result.environments[0] ?? "", "utf8");
    expect(raw).toContain("__cf_region: ap10");
    expect(raw).toContain("__cf_org: demo");
  });

  it("creates the collection config inside the app folder, not the outer root", async () => {
    const hiddenRoot = join(root, ".bruno");
    const result = await setupApp({
      root: hiddenRoot,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => true,
        selectEnvironments: async () => ["local"],
      },
    });
    expect(result.created).toBe(true);

    await expect(readFile(join(hiddenRoot, "bruno.json"), "utf8")).rejects.toBeDefined();
    const collectionConfig = JSON.parse(await readFile(join(result.appPath, "bruno.json"), "utf8")) as {
      readonly name: string;
    };
    expect(collectionConfig.name).toBe("api");
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

  it("preserves an existing bruno.json in the app folder", async () => {
    const appPath = join(root, "region__ap10", "org__demo", "space__dev", "api");
    await mkdir(appPath, { recursive: true });
    await writeFile(
      join(appPath, "bruno.json"),
      `${JSON.stringify({ version: "1", name: "custom-name", type: "collection" }, null, 2)}\n`,
      "utf8",
    );

    const result = await setupApp({
      root,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => true,
        selectEnvironments: async () => ["local"],
      },
    });

    expect(result.created).toBe(true);
    const collectionConfig = JSON.parse(await readFile(join(result.appPath, "bruno.json"), "utf8")) as {
      readonly name: string;
    };
    expect(collectionConfig.name).toBe("custom-name");
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

  it("trims environment names before validation and creation", async () => {
    const result = await setupApp({
      root,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => true,
        selectEnvironments: async () => [" dev ", "dev", " sandbox "],
      },
    });
    expect(result.created).toBe(true);
    expect(result.environments).toHaveLength(2);
    expect(result.environments.some((path) => path.endsWith("dev.bru"))).toBe(true);
    expect(result.environments.some((path) => path.endsWith("sandbox.bru"))).toBe(true);
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

  it("patches missing cf metadata into an existing env file", async () => {
    const envDir = join(root, "region__ap10", "org__demo", "space__dev", "api", "environments");
    await mkdir(envDir, { recursive: true });
    const envFile = join(envDir, "local.bru");
    await writeFile(
      envFile,
      "vars {\n  baseUrl: https://example.com\n}\n",
      "utf8",
    );

    const result = await setupApp({
      root,
      deps: makeDeps(),
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo",
        selectSpace: async () => "dev",
        selectApp: async () => "api",
        confirmCreate: async () => true,
        selectEnvironments: async () => ["local"],
      },
    });

    expect(result.created).toBe(true);
    const parsed = parseBruEnvFile(await readFile(envFile, "utf8"));
    expect(parsed.vars.entries.get("baseUrl")).toBe("https://example.com");
    expect(parsed.vars.entries.get("__cf_region")).toBe("ap10");
    expect(parsed.vars.entries.get("__cf_org")).toBe("demo");
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
    ).rejects.toThrow(/cf-sync sync/);
  });

  it("throws when all cached regions are inaccessible or empty", async () => {
    await expect(
      setupApp({
        root,
        deps: makeDeps({
          readStructureView: async () => ({
            source: "stable",
            structure: {
              syncedAt: "2026-04-18T00:00:00Z",
              regions: [
                { ...regionNode, accessible: false },
                { ...regionNode, key: "eu10", orgs: [] },
              ],
            },
            metadata: undefined,
          }),
        }),
        prompts: {
          selectRegion: async () => "ap10",
          selectOrg: async () => "demo",
          selectSpace: async () => "dev",
          selectApp: async () => "api",
          confirmCreate: async () => true,
          selectEnvironments: async () => ["local"],
        },
      }),
    ).rejects.toThrow(/No CF regions with orgs/);
  });

  it("throws when the chosen region is missing from the region cache", async () => {
    await expect(
      setupApp({
        root,
        deps: makeDeps({ readRegionView: async () => undefined }),
        prompts: {
          selectRegion: async () => "ap10",
          selectOrg: async () => "demo",
          selectSpace: async () => "dev",
          selectApp: async () => "api",
          confirmCreate: async () => true,
          selectEnvironments: async () => ["local"],
        },
      }),
    ).rejects.toThrow(/Region ap10 is not cached/);
  });

  it("throws when a freshly read region has no orgs", async () => {
    await expect(
      setupApp({
        root,
        deps: makeDeps({
          readRegionView: async () => ({
            source: "stable",
            region: { ...regionNode, orgs: [] },
            metadata: undefined,
          }),
        }),
        prompts: {
          selectRegion: async () => "ap10",
          selectOrg: async () => "demo",
          selectSpace: async () => "dev",
          selectApp: async () => "api",
          confirmCreate: async () => true,
          selectEnvironments: async () => ["local"],
        },
      }),
    ).rejects.toThrow(/has no accessible orgs/);
  });

  it("throws when the prompt returns an unknown org", async () => {
    await expect(
      setupApp({
        root,
        deps: makeDeps(),
        prompts: {
          selectRegion: async () => "ap10",
          selectOrg: async () => "unknown",
          selectSpace: async () => "dev",
          selectApp: async () => "api",
          confirmCreate: async () => true,
          selectEnvironments: async () => ["local"],
        },
      }),
    ).rejects.toThrow(/Org unknown not found/);
  });

  it("throws when the selected org has no spaces", async () => {
    await expect(
      setupApp({
        root,
        deps: makeDeps({
          readRegionView: async () => ({
            source: "stable",
            region: {
              ...regionNode,
              orgs: [{ name: "demo", spaces: [] }],
            },
            metadata: undefined,
          }),
        }),
        prompts: {
          selectRegion: async () => "ap10",
          selectOrg: async () => "demo",
          selectSpace: async () => "dev",
          selectApp: async () => "api",
          confirmCreate: async () => true,
          selectEnvironments: async () => ["local"],
        },
      }),
    ).rejects.toThrow(/has no spaces/);
  });

  it("throws when the prompt returns an unknown space", async () => {
    await expect(
      setupApp({
        root,
        deps: makeDeps(),
        prompts: {
          selectRegion: async () => "ap10",
          selectOrg: async () => "demo",
          selectSpace: async () => "unknown",
          selectApp: async () => "api",
          confirmCreate: async () => true,
          selectEnvironments: async () => ["local"],
        },
      }),
    ).rejects.toThrow(/Space unknown not found/);
  });

  it("throws when the selected space has no apps", async () => {
    await expect(
      setupApp({
        root,
        deps: makeDeps({
          readRegionView: async () => ({
            source: "stable",
            region: {
              ...regionNode,
              orgs: [{ name: "demo", spaces: [{ name: "dev", apps: [] }] }],
            },
            metadata: undefined,
          }),
        }),
        prompts: {
          selectRegion: async () => "ap10",
          selectOrg: async () => "demo",
          selectSpace: async () => "dev",
          selectApp: async () => "api",
          confirmCreate: async () => true,
          selectEnvironments: async () => ["local"],
        },
      }),
    ).rejects.toThrow(/has no apps/);
  });
});
