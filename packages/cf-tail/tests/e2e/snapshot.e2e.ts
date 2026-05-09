import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { createEnv, prepareCase, readFakeLog, readJsonFile, runCli, type Scenario } from "./helpers.js";

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
                      "Retrieving logs for app demo-app in org sample-org / space sample as sample@example.com...",
                      "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT sample-password",
                      '2026-04-12T09:14:42.00+0700 [APP/PROC/WEB/0] OUT {"level":"error","logger":"samplelogger","timestamp":"2026-04-12T02:14:42.000Z","msg":"save failed","type":"log"}',
                    ].join("\n"),
                  },
                  {
                    name: "api-app",
                    processes: "web:1/1",
                    recentLogs: [
                      "Retrieving logs for app api-app in org sample-org / space sample as sample@example.com...",
                      "2026-04-12T09:14:41.00+0700 [APP/PROC/WEB/0] OUT api ready",
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

test("snapshot fetches all apps in parallel, merges by timestamp, and redacts secrets", async () => {
  const paths = await prepareCase(ROOT_NAME, "snapshot-merged", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "snapshot",
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
    readonly appCount: number;
    readonly rowCount: number;
    readonly apps: readonly { readonly appName: string }[];
    readonly rows: readonly {
      readonly appName: string;
      readonly timestampRaw: string;
      readonly level: string;
    }[];
  };
  expect(payload.appCount).toBe(2);
  expect(payload.apps.map((app) => app.appName)).toEqual(["api-app", "demo-app"]);
  const orderedAppNames = payload.rows.map((row) => row.appName);
  const demoIndex = orderedAppNames.indexOf("demo-app");
  const apiIndex = orderedAppNames.indexOf("api-app");
  expect(demoIndex).toBeGreaterThanOrEqual(0);
  expect(apiIndex).toBeGreaterThanOrEqual(0);
  expect(apiIndex).toBeLessThan(orderedAppNames.lastIndexOf("demo-app"));
  expect(JSON.stringify(payload)).not.toContain("sample-password");
  expect(JSON.stringify(payload)).not.toContain("sample@example.com");

  const logs = await readFakeLog(paths.logPath);
  const commands = logs.map((entry) => entry.command);
  expect(commands.filter((command) => command === "logs")).toHaveLength(2);
});

test("snapshot --apps filters which apps are fetched and persists --save", async () => {
  const paths = await prepareCase(ROOT_NAME, "snapshot-filter-save", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "snapshot",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--apps",
    "demo-app",
    "--json",
    "--save",
  ]);

  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout) as { readonly appCount: number; readonly rowCount: number };
  expect(payload.appCount).toBe(1);

  const tailStore = await readJsonFile<{
    readonly entries: readonly { readonly apps: readonly { readonly appName: string }[] }[];
  }>(join(paths.homeDir, ".saptools", "cf-tail-store.json"));
  expect(tailStore.entries).toHaveLength(1);
  expect(tailStore.entries[0]?.apps.map((app) => app.appName)).toEqual(["demo-app"]);

  const logsStore = await readJsonFile<{
    readonly entries: readonly { readonly key: { readonly app: string }; readonly rawText: string }[];
  }>(join(paths.homeDir, ".saptools", "cf-logs-store.json"));
  expect(logsStore.entries).toHaveLength(1);
  expect(logsStore.entries[0]?.key.app).toBe("demo-app");
  expect(logsStore.entries[0]?.rawText).not.toContain("sample-password");
});

test("snapshot --level error keeps only error rows", async () => {
  const paths = await prepareCase(ROOT_NAME, "snapshot-errors", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "snapshot",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--level",
    "error",
    "--json",
  ]);

  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly rows: readonly { readonly level: string; readonly appName: string }[];
  };
  expect(payload.rows).toHaveLength(1);
  expect(payload.rows[0]?.level).toBe("error");
  expect(payload.rows[0]?.appName).toBe("demo-app");
});

test("snapshot --extra-secret redacts custom values in addition to credentials", async () => {
  const scenario: Scenario = {
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
                      "2026-04-12T09:14:43.00+0700 [APP/PROC/WEB/0] OUT bearer=tokABCDEF",
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
  const paths = await prepareCase(ROOT_NAME, "snapshot-extra-secret", scenario);
  const env = createEnv(paths);

  const result = await runCli(env, [
    "snapshot",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--extra-secret",
    "tokABCDEF",
    "--json",
  ]);

  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("tokABCDEF");
  expect(result.stdout).toContain("***");
});
