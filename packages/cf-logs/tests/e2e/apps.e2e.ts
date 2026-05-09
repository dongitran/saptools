import { expect, test } from "@playwright/test";

import { createEnv, prepareCase, runCli, type Scenario } from "./helpers.js";

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
                  { name: "demo-api", runningInstances: 2 },
                  { name: "demo-worker", runningInstances: 1 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

test("apps lists running apps as plain text by default", async () => {
  const paths = await prepareCase(ROOT_NAME, "apps-text", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "apps",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
  ]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("demo-api");
  expect(result.stdout).toContain("demo-worker");
});

test("apps --json returns structured app list with running instance counts", async () => {
  const paths = await prepareCase(ROOT_NAME, "apps-json", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "apps",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--json",
  ]);

  expect(result.code).toBe(0);
  const apps = JSON.parse(result.stdout) as readonly {
    readonly name: string;
    readonly runningInstances: number;
  }[];
  expect(apps).toEqual([
    { name: "demo-api", runningInstances: 2 },
    { name: "demo-worker", runningInstances: 1 },
  ]);
});
