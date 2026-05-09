import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  CLI_PATH,
  createEnv,
  makeSymlink,
  prepareCase,
  readJsonFile,
  runCli,
  runCliAt,
  type Scenario,
} from "./helpers.js";

const ROOT_NAME = "cf-logs-e2e";

function createScenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgs: [
          {
            name: "sample-org",
            spaces: [
              {
                name: "sample",
                apps: [
                  {
                    name: "demo-app",
                    recentLogs: [
                      "Retrieving logs for app demo-app in org sample-org / space sample as sample@example.com...",
                      "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT sample ready",
                    ].join("\n"),
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

test("store clear empties cached entries persisted by snapshot --save", async () => {
  const paths = await prepareCase(ROOT_NAME, "store-clear", createScenario());
  const env = createEnv(paths);
  const storePath = join(paths.homeDir, ".saptools", "cf-logs-store.json");

  const seed = await runCli(env, [
    "snapshot",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--app",
    "demo-app",
    "--save",
  ]);
  expect(seed.code).toBe(0);

  const seeded = await readJsonFile<{ readonly entries: readonly unknown[] }>(storePath);
  expect(seeded.entries.length).toBeGreaterThan(0);

  const cleared = await runCli(env, ["store", "clear"]);
  expect(cleared.code).toBe(0);
  expect(cleared.stdout).toContain("Cleared");

  const after = await readJsonFile<{ readonly entries: readonly unknown[] }>(storePath);
  expect(after.entries).toEqual([]);
});

test("--version prints the package semantic version", async () => {
  const paths = await prepareCase(ROOT_NAME, "version-flag", { regions: [] });
  const env = createEnv(paths);

  const result = await runCli(env, ["--version"]);

  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
});

test("CLI works correctly when invoked through a symlink (isMainModule symlink resolution)", async () => {
  const paths = await prepareCase(ROOT_NAME, "symlink-invoke", { regions: [] });
  const env = createEnv(paths);
  const symlinkPath = await makeSymlink(CLI_PATH, paths.workDir, "cf-logs-link");

  const result = await runCliAt(symlinkPath, env, ["--version"]);

  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
});

test("store list shows entries after snapshot --save and prints empty when clear", async () => {
  const paths = await prepareCase(ROOT_NAME, "store-list", createScenario());
  const env = createEnv(paths);

  const listEmpty = await runCli(env, ["store", "list"]);
  expect(listEmpty.code).toBe(0);
  expect(listEmpty.stdout.trim()).toBe("(empty)");

  await runCli(env, [
    "snapshot",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--app",
    "demo-app",
    "--save",
  ]);

  const listText = await runCli(env, ["store", "list"]);
  expect(listText.code).toBe(0);
  expect(listText.stdout).toContain("sample-org/sample/demo-app");

  const listJson = await runCli(env, ["store", "list", "--json"]);
  expect(listJson.code).toBe(0);
  const store = JSON.parse(listJson.stdout) as { readonly entries: readonly unknown[] };
  expect(store.entries).toHaveLength(1);
});

test("store path prints the log store file path", async () => {
  const paths = await prepareCase(ROOT_NAME, "store-path", { regions: [] });
  const env = createEnv(paths);

  const result = await runCli(env, ["store", "path"]);

  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toContain("cf-logs-store.json");
});
