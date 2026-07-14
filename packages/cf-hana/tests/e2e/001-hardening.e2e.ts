import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  fakeCfTracePath,
  fakeTracePath,
  readBackupFiles,
  readFakeCfTraceEntries,
  readFakeTraceEntries,
  runCli,
  setupFakeCfBin,
} from "./helpers.js";

const SELECTOR = "eu10/example-org/space-demo/app-demo";

interface FakeEnvOptions {
  readonly apiEndpoint?: string;
  readonly failStatement?: "select" | "dml";
  readonly maxStoreBytes?: number;
  readonly multipleBindings?: boolean;
  readonly privilegeCatalog?: boolean;
  readonly ambientTargetAba?: boolean;
  readonly retargetAfterEnv?: boolean;
}

let home: string;
let fakeBinDir: string;

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cf-hana-hardening-e2e-"));
  fakeBinDir = await setupFakeCfBin(home);
});

test.afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fakeEnv(options: FakeEnvOptions = {}): Record<string, string> {
  return {
    HOME: home,
    CF_HANA_DRIVER: "fake",
    CF_HANA_FAKE_CF_TRACE_FILE: fakeCfTracePath(home),
    CF_HANA_FAKE_TRACE_FILE: fakeTracePath(home),
    PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
    SAP_EMAIL: "user@example.com",
    SAP_PASSWORD: "secret",
    ...(options.apiEndpoint === undefined
      ? {}
      : { CF_HANA_FAKE_CF_API_ENDPOINT: options.apiEndpoint }),
    ...(options.failStatement === undefined
      ? {}
      : { CF_HANA_FAKE_FAIL_STATEMENT: options.failStatement }),
    ...(options.maxStoreBytes === undefined
      ? {}
      : { CF_HANA_FAKE_MAX_STORE_BYTES: String(options.maxStoreBytes) }),
    ...(options.multipleBindings === true
      ? { CF_HANA_FAKE_CF_MULTIPLE_BINDINGS: "1" }
      : {}),
    ...(options.privilegeCatalog === true
      ? { CF_HANA_FAKE_PRIVILEGE_CATALOG: "1" }
      : {}),
    ...(options.ambientTargetAba === true
      ? { CF_HANA_FAKE_CF_AMBIENT_TARGET_ABA: "1" }
      : {}),
    ...(options.retargetAfterEnv === true
      ? { CF_HANA_FAKE_CF_RETARGET_AFTER_ENV: "1" }
      : {}),
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
  const result = await runCli(["query", SELECTOR, sql], fakeEnv({ failStatement: "select" }));

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("fake driver forced SELECT failure");
  const trace = await readFakeTraceEntries(home);
  expect(trace).toHaveLength(1);
  expect(trace[0]?.sql).toContain("SELECT target.* FROM ORDERS target");
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User cannot run a write when its backup exceeds the storage cap", async () => {
  const sql = "UPDATE ORDERS SET STATUS = 'DONE' WHERE ID = 7";
  const result = await runCli(["query", SELECTOR, sql], fakeEnv({ maxStoreBytes: 16 }));

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Write backup exceeds the storage limit");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([
    { sql: "SELECT * FROM ORDERS WHERE ID = 7", paramCount: 0 },
  ]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});

test("User must approve an unconditional matched DELETE before its backed MERGE runs", async () => {
  const sql =
    "MERGE INTO ORDERS target USING SOURCE_ROWS source ON target.ID = source.ID " +
    "WHEN MATCHED THEN DELETE";
  const selectSql =
    "SELECT target.* FROM ORDERS target " +
    "WHERE EXISTS (SELECT 1 FROM SOURCE_ROWS source WHERE (target.ID = source.ID))";
  const blocked = await runCli(["query", SELECTOR, sql], fakeEnv());

  expect(blocked.exitCode).toBe(1);
  expect(blocked.stderr).toContain("destructive statement blocked");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);

  const allowed = await runCli(
    ["query", SELECTOR, sql, "--allow-destructive"],
    fakeEnv(),
  );
  expect(allowed.exitCode).toBe(0);
  expect(allowed.stderr).toContain("backup saved to");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([
    { sql: selectSql, paramCount: 0 },
    { sql, paramCount: 0 },
  ]);
});

test("User sees ambient target provenance on every connecting command", async () => {
  const commands: readonly (readonly string[])[] = [
    ["query", "app-demo", "SELECT 1 FROM DUMMY"],
    ["tables", "app-demo"],
    ["columns", "app-demo", "APP_SCHEMA.EXISTING_TABLE"],
    ["count", "app-demo", "APP_SCHEMA.EXISTING_TABLE"],
    ["ping", "app-demo"],
    ["info", "app-demo"],
  ];

  for (const args of commands) {
    const result = await runCli(args, fakeEnv());
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      "target eu10-005/example-org/space-demo/app-demo (resolved from ambient 'cf target'",
    );
  }
});

test("User sees an explicit label for a pinned selector", async () => {
  const result = await runCli(["query", SELECTOR, "SELECT 1 FROM DUMMY"], fakeEnv());

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain(`target ${SELECTOR} (explicit selector)`);
  expect(result.stdout.trim()).toBe("1\r\n1");
});

test("User is warned when an ambient CF region cannot be mapped", async () => {
  const result = await runCli(
    ["info", "app-demo"],
    fakeEnv({ apiEndpoint: "https://api.cf.cn99.platform.sapcloud.cn" }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("target current/example-org/space-demo/app-demo");
  expect(result.stderr).toContain("region could not be mapped");
});

test("User cannot query through a bare selector when cf target changes mid-resolution", async () => {
  const result = await runCli(
    ["query", "app-demo", "SELECT 1 FROM DUMMY"],
    fakeEnv({ retargetAfterEnv: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("CF target changed during binding discovery");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
});

test("User cannot query through a bare selector when cf target switches A to B and back", async () => {
  const result = await runCli(
    ["query", "app-demo", "SELECT 1 FROM DUMMY"],
    fakeEnv({ ambientTargetAba: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    "CF env application identity did not match the resolved ambient target",
  );
  const cfTrace = await readFakeCfTraceEntries(home);
  expect(cfTrace.map((entry) => ({ kind: entry.kind, org: entry.org }))).toEqual([
    { kind: "target-read", org: "example-org" },
    { kind: "env", org: "different-org" },
    { kind: "target-read", org: "example-org" },
  ]);
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
});

test("User still gets a hard error for ambiguous HANA bindings", async () => {
  const result = await runCli(
    ["query", "app-demo", "SELECT 1 FROM DUMMY"],
    fakeEnv({ multipleBindings: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("multiple HANA bindings");
  expect(result.stderr).toContain("hana-primary");
  expect(result.stderr).toContain("hana-secondary");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
});

test("User gets binding-specific guidance for HANA error 258 without an automatic retry", async () => {
  const sql = "SELECT * FROM APP_SCHEMA.PRIVILEGE_ERROR_CODE";
  const result = await runCli(
    ["query", "app-demo", sql, "--binding", "hana-primary"],
    fakeEnv({ multipleBindings: true }),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("insufficient privilege for schema APP_SCHEMA");
  expect(result.stderr).toContain("database user DB_USER");
  expect(result.stderr).toContain("current binding: hana-primary");
  expect(result.stderr).toContain("other HANA bindings on this app: hana-secondary");
  expect(result.stderr).toContain("--binding hana-secondary");
  expect(result.stderr).toContain("insufficient privilege: not authorized");
  const trace = await readFakeTraceEntries(home);
  expect(trace).toEqual([{ sql: `${sql} LIMIT 101`, paramCount: 0 }]);
});

test("User gets the privilege hint when the driver omits error code 258", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM PRIVILEGE_ERROR_MESSAGE"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("insufficient privilege for schema APP_SCHEMA");
  expect(result.stderr).toContain("database user DB_USER");
});

test("User does not get privilege guidance for unrelated query failures", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM NON_PRIVILEGE_ERROR"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("fake unrelated query failure");
  expect(result.stderr).not.toContain("other HANA bindings");
  expect(result.stderr).not.toContain("whose binding has the grant");
});

test("User gets the privilege hint from catalog read commands too", async () => {
  const result = await runCli(["tables", SELECTOR], fakeEnv({ privilegeCatalog: true }));

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("insufficient privilege for schema APP_SCHEMA");
  expect(result.stderr).toContain("database user DB_USER");
});

test("User can inspect auto-saved exact values after compact output truncates", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--cell-limit", "6"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("1,sample");
  expect(result.stdout).not.toContain("ref=");
  const match = /exact values auto-saved as (q[0-9a-f]{8})/.exec(result.stderr);
  const ref = match?.[1] ?? "";
  expect(ref).not.toBe("");
  expect(result.stderr).toContain(
    `cf-hana result show ${ref} --row <r> --column <c>`,
  );

  const exact = await runCli(
    ["result", "show", ref, "--row", "1", "--column", "NAME", "--length", "50"],
    fakeEnv(),
  );
  expect(exact.exitCode).toBe(0);
  expect(exact.stdout).toContain("sample-row");
});

test("User can opt out of truncation-triggered result saves", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--cell-limit", "6", "--no-auto-save"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("rerun with --save or increase --cell-limit");
  expect(result.stderr).not.toContain("auto-saved as");
  const listed = await runCli(["result", "list"], fakeEnv());
  expect(listed.stdout).not.toMatch(/q[0-9a-f]{8}/);
});

test("User does not create an implicit result ref when no cell is truncated", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--cell-limit", "20"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).not.toContain("compacted");
  expect(result.stderr).not.toContain("auto-saved as");
  const listed = await runCli(["result", "list"], fakeEnv());
  expect(listed.stdout).not.toMatch(/q[0-9a-f]{8}/);
});

test("User keeps compact output when an automatic save exceeds the storage cap", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--cell-limit", "6"],
    fakeEnv({ maxStoreBytes: 64 }),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("1,sample");
  expect(result.stderr).toContain("rerun with --save or increase --cell-limit");
  expect(result.stderr).not.toContain("auto-saved as");
  const listed = await runCli(["result", "list"], fakeEnv());
  expect(listed.stdout).not.toMatch(/q[0-9a-f]{8}/);
});

test("User keeps compact query output when an automatic save fails", async () => {
  const cfHanaRoot = join(home, ".saptools", "cf-hana");
  await mkdir(cfHanaRoot, { recursive: true });
  await writeFile(join(cfHanaRoot, "results"), "blocks result directory creation", "utf8");

  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--cell-limit", "6"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("1,sample");
  expect(result.stderr).toContain("rerun with --save or increase --cell-limit");
  expect(result.stderr).not.toContain("auto-saved as");
});

test("User can request lossless CSV and table query formats", async () => {
  const csv = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--format", "csv", "--cell-limit", "3"],
    fakeEnv(),
  );
  const table = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--format", "table", "--cell-limit", "3"],
    fakeEnv(),
  );

  expect(csv.exitCode).toBe(0);
  expect(csv.stdout.trim()).toBe("ID,NAME\r\n1,sample-row\r\n2,second-row");
  expect(table.exitCode).toBe(0);
  expect(table.stdout).toContain("sample-row");
  expect(table.stdout).toContain("second-row");
  expect(table.stderr).not.toContain("compacted");
});

test("User can request lossless JSON query output", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--format", "json", "--cell-limit", "3"],
    fakeEnv(),
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    { ID: 1, NAME: "sample-row" },
    { ID: 2, NAME: "second-row" },
  ]);
  expect(result.stderr).not.toContain("compacted");
});

test("User gets flat JSON for catalog names and single-column query values", async () => {
  const tables = await runCli(["tables", SELECTOR, "--format", "json-compact"], fakeEnv());
  const columns = await runCli(
    ["columns", SELECTOR, "APP_SCHEMA.EXISTING_TABLE", "--format", "json-compact"],
    fakeEnv(),
  );
  const query = await runCli(
    ["query", SELECTOR, "SELECT VALUE FROM SINGLE_COLUMN_FIXTURE", "--format", "json-compact"],
    fakeEnv(),
  );

  expect(JSON.parse(tables.stdout)).toEqual(["EXISTING_TABLE", "STATUS_ITEMS"]);
  expect(JSON.parse(columns.stdout)).toEqual(["ID", "IS_ACTIVE", "SCOPE_NAME"]);
  expect(JSON.parse(query.stdout)).toEqual(["alpha", "beta"]);
});

test("User gets row objects when JSON compact query output has multiple columns", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--format", "json-compact"],
    fakeEnv(),
  );

  expect(JSON.parse(result.stdout)).toEqual([
    { ID: 1, NAME: "sample-row" },
    { ID: 2, NAME: "second-row" },
  ]);
});

test("User keeps existing catalog JSON object keys", async () => {
  const tables = await runCli(["tables", SELECTOR, "--format", "json"], fakeEnv());
  const columns = await runCli(
    ["columns", SELECTOR, "APP_SCHEMA.EXISTING_TABLE", "--format", "json"],
    fakeEnv(),
  );

  expect(JSON.parse(tables.stdout)).toEqual([
    { SCHEMA: "APP_SCHEMA", TABLE: "EXISTING_TABLE", TYPE: "COLUMN TABLE" },
    { SCHEMA: "APP_SCHEMA", TABLE: "STATUS_ITEMS", TYPE: "ROW TABLE" },
  ]);
  expect(JSON.parse(columns.stdout)).toEqual([
    { COLUMN: "ID", TYPE: "INTEGER", LENGTH: null, NULLABLE: false, POSITION: 1 },
    { COLUMN: "IS_ACTIVE", TYPE: "BOOLEAN", LENGTH: null, NULLABLE: true, POSITION: 2 },
    { COLUMN: "SCOPE_NAME", TYPE: "NVARCHAR", LENGTH: 255, NULLABLE: true, POSITION: 3 },
  ]);
});

test("User sees exact JSON shapes in query and catalog help", async () => {
  const query = await runCli(["query", "--help"], fakeEnv());
  const tables = await runCli(["tables", "--help"], fakeEnv());
  const columns = await runCli(["columns", "--help"], fakeEnv());

  expect(query.stdout).toContain("default SELECT: compact CSV");
  expect(query.stdout).toContain("--format json: [{COLUMN: value, ...}]");
  expect(tables.stdout).toContain("[{SCHEMA,TABLE,TYPE}]");
  expect(columns.stdout).toContain("[{COLUMN,TYPE,LENGTH,NULLABLE,POSITION}]");
  expect(tables.stdout).toContain("json-compact: [TABLE, ...]");
  expect(columns.stdout).toContain("json-compact: [COLUMN, ...]");
});

test("User gets invalid format errors before any database statement runs", async () => {
  const query = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--format", "xml"],
    fakeEnv(),
  );
  const tables = await runCli(["tables", SELECTOR, "--format", "xml"], fakeEnv());

  expect(query.exitCode).toBe(1);
  expect(tables.exitCode).toBe(1);
  expect(query.stderr).toContain("Invalid --format");
  expect(tables.stderr).toContain("Invalid --format");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
});

test("User cannot combine structured query output with result refs or writes", async () => {
  const saved = await runCli(
    ["query", SELECTOR, "SELECT * FROM ITEMS", "--format", "json", "--save"],
    fakeEnv(),
  );
  const write = await runCli(
    ["query", SELECTOR, "DELETE FROM ITEMS WHERE ID = 1", "--format", "json"],
    fakeEnv(),
  );

  expect(saved.exitCode).toBe(1);
  expect(saved.stderr).toContain("--save cannot be combined with --format");
  expect(write.exitCode).toBe(1);
  expect(write.stderr).toContain("--format is only available for SELECT/WITH statements");
  await expect(readFakeTraceEntries(home)).resolves.toEqual([]);
  await expect(readBackupFiles(home)).resolves.toEqual([]);
});
