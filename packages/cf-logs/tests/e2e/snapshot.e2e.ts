import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  createEnv,
  prepareCase,
  readFakeLog,
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
                      "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT sample-password",
                      '2026-04-12T09:14:41.00+0700 [APP/PROC/WEB/0] OUT {"level":"error","logger":"samplelogger","timestamp":"2026-04-12T02:14:41.000Z","msg":"save failed","type":"log"}',
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

test("snapshot fetches parsed rows, persists a redacted store entry, and uses cf command sequence", async () => {
  const paths = await prepareCase(ROOT_NAME, "snapshot-json", createScenario());
  const env = createEnv(paths);

  const result = await runCli(env, [
    "snapshot",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--app",
    "demo-app",
    "--json",
    "--save",
  ]);

  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly appName: string;
    readonly rows: readonly { readonly level: string; readonly message: string }[];
  };
  expect(payload.appName).toBe("demo-app");
  expect(payload.rows).toHaveLength(2);
  expect(payload.rows[1]?.level).toBe("error");

  const store = await readJsonFile<{
    readonly entries: readonly { readonly rawText: string }[];
  }>(join(paths.homeDir, ".saptools", "cf-logs-store.json"));
  expect(store.entries).toHaveLength(1);
  expect(store.entries[0]?.rawText).not.toContain("sample-password");
  expect(store.entries[0]?.rawText).not.toContain("sample@example.com");

  const logs = await readFakeLog(paths.logPath);
  expect(logs.map((entry) => entry.command)).toEqual(["api", "auth", "target", "logs"]);
});
