import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { runCli, seedCredentialsCache } from "./helpers.js";

const SELECTOR = "eu10/acme/dev/orders-srv";

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

test("prints help that lists the commands", async () => {
  const result = await runCli(["--help"], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("query");
  expect(result.stdout).toContain("tables");
});

test("prints the version", async () => {
  const result = await runCli(["--version"], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("0.1.0");
});

test("info prints resolved metadata without a database connection", async () => {
  const result = await runCli(["info", SELECTOR], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("APP_SCHEMA");
  expect(result.stdout).toContain("orders-srv");
});

test("query runs a statement and prints a table", async () => {
  const result = await runCli(["query", SELECTOR, "SELECT 1 FROM DUMMY"], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("1");
});

test("query supports JSON output", async () => {
  const result = await runCli(
    ["query", SELECTOR, "SELECT 1 FROM DUMMY", "--format", "json"],
    fakeEnv(),
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([{ "1": 1 }]);
});

test("ping reports connectivity", async () => {
  const result = await runCli(["ping", SELECTOR], fakeEnv());
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("OK");
});

test("fails with a non-zero exit code for an uncached app", async () => {
  const result = await runCli(["info", "definitely-missing-app"], fakeEnv());
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("cf-hana");
});
