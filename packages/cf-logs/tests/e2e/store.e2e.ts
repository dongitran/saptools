import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  createEnv,
  prepareCase,
  readJsonFile,
  runCli,
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
