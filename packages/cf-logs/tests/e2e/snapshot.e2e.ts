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
                      "Retrieving logs for app demo-app in org sample-org / space sample as operator@example.test...",
                      "2026-04-12T09:14:40.00+0700 [APP/PROC/WEB/0] OUT credential-placeholder",
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

test("snapshot fetches parsed rows, persists full-fidelity store entry, and uses cf command sequence", async () => {
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
  expect(store.entries[0]?.rawText).toContain("credential-placeholder");
  expect(store.entries[0]?.rawText).toContain("operator@example.test");

  const logs = await readFakeLog(paths.logPath);
  expect(logs.map((entry) => entry.command)).toEqual(["api", "auth", "target", "logs"]);
});

test("snapshot emits full-fidelity text by default", async () => {
  const paths = await prepareCase(ROOT_NAME, "snapshot-full-fidelity-default", createScenario());
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
  ]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("operator@example.test");
  expect(result.stdout).toContain("credential-placeholder");
});

test("snapshot compact save emits refs and show returns the full row", async () => {
  const paths = await prepareCase(ROOT_NAME, "snapshot-compact-show", createScenario());
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
    "--compact",
    "--json",
    "--save",
  ]);

  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly rows: readonly { readonly ref?: string; readonly message?: string }[];
  };
  const ref = payload.rows[0]?.ref;
  expect(ref).toBeDefined();
  expect(payload.rows[0]?.message).toContain("credential-placeholder");

  const show = await runCli(env, ["show", ref ?? "", "--json"]);
  expect(show.code).toBe(0);
  const full = JSON.parse(show.stdout) as {
    readonly row: { readonly rawBody: string; readonly message: string };
  };
  expect(full.row.rawBody).toContain("credential-placeholder");

  const sessionId = ref?.split(":")[0] ?? "";
  const sessions = await runCli(env, ["session", "list"]);
  expect(sessions.code).toBe(0);
  expect(sessions.stdout).toContain(sessionId);
  expect(sessions.stdout).toContain("rows=2");

  const invalid = await runCli(env, ["show", "bad-ref"]);
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain("Invalid log row ref.");

  const cleared = await runCli(env, ["session", "clear"]);
  expect(cleared.code).toBe(0);
  expect(cleared.stdout).toContain("Cleared 1 session(s)");

  const expired = await runCli(env, ["show", ref ?? "", "--json"]);
  expect(expired.code).toBe(1);
  expect(expired.stderr).toContain("Saved log row not found or expired.");
});
