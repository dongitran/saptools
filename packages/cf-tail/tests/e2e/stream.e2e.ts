import { expect, test } from "@playwright/test";

import { createEnv, prepareCase, runStreamCli, type Scenario } from "./helpers.js";

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
                    stream: [
                      {
                        stdout:
                          "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT sample-password\n",
                      },
                      {
                        stdout:
                          '2026-04-12T09:14:41.00+0700 [APP/PROC/WEB/0] OUT {"level":"error","msg":"save failed"}\n',
                        delayMs: 5,
                      },
                    ],
                  },
                  {
                    name: "api-app",
                    processes: "web:1/1",
                    stream: [
                      {
                        stdout: "2026-04-12T09:14:42.00+0700 [APP/PROC/WEB/0] OUT hello\n",
                      },
                    ],
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

test("stream multiplexes redacted ndjson rows from every app and stops at --max-lines", async () => {
  const paths = await prepareCase(ROOT_NAME, "stream-ndjson", createScenario());
  const env = createEnv(paths);

  const result = await runStreamCli(env, [
    "stream",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--ndjson",
    "--max-lines",
    "3",
    "--rediscover",
    "off",
    "--no-color",
  ]);

  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("sample-password");

  const events = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly type?: string; readonly appName?: string });
  const appNames = new Set(
    events
      .filter((event) => event.type === undefined && event.appName !== undefined)
      .map((event) => event.appName),
  );
  expect(appNames.size).toBeGreaterThanOrEqual(2);
});
