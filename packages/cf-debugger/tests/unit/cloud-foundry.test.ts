import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cfApi,
  cfAppExists,
  cfAuth,
  cfEnableSsh,
  cfLogin,
  cfSshEnabled,
  cfTarget,
} from "../../src/cloud-foundry/commands.js";
import type { CfExecContext } from "../../src/cloud-foundry/execute.js";
import {
  DEFAULT_CF_COMMAND_TIMEOUT_MS,
  DEFAULT_CF_OPERATION_TIMEOUT_MS,
  runCf,
} from "../../src/cloud-foundry/execute.js";

interface LoggedCommand {
  readonly args: readonly string[];
  readonly cfColor: string;
  readonly cfHome: string;
  readonly hasAuthPassword: boolean;
  readonly hasAuthUsername: boolean;
}

const FAKE_CF_SOURCE = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const cfHome = process.env.CF_HOME ?? "";
const logPath = process.env.CF_DEBUGGER_TEST_FAKE_LOG;

if (process.env.CF_DEBUGGER_TEST_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}

if (logPath !== undefined && logPath !== "") {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({
    args,
    cfColor: process.env.CF_COLOR ?? "",
    cfHome,
    hasAuthPassword: (process.env.CF_PASSWORD ?? "") !== "",
    hasAuthUsername: (process.env.CF_USERNAME ?? "") !== "",
  }) + "\\n", "utf8");
}

function fail(message) {
  process.stderr.write(message + "\\n");
  process.exit(1);
}

switch (args[0]) {
  case "api": {
    if (process.env.CF_DEBUGGER_TEST_FAIL_API === "1") {
      fail("api unavailable");
    }
    process.stdout.write("api ok\\n");
    break;
  }
  case "auth": {
    const counterPath = join(cfHome, "auth-count.txt");
    const previous = existsSync(counterPath)
      ? Number.parseInt(readFileSync(counterPath, "utf8"), 10)
      : 0;
    const next = previous + 1;
    mkdirSync(cfHome, { recursive: true });
    writeFileSync(counterPath, String(next), "utf8");
    const failures = Number.parseInt(process.env.CF_DEBUGGER_TEST_AUTH_FAILURES ?? "0", 10);
    if (next <= failures) {
      fail("error performing request: authentication failed");
    }
    process.stdout.write("auth ok\\n");
    break;
  }
  case "target": {
    process.stdout.write("target ok\\n");
    break;
  }
  case "app": {
    if (args[1] === "missing-app") {
      fail("App not found");
    }
    if (args[1] === "broken-app") {
      fail("connection failed");
    }
    process.stdout.write("app ok\\n");
    break;
  }
  case "apps": {
    process.stdout.write("name\\ndemo-app\\n");
    break;
  }
  case "network-test": {
    const counterPath = join(cfHome, "network-count.txt");
    const previous = existsSync(counterPath)
      ? Number.parseInt(readFileSync(counterPath, "utf8"), 10)
      : 0;
    const next = previous + 1;
    mkdirSync(cfHome, { recursive: true });
    writeFileSync(counterPath, String(next), "utf8");
    const failures = Number.parseInt(process.env.CF_DEBUGGER_TEST_NETWORK_FAILURES ?? "0", 10);
    if (next <= failures) {
      fail("dial tcp: i/o timeout");
    }
    process.stdout.write("network ok\\n");
    break;
  }
  case "sleep-test": {
    if (process.env.CF_DEBUGGER_TEST_TIMEOUT === "1") {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    process.stdout.write("sleep ok\\n");
    break;
  }
  case "descendant-holds-output": {
    const descendant = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 2000)"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    descendant.unref();
    process.exit(1);
    break;
  }
  case "stdout-noise": {
    process.stdout.write("app-502 says gateway timeout\\n");
    fail("permanent failure");
    break;
  }
  case "stderr-noise": {
    fail("application timeout for job 502");
    break;
  }
  default: {
    fail("unsupported command: " + (args[0] ?? ""));
  }
}
`;

async function readLog(logPath: string): Promise<readonly LoggedCommand[]> {
  const raw = await readFile(logPath, "utf8").catch(() => "");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LoggedCommand);
}

describe("cloud-foundry command wrappers", () => {
  let tempDir: string;
  let fakeCfPath: string;
  let logPath: string;
  let context: CfExecContext;
  let originalLog: string | undefined;
  let originalAuthFailures: string | undefined;
  let originalFailApi: string | undefined;
  let originalNetworkFailures: string | undefined;
  let originalTimeout: string | undefined;
  let originalIgnoreSigterm: string | undefined;

  beforeEach(async () => {
    originalLog = process.env["CF_DEBUGGER_TEST_FAKE_LOG"];
    originalAuthFailures = process.env["CF_DEBUGGER_TEST_AUTH_FAILURES"];
    originalFailApi = process.env["CF_DEBUGGER_TEST_FAIL_API"];
    originalNetworkFailures = process.env["CF_DEBUGGER_TEST_NETWORK_FAILURES"];
    originalTimeout = process.env["CF_DEBUGGER_TEST_TIMEOUT"];
    originalIgnoreSigterm = process.env["CF_DEBUGGER_TEST_IGNORE_SIGTERM"];
    tempDir = await mkdtemp(join(tmpdir(), "cf-debugger-cf-unit-"));
    fakeCfPath = join(tempDir, "fake-cf.mjs");
    logPath = join(tempDir, "commands.log");
    await writeFile(fakeCfPath, FAKE_CF_SOURCE, "utf8");
    await chmod(fakeCfPath, 0o755);
    process.env["CF_DEBUGGER_TEST_FAKE_LOG"] = logPath;
    delete process.env["CF_DEBUGGER_TEST_AUTH_FAILURES"];
    delete process.env["CF_DEBUGGER_TEST_FAIL_API"];
    delete process.env["CF_DEBUGGER_TEST_NETWORK_FAILURES"];
    delete process.env["CF_DEBUGGER_TEST_TIMEOUT"];
    delete process.env["CF_DEBUGGER_TEST_IGNORE_SIGTERM"];
    context = { cfHome: join(tempDir, "cf-home"), command: fakeCfPath };
  });

  afterEach(async () => {
    if (originalLog === undefined) {
      delete process.env["CF_DEBUGGER_TEST_FAKE_LOG"];
    } else {
      process.env["CF_DEBUGGER_TEST_FAKE_LOG"] = originalLog;
    }
    if (originalAuthFailures === undefined) {
      delete process.env["CF_DEBUGGER_TEST_AUTH_FAILURES"];
    } else {
      process.env["CF_DEBUGGER_TEST_AUTH_FAILURES"] = originalAuthFailures;
    }
    if (originalFailApi === undefined) {
      delete process.env["CF_DEBUGGER_TEST_FAIL_API"];
    } else {
      process.env["CF_DEBUGGER_TEST_FAIL_API"] = originalFailApi;
    }
    if (originalNetworkFailures === undefined) {
      delete process.env["CF_DEBUGGER_TEST_NETWORK_FAILURES"];
    } else {
      process.env["CF_DEBUGGER_TEST_NETWORK_FAILURES"] = originalNetworkFailures;
    }
    if (originalTimeout === undefined) {
      delete process.env["CF_DEBUGGER_TEST_TIMEOUT"];
    } else {
      process.env["CF_DEBUGGER_TEST_TIMEOUT"] = originalTimeout;
    }
    if (originalIgnoreSigterm === undefined) {
      delete process.env["CF_DEBUGGER_TEST_IGNORE_SIGTERM"];
    } else {
      process.env["CF_DEBUGGER_TEST_IGNORE_SIGTERM"] = originalIgnoreSigterm;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs CF commands with the isolated CF home", async () => {
    await expect(runCf(["apps"], context, {
      env: { CF_COLOR: "true", CF_HOME: join(tempDir, "attacker-home") },
    })).resolves.toBe("name\ndemo-app\n");

    const commands = await readLog(logPath);
    expect(commands).toEqual([{
      args: ["apps"],
      cfColor: "false",
      cfHome: context.cfHome,
      hasAuthPassword: false,
      hasAuthUsername: false,
    }]);
  });

  it("bounds individual commands and the overall retry operation", () => {
    expect(DEFAULT_CF_COMMAND_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_CF_OPERATION_TIMEOUT_MS).toBe(300_000);
  });

  it("retries transient network errors and reports the shared budget", async () => {
    process.env["CF_DEBUGGER_TEST_NETWORK_FAILURES"] = "1";
    const retries: {
      readonly attempt: number;
      readonly command: string;
      readonly delayMs: number;
      readonly remainingMs: number;
    }[] = [];
    await runCf(["network-test", "sensitive-target"], {
      ...context,
      sensitiveValues: ["sensitive-target"],
      onRetry: (status): void => {
        retries.push(status);
      },
    });

    const commands = await readLog(logPath);
    expect(commands.map((entry) => entry.args[0])).toEqual(["network-test", "network-test"]);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      attempt: 1,
      command: "cf network-test <redacted>",
      delayMs: 1000,
    });
    expect(retries[0]?.remainingMs).toBeGreaterThan(1000);
    expect(retries[0]?.remainingMs).toBeLessThanOrEqual(DEFAULT_CF_OPERATION_TIMEOUT_MS);
  });

  it("stops retrying when the overall operation budget cannot fit another attempt", async () => {
    process.env["CF_DEBUGGER_TEST_NETWORK_FAILURES"] = "100";
    const startedAt = Date.now();
    await expect(runCf(["network-test"], context, {
      retryBudgetMs: 800,
    })).rejects.toMatchObject({
      code: "CF_CLI_TIMEOUT",
    });

    const commands = await readLog(logPath);
    expect(commands.map((entry) => entry.args[0])).toEqual(["network-test"]);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it("clamps a hanging child attempt to the remaining overall budget", async () => {
    process.env["CF_DEBUGGER_TEST_TIMEOUT"] = "1";
    process.env["CF_DEBUGGER_TEST_IGNORE_SIGTERM"] = "1";
    const startedAt = Date.now();
    await expect(runCf(["sleep-test"], context, {
      retryBudgetMs: 250,
      timeoutMs: 60_000,
    })).rejects.toMatchObject({
      code: "CF_CLI_TIMEOUT",
    });

    const commands = await readLog(logPath);
    expect(commands.length).toBeLessThanOrEqual(1);
    expect(Date.now() - startedAt).toBeLessThan(1200);
  });

  it("does not wait for a wrapper descendant that inherits command output", async () => {
    const startedAt = Date.now();
    await expect(runCf(["descendant-holds-output"], context, {
      retryBudgetMs: 250,
      timeoutMs: 250,
    })).rejects.toMatchObject({
      code: "CF_CLI_TIMEOUT",
    });

    expect(Date.now() - startedAt).toBeLessThan(1200);
  });

  it("reports a shared startup deadline with the active phase", async () => {
    process.env["CF_DEBUGGER_TEST_TIMEOUT"] = "1";
    const startedAt = Date.now();
    await expect(runCf(["sleep-test"], {
      ...context,
      deadlineAt: Date.now() + 250,
      phase: "authentication",
      startupTimeoutMs: 250,
    }, {
      timeoutMs: 60_000,
    })).rejects.toMatchObject({
      code: "STARTUP_TIMEOUT",
      message: expect.stringContaining("authentication"),
    });
    expect(Date.now() - startedAt).toBeLessThan(1200);
    expect((await readLog(logPath)).length).toBeLessThanOrEqual(1);
  });

  it("does not retry arbitrary timeout or 502 text from command output", async () => {
    await expect(runCf(["stdout-noise"], context)).rejects.toMatchObject({
      code: "CF_CLI_FAILED",
    });
    await expect(runCf(["stderr-noise"], context)).rejects.toMatchObject({
      code: "CF_CLI_FAILED",
    });

    const commands = await readLog(logPath);
    expect(commands.map((entry) => entry.args[0])).toEqual(["stdout-noise", "stderr-noise"]);
  });

  it("does not start a CF command when the caller already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(runCf(["apps"], { ...context, signal: controller.signal })).rejects.toMatchObject({
      code: "ABORTED",
    });
    await expect(readLog(logPath)).resolves.toEqual([]);
  });

  it("terminates an active CF command when the caller aborts", async () => {
    process.env["CF_DEBUGGER_TEST_TIMEOUT"] = "1";
    const controller = new AbortController();
    const running = runCf(["sleep-test"], { ...context, signal: controller.signal }, 60_000);
    setTimeout(() => {
      controller.abort();
    }, 25);

    await expect(running).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("interrupts a transient-failure retry delay when the caller aborts", async () => {
    process.env["CF_DEBUGGER_TEST_NETWORK_FAILURES"] = "2";
    const controller = new AbortController();
    const startedAt = Date.now();
    const running = runCf(["network-test"], { ...context, signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 500);

    await expect(running).rejects.toMatchObject({ code: "ABORTED" });
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect((await readLog(logPath)).length).toBeLessThanOrEqual(1);
  });

  it("passes api and target arguments through the wrapper", async () => {
    await cfApi("https://api.example.com", context);
    await cfTarget("org-a", "dev", context);

    const commands = await readLog(logPath);
    expect(commands.map((entry) => entry.args)).toEqual([
      ["api", "https://api.example.com"],
      ["target", "-o", "org-a", "-s", "dev"],
    ]);
  });

  it("does not retry rejected credentials even when the message has a transport prefix", async () => {
    process.env["CF_DEBUGGER_TEST_AUTH_FAILURES"] = "2";

    await expect(
      cfAuth("user@example.com", "opaque-value", context),
    ).rejects.toMatchObject({ code: "CF_AUTH_FAILED" });

    const commands = await readLog(logPath);
    expect(commands.map((entry) => entry.args[0])).toEqual(["auth"]);
  });

  it("passes auth credentials only through the child environment", async () => {
    await cfAuth("user@example.com", "opaque-value", context);

    const commands = await readLog(logPath);
    expect(commands).toEqual([{
      args: ["auth"],
      cfColor: "false",
      cfHome: context.cfHome,
      hasAuthPassword: true,
      hasAuthUsername: true,
    }]);
  });

  it("does not continue auth retries after the caller aborts", async () => {
    process.env["CF_DEBUGGER_TEST_AUTH_FAILURES"] = "3";
    const controller = new AbortController();
    const running = cfAuth("user@example.com", "opaque-value", {
      ...context,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 25);

    await expect(running).rejects.toMatchObject({ code: "ABORTED" });
    expect((await readLog(logPath)).length).toBeLessThanOrEqual(1);
  }, 500);

  it("wraps API failures as login failures", async () => {
    process.env["CF_DEBUGGER_TEST_FAIL_API"] = "1";

    await expect(
      cfLogin("https://api.example.com", "user@example.com", "opaque-value", context),
    ).rejects.toMatchObject({
      code: "CF_LOGIN_FAILED",
    });
  });

  it("preserves caller abort errors through CF command wrappers", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedContext = { ...context, signal: controller.signal };

    await expect(
      cfLogin("https://api.example.com", "user@example.com", "opaque-value", abortedContext),
    ).rejects.toMatchObject({ code: "ABORTED" });
    await expect(cfTarget("org-a", "dev", abortedContext)).rejects.toMatchObject({ code: "ABORTED" });
    await expect(cfEnableSsh("demo-app", abortedContext)).rejects.toMatchObject({ code: "ABORTED" });
    await expect(cfSshEnabled("demo-app", abortedContext)).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("redacts auth credentials from CF command failures", async () => {
    process.env["CF_DEBUGGER_TEST_AUTH_FAILURES"] = "3";
    const password = "phase2-sensitive-value";

    await expect(cfAuth("user@example.com", password, context)).rejects.toMatchObject({
      code: "CF_AUTH_FAILED",
      message: expect.not.stringContaining(password),
      stderr: expect.not.stringContaining(password),
    });
  }, 10_000);

  it("normalizes sensitive values before redacting overlapping failure text", async () => {
    await expect(runCf(["abcdef"], context, {
      sensitiveValues: ["", "abc", "abcdef", "abc"],
    })).rejects.toMatchObject({
      code: "CF_CLI_FAILED",
      message: expect.not.stringContaining("abcdef"),
      stderr: "unsupported command: <redacted>",
    });
  });

  it("maps app not-found output to false and rethrows unrelated app errors", async () => {
    await expect(cfAppExists("missing-app", context)).resolves.toBe(false);
    await expect(cfAppExists("broken-app", context)).rejects.toMatchObject({
      code: "CF_CLI_FAILED",
    });
  });
});
