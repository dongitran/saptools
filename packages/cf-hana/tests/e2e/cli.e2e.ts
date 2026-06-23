import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { readHistoryEntries, runCli, seedCredentialsCache } from "./helpers.js";

const SELECTOR = "eu10/example-org/space-demo/app-demo";

let home: string;

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cf-hana-e2e-"));
  await seedCredentialsCache(home);
});

test.afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fakeEnv(): Record<string, string> {
  return { HOME: home, CF_HANA_DRIVER: "fake" };
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
  expect(result.stdout).toContain("0.1.3");
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
