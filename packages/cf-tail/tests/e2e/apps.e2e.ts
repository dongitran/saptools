import { expect, test } from "@playwright/test";

import { createEnv, prepareCase, runCli, type Scenario } from "./helpers.js";

const ROOT_NAME = "cf-tail-e2e";

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
                  { name: "demo-app", processes: "web:1/1" },
                  { name: "api-app", processes: "web:2/2" },
                  { name: "broken-app", requestedState: "stopped", instances: "0/1", processes: "web:0/1" },
                  { name: "demo-canary", processes: "web:1/1" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

test("apps lists started apps and respects include-regex / exclude", async () => {
  const paths = await prepareCase(ROOT_NAME, "apps-filter", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "apps",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--include-regex",
    "^demo-",
    "--exclude",
    "demo-canary",
    "--json",
  ]);

  expect(result.code).toBe(0);
  const apps = JSON.parse(result.stdout) as readonly { readonly name: string }[];
  expect(apps.map((app) => app.name)).toEqual(["demo-app"]);
});

test("apps without filters returns every started app", async () => {
  const paths = await prepareCase(ROOT_NAME, "apps-all", createScenario());
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
  const apps = JSON.parse(result.stdout) as readonly { readonly name: string }[];
  expect(apps.map((app) => app.name)).toEqual(["api-app", "demo-app", "demo-canary"]);
});
