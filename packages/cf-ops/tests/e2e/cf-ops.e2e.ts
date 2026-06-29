import { expect, test } from "@playwright/test";

import { createEnv, prepareCase, readFakeLog, runCli } from "./helpers.js";

test("restart uses rolling strategy and strips SAP credential env vars", async () => {
  const paths = await prepareCase("rolling-restart");
  const result = await runCli(createEnv(paths), ["restart", "--app", "orders-srv", "--strategy", "rolling"]);

  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(result.stdout).toContain("restart completed for orders-srv");
  await expect(readFakeLog(paths.logPath)).resolves.toEqual([
    {
      command: "restart",
      args: ["orders-srv", "--strategy", "rolling"],
      env: { hasSapEmail: false, hasSapPassword: false },
    },
  ]);
});

test("scale can update all dimensions and then restart", async () => {
  const paths = await prepareCase("scale-and-restart");
  const result = await runCli(createEnv(paths), [
    "scale",
    "--app",
    "orders-srv",
    "--instances",
    "3",
    "--memory",
    "1g",
    "--disk",
    "2GB",
    "--restart",
    "--strategy",
    "rolling",
  ]);

  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(result.stdout).toContain("Scaled orders-srv and restarted");
  await expect(readFakeLog(paths.logPath)).resolves.toEqual([
    {
      command: "scale",
      args: ["orders-srv", "-i", "3", "-m", "1G", "-k", "2GB"],
      env: { hasSapEmail: false, hasSapPassword: false },
    },
    {
      command: "restart",
      args: ["orders-srv", "--strategy", "rolling"],
      env: { hasSapEmail: false, hasSapPassword: false },
    },
  ]);
});

test("scale rejects missing dimensions before invoking cf", async () => {
  const paths = await prepareCase("scale-validation");
  const result = await runCli(createEnv(paths), ["scale", "--app", "orders-srv"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("scale requires at least one of --instances, --memory, or --disk");
  await expect(readFakeLog(paths.logPath)).resolves.toEqual([]);
});

test("start stop and restage map directly to cf lifecycle commands", async () => {
  const paths = await prepareCase("basic-lifecycle");
  const env = createEnv(paths);

  await expect(runCli(env, ["start", "--app", "orders-srv"])).resolves.toMatchObject({ code: 0, stderr: "" });
  await expect(runCli(env, ["stop", "--app", "orders-srv"])).resolves.toMatchObject({ code: 0, stderr: "" });
  await expect(runCli(env, ["restage", "--app", "orders-srv"])).resolves.toMatchObject({ code: 0, stderr: "" });

  await expect(readFakeLog(paths.logPath)).resolves.toEqual([
    {
      command: "start",
      args: ["orders-srv"],
      env: { hasSapEmail: false, hasSapPassword: false },
    },
    {
      command: "stop",
      args: ["orders-srv"],
      env: { hasSapEmail: false, hasSapPassword: false },
    },
    {
      command: "restage",
      args: ["orders-srv"],
      env: { hasSapEmail: false, hasSapPassword: false },
    },
  ]);
});

test("invalid memory size fails before invoking cf", async () => {
  const paths = await prepareCase("invalid-memory");
  const result = await runCli(createEnv(paths), ["scale", "--app", "orders-srv", "--memory", "0M"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("memory must be greater than zero");
  await expect(readFakeLog(paths.logPath)).resolves.toEqual([]);
});

test("dry-run prints planned cf commands without invoking cf", async () => {
  const paths = await prepareCase("dry-run");
  const result = await runCli(createEnv(paths), [
    "scale",
    "--app",
    "orders-srv",
    "--instances",
    "2",
    "--restart",
    "--strategy",
    "rolling",
    "--dry-run",
  ]);

  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(result.stdout).toBe("cf scale orders-srv -i 2\ncf restart orders-srv --strategy rolling\n");
  await expect(readFakeLog(paths.logPath)).resolves.toEqual([]);
});

test("invalid restart strategy fails before invoking cf", async () => {
  const paths = await prepareCase("invalid-strategy");
  const result = await runCli(createEnv(paths), ["restart", "--app", "orders-srv", "--strategy", "blue-green"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("--strategy must be either default or rolling");
  await expect(readFakeLog(paths.logPath)).resolves.toEqual([]);
});
