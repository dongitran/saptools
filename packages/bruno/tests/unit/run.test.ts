import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseBruEnvFile } from "../../src/bruno/parser.js";
import { buildRunPlan, resolveBruRuntime, runBruno } from "../../src/commands/run.js";

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

  it("resolves a request-file shorthand without the .bru extension", async () => {
    const plan = await buildRunPlan({
      root,
      target: "ap10/o/dev/app1/requests/ping",
      environment: "local",
      getTokenCached: async () => "t0k3n",
    });
    expect(plan.filePath.endsWith("ping.bru")).toBe(true);
    expect(plan.bruArgs[1]).toBe(join("requests", "ping.bru"));
  });

  it("appends extra arguments after token injection", async () => {
    const plan = await buildRunPlan({
      root,
      target: "ap10/o/dev/app1",
      getTokenCached: async () => "t0k3n",
      extraArgs: ["--reporter-json", "results.json"],
    });
    expect(plan.bruArgs).toEqual([
      "run",
      "--env",
      "local",
      "--env-var",
      "accessToken=t0k3n",
      "--reporter-json",
      "results.json",
    ]);
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

  it("passes the fetched token through the spawned process environment", async () => {
    const spawnBru = vi.fn(async (_args: readonly string[], env: NodeJS.ProcessEnv) => {
      expect(env["SAPTOOLS_ACCESS_TOKEN"]).toBe("process-token");
      return { code: 0, stdout: "ok", stderr: "" };
    });

    await runBruno({
      root,
      target: "ap10/o/dev/app1",
      getTokenCached: async () => "process-token",
      spawnBru,
    });

    expect(spawnBru).toHaveBeenCalledOnce();
  });

  it("persists the fetched access token into the selected env file", async () => {
    const envFile = join(root, "region__ap10", "org__o", "space__dev", "app1", "environments", "local.bru");

    await buildRunPlan({
      root,
      target: "ap10/o/dev/app1",
      getTokenCached: async () => "persist-me",
    });

    const raw = await readFile(envFile, "utf8");
    const parsed = parseBruEnvFile(raw);
    expect(parsed.vars.entries.get("accessToken")).toBe("persist-me");
  });

  it("updates the stored access token when a later run receives a newer token", async () => {
    const envFile = join(root, "region__ap10", "org__o", "space__dev", "app1", "environments", "local.bru");

    await buildRunPlan({
      root,
      target: "ap10/o/dev/app1",
      getTokenCached: async () => "old-token",
    });
    await buildRunPlan({
      root,
      target: "ap10/o/dev/app1",
      getTokenCached: async () => "new-token",
    });

    const raw = await readFile(envFile, "utf8");
    const parsed = parseBruEnvFile(raw);
    expect(parsed.vars.entries.get("accessToken")).toBe("new-token");
  });

  it("prefers bru found on PATH", async () => {
    const runtime = await resolveBruRuntime(
      { PATH: "/tmp/fake-bin" },
      {
        findOnPath: async () => "/tmp/fake-bin/bru",
      },
    );
    expect(runtime).toEqual({
      command: "/tmp/fake-bin/bru",
      argsPrefix: [],
    });
  });

  it("falls back to bundled @usebruno/cli when PATH does not contain bru", async () => {
    const runtime = await resolveBruRuntime(
      { PATH: "" },
      {
        findOnPath: async () => undefined,
        resolvePackageJsonPath: () => "/opt/bruno/node_modules/@usebruno/cli/package.json",
        readTextFile: async () => JSON.stringify({ bin: { bru: "bin/bru.js" } }),
      },
    );
    expect(runtime).toEqual({
      command: process.execPath,
      argsPrefix: ["/opt/bruno/node_modules/@usebruno/cli/bin/bru.js"],
    });
  });

  it("supports bundled Bruno packages with a string bin field", async () => {
    const runtime = await resolveBruRuntime(
      { PATH: "" },
      {
        findOnPath: async () => undefined,
        resolvePackageJsonPath: () => "/opt/bruno/node_modules/@usebruno/cli/package.json",
        readTextFile: async () => JSON.stringify({ bin: "bin/bru.js" }),
      },
    );
    expect(runtime).toEqual({
      command: process.execPath,
      argsPrefix: ["/opt/bruno/node_modules/@usebruno/cli/bin/bru.js"],
    });
  });

  it("finds bru from the provided PATH entries", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "saptools-bruno-path-"));
    try {
      const bruPath = join(binDir, "bru");
      await writeFile(bruPath, "#!/usr/bin/env node\n", "utf8");
      await chmod(bruPath, 0o755);
      const runtime = await resolveBruRuntime({ PATH: binDir });
      expect(runtime).toEqual({ command: bruPath, argsPrefix: [] });
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("throws a helpful error when no bru runtime can be resolved", async () => {
    await expect(
      resolveBruRuntime(
        { PATH: "" },
        {
          findOnPath: async () => undefined,
          resolvePackageJsonPath: () => {
            throw new Error("missing");
          },
        },
      ),
    ).rejects.toThrow(/Unable to find Bruno CLI/);
  });

  it("throws the same runtime error when bundled package metadata has no bru bin", async () => {
    await expect(
      resolveBruRuntime(
        { PATH: "" },
        {
          findOnPath: async () => undefined,
          resolvePackageJsonPath: () => "/opt/bruno/node_modules/@usebruno/cli/package.json",
          readTextFile: async () => JSON.stringify({ bin: { other: "bin/other.js" } }),
        },
      ),
    ).rejects.toThrow(/Unable to find Bruno CLI/);
  });

  it("throws the same runtime error when bundled package metadata is invalid", async () => {
    await expect(
      resolveBruRuntime(
        { PATH: "" },
        {
          findOnPath: async () => undefined,
          resolvePackageJsonPath: () => "/opt/bruno/node_modules/@usebruno/cli/package.json",
          readTextFile: async () => "{",
        },
      ),
    ).rejects.toThrow(/Unable to find Bruno CLI/);
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

  it("resolves a direct relative path from the current working directory", async () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      const plan = await buildRunPlan({
        root,
        target: join("region__ap10", "org__o", "space__dev", "app1"),
        getTokenCached: async () => "t",
      });
      expect(plan.cwd.endsWith(join("region__ap10", "org__o", "space__dev", "app1"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
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

  it("throws when an app folder has no environment files", async () => {
    await mkdir(join(root, "region__ap10", "org__o", "space__dev", "empty-app"), { recursive: true });
    await expect(
      buildRunPlan({
        root,
        target: "ap10/o/dev/empty-app",
        getTokenCached: async () => "t",
      }),
    ).rejects.toThrow(/No environment files found/);
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

  it("throws when a direct file is not inside a CF-structured collection", async () => {
    const looseFile = join(root, "loose.bru");
    await writeFile(looseFile, "meta {\n  name: Loose\n}\n", "utf8");
    await expect(
      buildRunPlan({
        root,
        target: looseFile,
        getTokenCached: async () => "t",
      }),
    ).rejects.toThrow(/not inside a CF-structured bruno collection/);
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
