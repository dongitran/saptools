import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { CLI_PATH, type RunResult } from "./helpers.js";

const execFileAsync = promisify(execFile);

interface AppNode {
  readonly name: string;
}

interface SpaceNode {
  readonly name: string;
  readonly apps: readonly AppNode[];
  readonly error?: string;
}

interface OrgNode {
  readonly name: string;
  readonly spaces: readonly SpaceNode[];
  readonly error?: string;
}

interface RegionNode {
  readonly key: string;
  readonly accessible: boolean;
  readonly orgs: readonly OrgNode[];
  readonly error?: string;
}

interface CfStructure {
  readonly regions: readonly RegionNode[];
}

interface DiscoveredTarget {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

async function loadStructure(): Promise<CfStructure | null> {
  const path = join(homedir(), ".saptools", "cf-structure.json");
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as CfStructure;
  } catch {
    return null;
  }
}

function pickFirstApp(structure: CfStructure): DiscoveredTarget | null {
  for (const region of structure.regions) {
    if (!region.accessible) {
      continue;
    }
    for (const org of region.orgs) {
      if (org.error) {
        continue;
      }
      for (const space of org.spaces) {
        if (space.error) {
          continue;
        }
        for (const app of space.apps) {
          return {
            region: region.key,
            org: org.name,
            space: space.name,
            app: app.name,
          };
        }
      }
    }
  }
  return null;
}

async function runCliInherited(args: readonly string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], {
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
    };
  }
}

test.describe("live cf-files against real SAP BTP", () => {
  test.skip(
    !process.env["SAP_EMAIL"] || !process.env["SAP_PASSWORD"],
    "SAP_EMAIL and SAP_PASSWORD must be set to run live tests",
  );

  let target: DiscoveredTarget;
  let tempWorkDir: string;

  test.beforeAll(async () => {
    const structure = await loadStructure();
    if (!structure) {
      throw new Error(
        "Run `cf-sync sync` before the live suite: ~/.saptools/cf-structure.json is missing",
      );
    }
    const picked = pickFirstApp(structure);
    if (!picked) {
      throw new Error("No accessible app found in cf-structure.json");
    }
    target = picked;
    tempWorkDir = await mkdtemp(join(tmpdir(), "cf-files-live-"));
  });

  test.afterAll(async () => {
    if (tempWorkDir) {
      await rm(tempWorkDir, { recursive: true, force: true });
    }
  });

  test("gen-env produces a valid default-env.json", async () => {
    const outPath = join(tempWorkDir, "default-env.json");
    const result = await runCliInherited([
      "gen-env",
      "--region",
      target.region,
      "--org",
      target.org,
      "--space",
      target.space,
      "--app",
      target.app,
      "--out",
      outPath,
    ]);
    expect(result.code, result.stderr).toBe(0);
    const content = await readFile(outPath, "utf8");
    const parsed = JSON.parse(content) as { readonly VCAP_SERVICES: Record<string, unknown> };
    expect(typeof parsed.VCAP_SERVICES).toBe("object");
    expect(parsed.VCAP_SERVICES).not.toBeNull();
  });

  test("list returns at least one entry at the default app path", async () => {
    const result = await runCliInherited([
      "list",
      "--region",
      target.region,
      "--org",
      target.org,
      "--space",
      target.space,
      "--app",
      target.app,
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  test("download retrieves a file the container always has", async () => {
    const listResult = await runCliInherited([
      "list",
      "--region",
      target.region,
      "--org",
      target.org,
      "--space",
      target.space,
      "--app",
      target.app,
      "--json",
    ]);
    expect(listResult.code, listResult.stderr).toBe(0);
    const entries = JSON.parse(listResult.stdout) as {
      readonly name: string;
      readonly isDirectory: boolean;
    }[];
    const firstFile = entries.find((e) => !e.isDirectory);
    if (!firstFile) {
      test.skip(true, "No files found at default app path to download");
      return;
    }
    const outPath = join(tempWorkDir, `sample-${firstFile.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
    const result = await runCliInherited([
      "download",
      "--region",
      target.region,
      "--org",
      target.org,
      "--space",
      target.space,
      "--app",
      target.app,
      "--remote",
      firstFile.name,
      "--out",
      outPath,
    ]);
    expect(result.code, result.stderr).toBe(0);
    const body = await readFile(outPath);
    expect(body.byteLength).toBeGreaterThan(0);
  });
});
