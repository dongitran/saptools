import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "saptools-sync-test-"));
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => tempHome };
  });
});

afterEach(async () => {
  vi.doUnmock("../../src/cf.js");
  vi.doUnmock("node:os");
  await rm(tempHome, { recursive: true, force: true });
});

describe("runSync", () => {
  it("walks region → org → space → app for each region", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockResolvedValue(undefined),
      cfAuth: vi.fn().mockResolvedValue(undefined),
      cfOrgs: vi.fn().mockResolvedValue(["org-a"]),
      cfTargetOrg: vi.fn().mockResolvedValue(undefined),
      cfTargetSpace: vi.fn().mockResolvedValue(undefined),
      cfSpaces: vi.fn().mockResolvedValue(["dev"]),
      cfApps: vi.fn().mockResolvedValue(["app1", "app2"]),
    }));

    const { runSync } = await import("../../src/sync.js");
    const result = await runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    expect(result.accessibleRegions).toEqual(["ap10"]);
    expect(result.structure.regions).toHaveLength(1);
    const region = result.structure.regions[0]!;
    expect(region.orgs).toHaveLength(1);
    expect(region.orgs[0]!.spaces).toHaveLength(1);
    expect(region.orgs[0]!.spaces[0]!.apps.map((a) => a.name)).toEqual(["app1", "app2"]);
  });

  it("marks region as inaccessible when auth fails", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockResolvedValue(undefined),
      cfAuth: vi.fn().mockRejectedValue(new Error("403")),
      cfOrgs: vi.fn(),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    const { runSync } = await import("../../src/sync.js");
    const result = await runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    expect(result.accessibleRegions).toEqual([]);
    expect(result.inaccessibleRegions).toEqual(["ap10"]);
    expect(result.structure.regions[0]!.accessible).toBe(false);
    expect(result.structure.regions[0]!.orgs).toHaveLength(0);
  });

  it("skips org when target fails, continues with next", async () => {
    const cfTargetOrg = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("no-access")))
      .mockResolvedValue(undefined);

    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockResolvedValue(undefined),
      cfAuth: vi.fn().mockResolvedValue(undefined),
      cfOrgs: vi.fn().mockResolvedValue(["bad-org", "good-org"]),
      cfTargetOrg,
      cfTargetSpace: vi.fn().mockResolvedValue(undefined),
      cfSpaces: vi.fn().mockResolvedValue(["dev"]),
      cfApps: vi.fn().mockResolvedValue(["app1"]),
    }));

    const { runSync } = await import("../../src/sync.js");
    const result = await runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    const region = result.structure.regions[0]!;
    expect(region.orgs.map((o) => o.name)).toEqual(["bad-org", "good-org"]);
    expect(region.orgs[0]!.spaces).toHaveLength(0);
    expect(region.orgs[1]!.spaces).toHaveLength(1);
  });

  it("skips space when target fails", async () => {
    const cfTargetSpace = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("no-space")))
      .mockResolvedValue(undefined);

    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockResolvedValue(undefined),
      cfAuth: vi.fn().mockResolvedValue(undefined),
      cfOrgs: vi.fn().mockResolvedValue(["org-a"]),
      cfTargetOrg: vi.fn().mockResolvedValue(undefined),
      cfTargetSpace,
      cfSpaces: vi.fn().mockResolvedValue(["bad-space", "good-space"]),
      cfApps: vi.fn().mockResolvedValue(["app"]),
    }));

    const { runSync } = await import("../../src/sync.js");
    const result = await runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    const org = result.structure.regions[0]!.orgs[0]!;
    expect(org.spaces.map((s) => s.name)).toEqual(["bad-space", "good-space"]);
    expect(org.spaces[0]!.apps).toHaveLength(0);
    expect(org.spaces[1]!.apps).toHaveLength(1);
  });

  it("writes structure to configured path", async () => {
    vi.doMock("../../src/cf.js", () => ({
      cfApi: vi.fn().mockResolvedValue(undefined),
      cfAuth: vi.fn().mockResolvedValue(undefined),
      cfOrgs: vi.fn().mockResolvedValue([]),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfSpaces: vi.fn(),
      cfApps: vi.fn(),
    }));

    await (await import("../../src/sync.js")).runSync({
      email: "e",
      password: "p",
      onlyRegions: ["ap10"],
    });

    const { readStructure } = await import("../../src/structure.js");
    const saved = await readStructure();
    expect(saved?.regions).toHaveLength(1);
  });
});
