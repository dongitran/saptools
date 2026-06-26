import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  "/* complex update coverage ? */",
  'UpDaTe "ORDER? SET" AS O',
  "SeT NOTE = ?, -- ignored ? WHERE SET",
  '    TOTAL = (SELECT COUNT(*) FROM "ITEM? WHERE" I WHERE I.ORDER_ID = O.ID AND I.STATE = ?),',
  "    LABEL = 'literal ? where SET' /* ignored ? WHERE */",
  'wHeRe O."ID?" = ? AND O.STATUS IN (?, ?);',
].join("\n");
const COMPLEX_UPDATE_SELECT =
  'SELECT * FROM "ORDER? SET" AS O WHERE O."ID?" = ? AND O.STATUS IN (?, ?)';
const COMPLEX_DELETE_SQL = [
  "/* complex delete coverage ? */",
  'DeLeTe FrOm "APP_SCHEMA"."ORDER? WHERE"',
  'wHeRe "STATUS?" = ?',
  '  AND "ID" IN (',
  '    SeLeCt "ORDER_ID" FrOm "ORDER? ITEMS" WhErE "TYPE?" = ?',
  "  ) -- ignored ? WHERE DELETE",
  "  AND \"NOTE?\" <> 'literal ? delete from where' /* ignored ? WHERE */;",
].join("\n");
const COMPLEX_DELETE_SELECT = [
  'SELECT * FROM "APP_SCHEMA"."ORDER? WHERE" WHERE "STATUS?" = ?',
  '  AND "ID" IN (',
  '    SeLeCt "ORDER_ID" FrOm "ORDER? ITEMS" WhErE "TYPE?" = ?',
  "  ) -- ignored ? WHERE DELETE",
  "  AND \"NOTE?\" <> 'literal ? delete from where' /* ignored ? WHERE */",
].join("\n");

interface FakeEnvOptions {
  readonly trace?: boolean;
  readonly failStatement?: "select" | "dml";
}

let home: string;

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cf-hana-e2e-"));
  await seedCredentialsCache(home);
});

test.afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fakeEnv(options: FakeEnvOptions = {}): Record<string, string> {
  return {
    HOME: home,
    CF_HANA_DRIVER: "fake",
    ...(options.trace ? { CF_HANA_FAKE_TRACE_FILE: fakeTracePath(home) } : {}),
    ...(options.failStatement === undefined
      ? {}
      : { CF_HANA_FAKE_FAIL_STATEMENT: options.failStatement }),
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
  expect(result.stdout).toContain("0.2.1");
});

test("User can inspect resolved connection metadata", async () => {
  const result = await runCli(["info", SELECTOR], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("APP_SCHEMA");
  expect(result.stdout).toContain("app-demo");
});

test("User can run a query and print compact CSV", async () => {
  const result = await runCli(["query", SELECTOR, "SELECT 1 FROM DUMMY"], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("1\r\n1");
});

test("User sees a clear failure when requesting query format output", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT 1 FROM DUMMY", "--format", "json"],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("unknown option '--format'");
});

test("User can save a compact query and inspect it by ref", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--save", "--cell-limit", "6"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(0);
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  expect(lines[0]).toMatch(/^ref=q[0-9a-f]{8}$/);
  expect(lines[1]).toBe("ID,NAME");
  expect(lines[2]).toBe("1,sample");
  expect(result.stderr).toContain("saved result expires at");
  expect(result.stderr).toContain("compacted 2 cell(s)");

  const ref = lines[0]?.slice("ref=".length) ?? "";
  const cell = await runCli(
    ["result", "show", ref, "--row", "1", "--column", "NAME", "--length", "50"],
    fakeEnv(),
  );
  expect(cell.exitCode).toBe(0);
  expect(cell.stdout.trim()).toBe(
    "ROW,COLUMN,TYPE,ORIGINAL_LENGTH,OFFSET,VALUE\r\n1,NAME,text,10,0,sample-row",
  );

  const search = await runCli(["result", "search", ref, "SECOND"], fakeEnv());
  expect(search.exitCode).toBe(0);
  expect(search.stdout).toContain("2,NAME,0,,second-row");

  const missingColumn = await runCli(
    ["result", "show", ref, "--row", "1", "--path", "/items"],
    fakeEnv(),
  );
  expect(missingColumn.exitCode).toBe(1);
  expect(missingColumn.stderr).toContain("--path and --offset require --column");

  const list = await runCli(["result", "list"], fakeEnv());
  expect(list.exitCode).toBe(0);
  expect(list.stdout).toContain(ref);
});

test("User can run a query and keep local SQL history", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      "SELECT * FROM ORDERS WHERE STATUS = ?",
      "--param",
      "hidden-parameter-value",
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
    ["query", SELECTOR, sql, "--param", "DONE", "--param", "7"],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(1 row(s) affected)");
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
    ],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(1 row(s) affected)");
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
    ],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(1 row(s) affected)");
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
    ],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(1 row(s) affected)");
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
    ["query", SELECTOR, "DELETE FROM ORDERS"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("destructive statement blocked");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User can back up all rows before an explicitly allowed unscoped DELETE", async () => {
  const sql = "DELETE FROM ORDERS";
  const result = await runCli(
    ["query", SELECTOR, sql, "--allow-destructive"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(1 row(s) affected)");
  expect(result.stderr).toContain("backup saved to");
  expect(await readFakeTraceEntries(home)).toEqual([
    { sql: "SELECT * FROM ORDERS", paramCount: 0 },
    { sql, paramCount: 0 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([
    { statement: `${sql}\n`, csv: BACKUP_CSV },
  ]);
});

test("User cannot run an UPDATE when the backup SELECT fails", async () => {
  const sql = "UPDATE ORDERS SET STATUS = ? WHERE ID = ?";
  const result = await runCli(
    ["query", SELECTOR, sql, "--param", "DONE", "--param", "7"],
    fakeEnv({ trace: true, failStatement: "select" }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("fake driver forced SELECT failure");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([
    { sql: "SELECT * FROM ORDERS WHERE ID = ?", paramCount: 1 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User keeps the backup when the UPDATE itself fails", async () => {
  const sql = "UPDATE ORDERS SET STATUS = ? WHERE ID = ?";
  const result = await runCli(
    ["query", SELECTOR, sql, "--param", "DONE", "--param", "7"],
    fakeEnv({ trace: true, failStatement: "dml" }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("fake driver forced DML failure");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([
    { sql: "SELECT * FROM ORDERS WHERE ID = ?", paramCount: 1 },
    { sql, paramCount: 2 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([
    { statement: `${sql}\n`, csv: BACKUP_CSV },
  ]);
});

test("User cannot run an UPDATE when the local backup cannot be written", async () => {
  await writeFile(join(home, ".saptools", "cf-hana"), "blocked", "utf8");
  const sql = "UPDATE ORDERS SET STATUS = ? WHERE ID = ?";
  const result = await runCli(
    ["query", SELECTOR, sql, "--param", "DONE", "--param", "7"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).not.toContain("backup saved to");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([
    { sql: "SELECT * FROM ORDERS WHERE ID = ?", paramCount: 1 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User cannot run a scoped UPDATE in read-only mode", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      "UPDATE ORDERS SET STATUS = ? WHERE ID = ?",
      "--param",
      "DONE",
      "--param",
      "7",
      "--read-only",
    ],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("read-only mode blocks DML");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User cannot run an UPDATE with a parameter-count mismatch", async () => {
  const result = await runCli(
    [
      "query",
      SELECTOR,
      "UPDATE ORDERS SET STATUS = ? WHERE ID = ?",
      "--param",
      "DONE",
    ],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("expects 2 bound parameter");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User cannot run an UPDATE with an empty WHERE clause", async () => {
  const result = await runCli(
    ["query", SELECTOR, "UPDATE ORDERS SET STATUS = ? WHERE", "--param", "DONE"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("non-empty WHERE clause");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User cannot run unsupported DELETE syntax", async () => {
  const result = await runCli(
    ["query", SELECTOR, "DELETE ORDERS WHERE ID = ?", "--param", "7"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("DELETE FROM");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
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

test("User can see a clear failure for an oversized cell limit", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT 1 FROM DUMMY", "--cell-limit", "10001"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--cell-limit must be at most 10000");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
});

test("User cannot save a write statement as a result ref", async () => {
  const result = await runCli(
    ["query", SELECTOR, "UPDATE ORDERS SET STATUS = ? WHERE ID = ?", "--param", "DONE", "--save"],
    fakeEnv({ trace: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--save is only available");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});
