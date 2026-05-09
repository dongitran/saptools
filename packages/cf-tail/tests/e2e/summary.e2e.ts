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
                  {
                    name: "demo-app",
                    processes: "web:1/1",
                    recentLogs: [
                      "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT ready",
                      '2026-04-12T09:14:41.00+0700 [APP/PROC/WEB/0] OUT {"level":"error","msg":"save failed"}',
                      '2026-04-12T09:14:42.00+0700 [APP/PROC/WEB/0] OUT {"level":"warn","msg":"slow"}',
                    ].join("\n"),
                  },
                  {
                    name: "api-app",
                    processes: "web:1/1",
                    recentLogs: [
                      "2026-04-12T09:14:43.00+0700 [APP/PROC/WEB/0] OUT api ready",
                      '2026-04-12T09:14:44.00+0700 [APP/PROC/WEB/0] OUT {"level":"info","msg":"req ok"}',
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

test("summary aggregates levels per app", async () => {
  const paths = await prepareCase(ROOT_NAME, "summary-json", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "summary",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--json",
  ]);

  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly summary: {
      readonly total: number;
      readonly apps: readonly {
        readonly appName: string;
        readonly total: number;
        readonly levels: { readonly error: number; readonly warn: number; readonly info: number };
      }[];
    };
  };
  expect(payload.summary.total).toBeGreaterThanOrEqual(5);
  const demo = payload.summary.apps.find((app) => app.appName === "demo-app");
  expect(demo?.levels.error).toBe(1);
  expect(demo?.levels.warn).toBe(1);
  const api = payload.summary.apps.find((app) => app.appName === "api-app");
  expect(api?.levels.info).toBeGreaterThanOrEqual(1);
});
