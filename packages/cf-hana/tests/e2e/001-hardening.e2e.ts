import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  fakeTracePath,
  readBackupFiles,
  readFakeTraceEntries,
  runCli,
  setupFakeCfBin,
} from "./helpers.js";

const SELECTOR = "eu10/example-org/space-demo/app-demo";

let home: string;
let fakeBinDir: string;

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cf-hana-hardening-e2e-"));
  fakeBinDir = await setupFakeCfBin(home);
});

test.afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fakeEnv(failStatement?: "select" | "dml"): Record<string, string> {
  return {
    HOME: home,
    CF_HANA_DRIVER: "fake",
    CF_HANA_FAKE_TRACE_FILE: fakeTracePath(home),
    PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
    SAP_EMAIL: "user@example.com",
    SAP_PASSWORD: "secret",
    ...(failStatement === undefined
      ? {}
      : { CF_HANA_FAKE_FAIL_STATEMENT: failStatement }),
  };
}

test("User can back up REPLACE rows before the write runs", async () => {
  const sql = "REPLACE ORDERS VALUES (?, ?) WHERE ID = ?";
  const result = await runCli(
    ["query", SELECTOR, sql, "--param", "7", "--param", "DONE", "--param", "7"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("backup saved to");
  expect(await readFakeTraceEntries(home)).toEqual([
    { sql: "SELECT * FROM ORDERS WHERE ID = ?", paramCount: 1 },
    { sql, paramCount: 3 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([
    expect.objectContaining({ statement: `${sql}\n` }),
  ]);
});

test("User can back up matched MERGE rows before the write runs", async () => {
  const sql =
    "MERGE INTO ORDERS target USING SOURCE_ROWS source ON target.ID = source.ID " +
    "WHEN MATCHED THEN UPDATE SET target.STATUS = source.STATUS";
  const selectSql =
    "SELECT target.* FROM ORDERS target " +
    "WHERE EXISTS (SELECT 1 FROM SOURCE_ROWS source WHERE (target.ID = source.ID))";
  const result = await runCli(["query", SELECTOR, sql], fakeEnv());

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("backup saved to");
  expect(await readFakeTraceEntries(home)).toEqual([
    { sql: selectSql, paramCount: 0 },
    { sql, paramCount: 0 },
  ]);
});

test("User cannot override refusal of an unbackable MERGE", async () => {
  const sql =
    "MERGE INTO (SELECT * FROM ORDERS) target USING SOURCE_ROWS source " +
    "ON target.ID = source.ID WHEN MATCHED THEN DELETE";
  const result = await runCli(
    ["query", SELECTOR, sql, "--allow-destructive"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("trustworthy backup target");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User cannot run MERGE when its backup SELECT fails", async () => {
  const sql =
    "MERGE INTO ORDERS target USING SOURCE_ROWS source ON target.ID = source.ID " +
    "WHEN MATCHED THEN UPDATE SET target.STATUS = source.STATUS";
  const result = await runCli(["query", SELECTOR, sql], fakeEnv("select"));

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("fake driver forced SELECT failure");
  const trace = await readFakeTraceEntries(home);
  expect(trace).toHaveLength(1);
  expect(trace[0]?.sql).toContain("SELECT target.* FROM ORDERS target");
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});
