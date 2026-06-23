import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  fakeTracePath,
  readBackupFiles,
  readFakeTraceEntries,
  readHistoryEntries,
  runCli,
  seedCredentialsCache,
} from "./helpers.js";

const SELECTOR = "eu10/example-org/space-demo/app-demo";
const BACKUP_CSV = "ID,NAME\r\n1,sample-row\r\n2,second-row";
const COMPLEX_UPDATE_SQL = [
  "/* complex update coverage */",
  'UPDATE "ORDER SET" AS O',
  "SET NOTE = ?,",
  '    TOTAL = (SELECT COUNT(*) FROM "ITEM WHERE" I WHERE I.ORDER_ID = O.ID AND I.STATE = ?),',
  "    LABEL = 'where SET' /* WHERE ignored */",
  'WHERE O."ID" = ? AND O.STATUS IN (?, ?);',
].join("\n");
const COMPLEX_UPDATE_SELECT =
  'SELECT * FROM "ORDER SET" AS O WHERE O."ID" = ? AND O.STATUS IN (?, ?)';
const COMPLEX_DELETE_SQL = [
  "/* complex delete coverage */",
  'DELETE FROM "APP_SCHEMA"."ORDER WHERE"',
  'WHERE "STATUS" = ?',
  '  AND "ID" IN (',
  '    SELECT "ORDER_ID" FROM "ORDER ITEMS" WHERE "TYPE" = ?',
  "  )",
  "  AND \"NOTE\" <> 'delete from where' /* WHERE ignored */;",
].join("\n");
const COMPLEX_DELETE_SELECT = [
  'SELECT * FROM "APP_SCHEMA"."ORDER WHERE" WHERE "STATUS" = ?',
  '  AND "ID" IN (',
  '    SELECT "ORDER_ID" FROM "ORDER ITEMS" WHERE "TYPE" = ?',
  "  )",
  "  AND \"NOTE\" <> 'delete from where' /* WHERE ignored */",
].join("\n");

let home: string;

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cf-hana-e2e-"));
  await seedCredentialsCache(home);
});

test.afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fakeEnv(trace = false): Record<string, string> {
  return {
    HOME: home,
    CF_HANA_DRIVER: "fake",
    ...(trace ? { CF_HANA_FAKE_TRACE_FILE: fakeTracePath(home) } : {}),
  };
}

test("User can view help that lists the commands", async () => {
  const result = await runCli(["--help"], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("query");
  expect(result.stdout).toContain("tables");
});

test("User can view the version", async () => {
  const result = await runCli(["--version"], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("0.1.5");
});

test("User can inspect resolved connection metadata", async () => {
  const result = await runCli(["info", SELECTOR], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("APP_SCHEMA");
  expect(result.stdout).toContain("app-demo");
});

test("User can run a query and print a table", async () => {
  const result = await runCli(["query", SELECTOR, "SELECT 1 FROM DUMMY"], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("1");
});

test("User can request JSON output", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT 1 FROM DUMMY", "--format", "json"],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([{ "1": 1 }]);
});

test("User can run a query and keep local SQL history", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      "SELECT * FROM ORDERS WHERE STATUS = ?",
      "--param",
      "hidden-parameter-value",
      "--format",
      "json",
    ],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(0);

  const history = await readHistoryEntries(home);
  expect(history).toEqual([
    expect.objectContaining({
      selector: SELECTOR,
      appName: "app-demo",
      schema: "APP_SCHEMA",
      operation: "query",
      statement: "select",
      sql: "SELECT * FROM ORDERS WHERE STATUS = ?",
      paramCount: 1,
    }),
  ]);
  expect(JSON.stringify(history)).not.toContain("hidden-parameter-value");
});

test("User can back up rows before an UPDATE runs", async () => {
  const sql = "UPDATE ORDERS SET STATUS = ? WHERE ID = ?";
  const result = await runCli(
    ["query", SELECTOR, sql, "--param", "DONE", "--param", "7", "--format", "json"],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(result.stderr).toContain("backup saved to");

  await expect(readBackupFiles(home)).resolves.toEqual([
    {
      statement: `${sql}\n`,
      csv: BACKUP_CSV,
    },
  ]);
});

test("User can back up rows for a complex UPDATE before the write runs", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      COMPLEX_UPDATE_SQL,
      "--param",
      "updated-note",
      "--param",
      "OPEN",
      "--param",
      "7",
      "--param",
      "READY",
      "--param",
      "PENDING",
      "--format",
      "json",
    ],
    fakeEnv(true),
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(result.stderr).toContain("backup saved to");
  const trace = await readFakeTraceEntries(home);
  expect(trace).toEqual([
    { sql: COMPLEX_UPDATE_SELECT, paramCount: 3 },
    { sql: COMPLEX_UPDATE_SQL, paramCount: 5 },
  ]);
  expect(JSON.stringify(trace)).not.toContain("updated-note");
  await expect(readBackupFiles(home)).resolves.toEqual([
    { statement: `${COMPLEX_UPDATE_SQL.slice(0, -1)}\n`, csv: BACKUP_CSV },
  ]);
});

test("User can back up rows for a complex DELETE before the write runs", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      COMPLEX_DELETE_SQL,
      "--param",
      "OPEN",
      "--param",
      "STANDARD",
      "--format",
      "json",
    ],
    fakeEnv(true),
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(result.stderr).toContain("backup saved to");
  expect(await readFakeTraceEntries(home)).toEqual([
    { sql: COMPLEX_DELETE_SELECT, paramCount: 2 },
    { sql: COMPLEX_DELETE_SQL, paramCount: 2 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([
    { statement: `${COMPLEX_DELETE_SQL.slice(0, -1)}\n`, csv: BACKUP_CSV },
  ]);
});

test("User can back up all rows before an explicitly allowed unscoped UPDATE", async () => {
  const sql = "UPDATE ORDERS SET STATUS = ?";
  const result = await runCli(
    [
      "query",
      SELECTOR,
      sql,
      "--param",
      "ARCHIVED",
      "--allow-destructive",
      "--format",
      "json",
    ],
    fakeEnv(true),
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(result.stderr).toContain("backup saved to");
  expect(await readFakeTraceEntries(home)).toEqual([
    { sql: "SELECT * FROM ORDERS", paramCount: 0 },
    { sql, paramCount: 1 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([
    { statement: `${sql}\n`, csv: BACKUP_CSV },
  ]);
});

test("User cannot run an unscoped DELETE before explicit approval", async () => {
  const result = await runCli(
    ["query", SELECTOR, "DELETE FROM ORDERS", "--format", "json"],
    fakeEnv(true),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("destructive statement blocked");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User can back up all rows before an explicitly allowed unscoped DELETE", async () => {
  const sql = "DELETE FROM ORDERS";
  const result = await runCli(
    [
      "query",
      SELECTOR,
      sql,
      "--allow-destructive",
      "--format",
      "json",
    ],
    fakeEnv(true),
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(result.stderr).toContain("backup saved to");
  expect(await readFakeTraceEntries(home)).toEqual([
    { sql: "SELECT * FROM ORDERS", paramCount: 0 },
    { sql, paramCount: 0 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([
    { statement: `${sql}\n`, csv: BACKUP_CSV },
  ]);
});

test("User can see a clear failure for the removed backup opt-out", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      "UPDATE ORDERS SET STATUS = ? WHERE ID = ?",
      "--param",
      "DONE",
      "--param",
      "7",
      "--format",
      "json",
      "--no-backup",
    ],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("unknown option '--no-backup'");
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User can ping the database", async () => {
  const result = await runCli(["ping", SELECTOR], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("OK");
});

test("User can see a clear failure for an uncached app", async () => {
  const result = await runCli(["info", "definitely-missing-app"], fakeEnv());
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("cf-hana");
});

test("User can see a clear failure for a non-integer limit", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT 1 FROM DUMMY", "--limit", "10abc"],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Expected an integer");
});

test("User can see a clear failure for a non-positive timeout", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT 1 FROM DUMMY", "--timeout", "0"],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("positive integer");
});
