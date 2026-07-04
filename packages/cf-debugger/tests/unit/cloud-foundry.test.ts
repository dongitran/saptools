import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cfApi,
  cfAppExists,
  cfAuth,
  cfLogin,
  cfTarget,
} from "../../src/cloud-foundry/commands.js";
import type { CfExecContext } from "../../src/cloud-foundry/execute.js";
import {
  DEFAULT_CF_COMMAND_TIMEOUT_MS,
  runCf,
} from "../../src/cloud-foundry/execute.js";

interface LoggedCommand {
  readonly args: readonly string[];
  readonly cfHome: string;
}

const FAKE_CF_SOURCE = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const cfHome = process.env.CF_HOME ?? "";
const logPath = process.env.CF_DEBUGGER_TEST_FAKE_LOG;

if (logPath !== undefined && logPath !== "") {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({ args, cfHome }) + "\\n", "utf8");
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
      fail("authentication failed");
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
      const waitTime = Date.now() + 2000;
      while (Date.now() < waitTime) {
        // busy wait
      }
    }
    process.stdout.write("sleep ok\\n");
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

  beforeEach(async () => {
    originalLog = process.env["CF_DEBUGGER_TEST_FAKE_LOG"];
    originalAuthFailures = process.env["CF_DEBUGGER_TEST_AUTH_FAILURES"];
    originalFailApi = process.env["CF_DEBUGGER_TEST_FAIL_API"];
    originalNetworkFailures = process.env["CF_DEBUGGER_TEST_NETWORK_FAILURES"];
    originalTimeout = process.env["CF_DEBUGGER_TEST_TIMEOUT"];
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
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs CF commands with the isolated CF home", async () => {
    await expect(runCf(["apps"], context)).resolves.toBe("name\ndemo-app\n");

    const commands = await readLog(logPath);
    expect(commands).toEqual([{ args: ["apps"], cfHome: context.cfHome }]);
  });

  it("allows five minutes for Cloud Foundry commands by default", () => {
    expect(DEFAULT_CF_COMMAND_TIMEOUT_MS).toBe(300_000);
  });

  it("retries transient network errors in runCf", async () => {
    process.env["CF_DEBUGGER_TEST_NETWORK_FAILURES"] = "2";
    await runCf(["network-test"], context);

    const commands = await readLog(logPath);
    // Should have retried and succeeded on the 3rd attempt
    expect(commands.map((entry) => entry.args[0])).toEqual(["network-test", "network-test", "network-test"]);
  });

  it("throws after exhausting max retries for network errors", async () => {
    process.env["CF_DEBUGGER_TEST_NETWORK_FAILURES"] = "4";
    await expect(runCf(["network-test"], context)).rejects.toMatchObject({
      code: "CF_CLI_FAILED",
      stderr: expect.stringContaining("dial tcp: i/o timeout"),
    });

    const commands = await readLog(logPath);
    // Should have attempted 4 times (1 initial + 3 retries) and failed
    expect(commands.map((entry) => entry.args[0])).toEqual(["network-test", "network-test", "network-test", "network-test"]);
  }, 15_000);

  it("retries when the process is killed due to timeout", async () => {
    process.env["CF_DEBUGGER_TEST_TIMEOUT"] = "1";
    // Using a 500ms timeout, and the script waits 2000ms, so it gets killed
    await expect(runCf(["sleep-test"], context, 500)).rejects.toMatchObject({
      code: "CF_CLI_FAILED",
    });

    const commands = await readLog(logPath);
    // Should retry 3 times for timeout (killed = true)
    expect(commands.map((entry) => entry.args[0])).toEqual(["sleep-test", "sleep-test", "sleep-test", "sleep-test"]);
  }, 15_000);

  it("passes api and target arguments through the wrapper", async () => {
    await cfApi("https://api.example.com", context);
    await cfTarget("org-a", "dev", context);

    const commands = await readLog(logPath);
    expect(commands.map((entry) => entry.args)).toEqual([
      ["api", "https://api.example.com"],
      ["target", "-o", "org-a", "-s", "dev"],
    ]);
  });

  it("retries transient auth failures before succeeding", async () => {
    process.env["CF_DEBUGGER_TEST_AUTH_FAILURES"] = "2";

    await cfAuth("user@example.com", "opaque-value", context);

    const commands = await readLog(logPath);
    expect(commands.map((entry) => entry.args[0])).toEqual(["auth", "auth", "auth"]);
  });

  it("wraps API failures as login failures", async () => {
    process.env["CF_DEBUGGER_TEST_FAIL_API"] = "1";

    await expect(
      cfLogin("https://api.example.com", "user@example.com", "opaque-value", context),
    ).rejects.toMatchObject({
      code: "CF_LOGIN_FAILED",
    });
  });

  it("redacts auth credentials from CF command failures", async () => {
    process.env["CF_DEBUGGER_TEST_AUTH_FAILURES"] = "3";
    const password = "phase2-sensitive-value";

    await expect(cfAuth("user@example.com", password, context)).rejects.toMatchObject({
      code: "CF_CLI_FAILED",
      message: expect.not.stringContaining(password),
      stderr: expect.not.stringContaining(password),
    });
  }, 10_000);

  it("maps app not-found output to false and rethrows unrelated app errors", async () => {
    await expect(cfAppExists("missing-app", context)).resolves.toBe(false);
    await expect(cfAppExists("broken-app", context)).rejects.toMatchObject({
      code: "CF_CLI_FAILED",
    });
  });
});
