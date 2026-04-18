import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import type { CfStructure, RuntimeSyncState } from "../../src/types.js";

import {
  CLI_PATH,
  FAKE_CF_BIN,
  type Scenario,
  createEnv,
  prepareCase,
  readJson,
  waitForExit,
  writeJson,
} from "./helpers.js";

const execFileAsync = promisify(execFile);

const ROOT_NAME = "cf-sync-failures-e2e";

async function findDeadPid(): Promise<number> {
  const zombie = spawn("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolveExit) => {
    zombie.once("close", () => {
      resolveExit();
    });
  });
  const pid = zombie.pid;
  if (pid === undefined) {
    throw new Error("Failed to capture zombie PID");
  }

  try {
    process.kill(pid, 0);
    throw new Error(`PID ${pid.toString()} is unexpectedly still alive`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return pid;
    }
    throw err;
  }
}

test.describe("Failure & recovery paths", () => {
  test.beforeAll(() => {
    expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
    expect(existsSync(FAKE_CF_BIN), `Fake CF fixture must exist at ${FAKE_CF_BIN}`).toBe(true);
  });

  test("sync surfaces region.error when orgs lookup fails mid-walk", async () => {
    const scenario: Scenario = {
      regions: [
        {
          key: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          orgsError: "orgs endpoint exploded",
          orgs: [],
        },
        {
          key: "eu10",
          apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
          orgs: [{ name: "org-eu10", spaces: [{ name: "dev", apps: ["app-eu10"] }] }],
        },
      ],
    };
    const paths = await prepareCase(ROOT_NAME, "region-orgs-error", scenario);
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const child = spawn("node", [CLI_PATH, "sync", "--only", "ap10,eu10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await waitForExit(child);
    expect(result.code, `stderr was: ${result.stderr}`).toBe(0);

    const structure = await readJson<CfStructure>(paths.structurePath);
    const ap10 = structure.regions.find((region) => region.key === "ap10");
    const eu10 = structure.regions.find((region) => region.key === "eu10");

    expect(ap10).toBeDefined();
    expect(ap10?.accessible).toBe(true);
    expect(ap10?.orgs).toEqual([]);
    expect(ap10?.error).toContain("orgs endpoint exploded");

    expect(eu10).toBeDefined();
    expect(eu10?.accessible).toBe(true);
    expect(eu10?.orgs.map((org) => org.name)).toEqual(["org-eu10"]);
    expect(eu10?.error).toBeUndefined();
  });

  test("sync surfaces org.error when spaces lookup fails mid-walk", async () => {
    const scenario: Scenario = {
      regions: [
        {
          key: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          orgs: [
            {
              name: "broken-org",
              spacesError: "spaces 500",
              spaces: [],
            },
            {
              name: "good-org",
              spaces: [{ name: "dev", apps: ["app"] }],
            },
          ],
        },
      ],
    };
    const paths = await prepareCase(ROOT_NAME, "org-spaces-error", scenario);
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const child = spawn("node", [CLI_PATH, "sync", "--only", "ap10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await waitForExit(child);
    expect(result.code, `stderr was: ${result.stderr}`).toBe(0);

    const structure = await readJson<CfStructure>(paths.structurePath);
    const ap10 = structure.regions[0];
    expect(ap10?.orgs.map((org) => org.name)).toEqual(["broken-org", "good-org"]);
    expect(ap10?.orgs[0]?.error).toContain("spaces 500");
    expect(ap10?.orgs[0]?.spaces).toEqual([]);
    expect(ap10?.orgs[1]?.error).toBeUndefined();
    expect(ap10?.orgs[1]?.spaces.map((space) => space.name)).toEqual(["dev"]);
  });

  test("sync recovers from a stale lock left by a crashed sync on the same host", async () => {
    const scenario: Scenario = {
      regions: [
        {
          key: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          orgs: [{ name: "org-ap10", spaces: [{ name: "dev", apps: ["app-ap10"] }] }],
        },
      ],
    };
    const paths = await prepareCase(ROOT_NAME, "stale-lock-recovery", scenario);
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const deadPid = await findDeadPid();
    const staleLockContent = {
      syncId: "crashed-sync",
      pid: deadPid,
      hostname: getHostname(),
      startedAt: "2026-04-18T00:00:00.000Z",
    };
    await mkdir(dirname(paths.syncLockPath), { recursive: true });
    await writeFile(paths.syncLockPath, `${JSON.stringify(staleLockContent)}\n`, "utf8");

    const staleRuntime: RuntimeSyncState = {
      syncId: "crashed-sync",
      status: "running",
      startedAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:00.000Z",
      requestedRegionKeys: ["ap10"],
      completedRegionKeys: [],
      structure: {
        syncedAt: "2026-04-18T00:00:00.000Z",
        regions: [],
      },
    };
    await writeJson(paths.runtimeStatePath, staleRuntime);

    const child = spawn("node", [CLI_PATH, "sync", "--only", "ap10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await waitForExit(child);
    expect(result.code, `stderr was: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Structure written to");

    const structure = await readJson<CfStructure>(paths.structurePath);
    expect(structure.regions.map((region) => region.key)).toEqual(["ap10"]);
    expect(structure.regions[0]?.orgs.map((org) => org.name)).toEqual(["org-ap10"]);

    const runtime = await readJson<RuntimeSyncState>(paths.runtimeStatePath);
    expect(runtime.status).toBe("completed");
    expect(runtime.syncId).not.toBe("crashed-sync");
  });

  test("sync --only rejects unknown region keys with a non-zero exit", async () => {
    const paths = await prepareCase(ROOT_NAME, "invalid-only-unknown", {
      regions: [
        {
          key: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          orgs: [],
        },
      ],
    });
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const child = spawn("node", [CLI_PATH, "sync", "--only", "ap10,bogus-region"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await waitForExit(child);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown region key(s)");
    expect(result.stderr).toContain("bogus-region");
    expect(existsSync(paths.runtimeStatePath)).toBe(false);
    expect(existsSync(paths.structurePath)).toBe(false);
    expect(existsSync(paths.logPath)).toBe(false);
  });

  test("sync --only rejects an empty region list", async () => {
    const paths = await prepareCase(ROOT_NAME, "invalid-only-empty", { regions: [] });
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const child = spawn("node", [CLI_PATH, "sync", "--only", ", , "], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await waitForExit(child);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--only must list at least one region key");
  });

  test("region command rejects an unknown region key", async () => {
    const paths = await prepareCase(ROOT_NAME, "invalid-region-key", { regions: [] });
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    try {
      await execFileAsync("node", [CLI_PATH, "region", "not-a-region"], {
        env,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15_000,
      });
      throw new Error("Expected region command to exit non-zero");
    } catch (err) {
      const execError = err as NodeJS.ErrnoException & {
        readonly code?: number;
        readonly stderr?: string;
      };
      expect(execError.code).not.toBe(0);
      expect(execError.stderr ?? "").toContain("Unknown region key");
    }
  });
});
