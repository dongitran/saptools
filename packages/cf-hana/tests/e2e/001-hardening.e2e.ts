import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  fakeCfTracePath,
  fakeTracePath,
  readBackupFiles,
  readFakeTraceEntries,
  runCli,
  setupFakeCfBin,
} from "./helpers.js";

const SELECTOR = "eu10/example-org/space-demo/app-demo";

interface FakeEnvOptions {
  readonly apiEndpoint?: string;
  readonly failStatement?: "select" | "dml";
  readonly multipleBindings?: boolean;
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
    ...(options.multipleBindings === true
      ? { CF_HANA_FAKE_CF_MULTIPLE_BINDINGS: "1" }
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
