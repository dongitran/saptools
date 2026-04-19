import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildRunPlan, runBruno } from "../../src/run.js";

describe("run", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "saptools-bruno-run-"));
    const envDir = join(root, "region__ap10", "org__o", "space__dev", "app1", "environments");
    await mkdir(envDir, { recursive: true });
    await writeFile(
      join(envDir, "local.bru"),
      [
        "vars {",
        "  __cf_region: ap10",
        "  __cf_org: o",
        "  __cf_space: dev",
        "  __cf_app: app1",
        "  baseUrl: https://example.com",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const folder = join(root, "region__ap10", "org__o", "space__dev", "app1", "requests");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "ping.bru"), "meta {\n  name: Ping\n}\n", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds a plan for a folder-level shorthand", async () => {
    const plan = await buildRunPlan({
      root,
      target: "ap10/o/dev/app1",
      getTokenCached: async () => "t0k3n",
    });
    expect(plan.environment).toBe("local");
    expect(plan.meta.region).toBe("ap10");
    expect(plan.bruArgs).toEqual(["run", "--env", "local", "--env-var", "accessToken=t0k3n"]);
  });

  it("builds a plan for a request-file shorthand", async () => {
    const plan = await buildRunPlan({
      root,
      target: "ap10/o/dev/app1/requests/ping.bru",
      environment: "local",
      getTokenCached: async () => "t0k3n",
    });
    expect(plan.bruArgs[0]).toBe("run");
    expect(plan.bruArgs[1]).toBe(join("requests", "ping.bru"));
  });

  it("runBruno calls spawnBru with plan args", async () => {
    const spawnBru = vi.fn(async (_args: readonly string[]) => ({ code: 0, stdout: "ok", stderr: "" }));
    const result = await runBruno({
      root,
      target: "ap10/o/dev/app1",
      getTokenCached: async () => "t0k3n",
      spawnBru,
    });
    expect(spawnBru).toHaveBeenCalledOnce();
    expect(result.code).toBe(0);
    expect(result.bruArgs).toEqual(["run", "--env", "local", "--env-var", "accessToken=t0k3n"]);
  });

  it("throws when target cannot be resolved", async () => {
    await expect(
      buildRunPlan({
        root,
        target: "zz99/o/dev/app1",
        getTokenCached: async () => "t",
      }),
    ).rejects.toThrow();
  });

  it("resolves an absolute file path to the containing app dir", async () => {
    const abs = join(root, "region__ap10", "org__o", "space__dev", "app1", "requests", "ping.bru");
    const plan = await buildRunPlan({
      root,
      target: abs,
      environment: "local",
      getTokenCached: async () => "t",
    });
    expect(plan.meta.app).toBe("app1");
    expect(plan.bruArgs[1]).toContain("ping.bru");
  });

  it("throws when asked for a missing environment", async () => {
    await expect(
      buildRunPlan({
        root,
        target: "ap10/o/dev/app1",
        environment: "ghost",
        getTokenCached: async () => "t",
      }),
    ).rejects.toThrow(/Environment file not found/);
  });

  it("throws when shorthand points at a missing file", async () => {
    await expect(
      buildRunPlan({
        root,
        target: "ap10/o/dev/app1/not/there.bru",
        getTokenCached: async () => "t",
      }),
    ).rejects.toThrow(/File not found/);
  });

  it("throws when env file lacks cf meta", async () => {
    const envFile = join(root, "region__ap10", "org__o", "space__dev", "app1", "environments", "broken.bru");
    await writeFile(envFile, "vars {\n  baseUrl: https://x\n}\n", "utf8");
    await expect(
      buildRunPlan({
        root,
        target: "ap10/o/dev/app1",
        environment: "broken",
        getTokenCached: async () => "t",
      }),
    ).rejects.toThrow(/Missing __cf_/);
  });
});
