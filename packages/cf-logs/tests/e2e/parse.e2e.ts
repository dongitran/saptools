import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { createEnv, prepareCase, runCli, type Scenario } from "./helpers.js";

const ROOT_NAME = "cf-logs-e2e";

const EMPTY_SCENARIO: Scenario = { regions: [] };

test("parse reads a local file and returns structured rows", async () => {
  const paths = await prepareCase(ROOT_NAME, "parse-file", EMPTY_SCENARIO);
  const env = createEnv(paths);
  const inputPath = join(paths.workDir, "sample.log");
  await writeFile(
    inputPath,
    [
      "Retrieving logs for app demo-app in org sample-org / space sample as sample@example.com...",
      '2026-04-12T09:14:41.00+0700 [APP/PROC/WEB/0] OUT {"level":"error","logger":"samplelogger","timestamp":"2026-04-12T02:14:41.000Z","msg":"save failed","type":"log"}',
      "2026-04-12T09:14:42.00+0700 [APP/PROC/WEB/0] OUT Request started",
      "Error: sample failure",
    ].join("\n"),
    "utf8",
  );

  const result = await runCli(env, ["parse", "--input", inputPath]);

  expect(result.code).toBe(0);
  const rows = JSON.parse(result.stdout) as readonly {
    readonly level: string;
    readonly message: string;
  }[];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.level).toBe("error");
  expect(rows[1]?.message).toContain("Request started\nError: sample failure");
});
