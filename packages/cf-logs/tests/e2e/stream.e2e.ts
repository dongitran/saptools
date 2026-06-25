import { expect, test } from "@playwright/test";

import {
  createEnv,
  prepareCase,
  readFakeLog,
  runCli,
  runStreamCli,
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
                    stream: [
                      {
                        stdout:
                          "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT credential-placeholder\n",
                      },
                      {
                        stdout:
                          '2026-04-12T09:14:41.00+0700 [APP/PROC/WEB/0] OUT {"level":"error","logger":"samplelogger","timestamp":"2026-04-12T02:14:41.000Z","msg":"save failed","type":"log"}\n',
                        delayMs: 10,
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

test("stream outputs full-fidelity JSON line batches and stops after the configured line cap", async () => {
  const paths = await prepareCase(ROOT_NAME, "stream-json", createScenario());
  const env = createEnv(paths);

  const result = await runStreamCli(env, [
    "stream",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--app",
    "demo-app",
    "--json",
    "--max-lines",
    "2",
  ]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("credential-placeholder");
  const events = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly type: string; readonly lines?: readonly string[] });
  expect(events.some((event) => event.type === "state")).toBe(true);
  expect(events.some((event) => event.type === "lines")).toBe(true);

  const logs = await readFakeLog(paths.logPath);
  expect(logs.map((entry) => entry.command)).toEqual(["api", "auth", "target", "logs"]);
});

test("stream compact save emits row refs for full drill-down", async () => {
  const paths = await prepareCase(ROOT_NAME, "stream-compact-show", createScenario());
  const env = createEnv(paths);

  const result = await runStreamCli(env, [
    "stream",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--app",
    "demo-app",
    "--compact",
    "--json",
    "--save",
    "--max-lines",
    "1",
  ]);

  expect(result.code).toBe(0);
  const rowEvents = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as {
      readonly type: string;
      readonly rows?: readonly { readonly ref?: string; readonly message?: string }[];
    })
    .filter((event) => event.type === "rows");
  const compactRows = rowEvents.flatMap((event) => event.rows ?? []);
  expect(compactRows).toHaveLength(1);
  const firstRef = compactRows[0]?.ref;
  expect(firstRef).toBeDefined();

  const show = await runCli(env, ["show", firstRef ?? "", "--json"]);
  expect(show.code).toBe(0);
  const full = JSON.parse(show.stdout) as { readonly row: { readonly rawBody: string } };
  expect(full.row.rawBody).toContain("credential-placeholder");
});

test("stream compact search emits refs only for matching rows", async () => {
  const paths = await prepareCase(ROOT_NAME, "stream-compact-search", createScenario());
  const env = createEnv(paths);

  const result = await runStreamCli(env, [
    "stream",
    "--region",
    "ap10",
    "--org",
    "sample-org",
    "--space",
    "sample",
    "--app",
    "demo-app",
    "--compact",
    "--json",
    "--save",
    "--search",
    "SAVE",
    "--max-lines",
    "1",
  ]);

  expect(result.code).toBe(0);
  const rowEvents = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as {
      readonly type: string;
      readonly rows?: readonly { readonly ref?: string; readonly message?: string }[];
    })
    .filter((event) => event.type === "rows");
  const compactRows = rowEvents.flatMap((event) => event.rows ?? []);
  expect(compactRows).toHaveLength(1);
  expect(compactRows[0]?.message).toBe("save failed");
  expect(result.stdout).not.toContain("credential-placeholder");

  const ref = compactRows[0]?.ref;
  expect(ref).toBeDefined();
  const show = await runCli(env, ["show", ref ?? "", "--json"]);
  expect(show.code).toBe(0);
  const full = JSON.parse(show.stdout) as { readonly row: { readonly rawBody: string } };
  expect(full.row.rawBody).toContain("save failed");
});
