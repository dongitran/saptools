import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { CdpClient } from "../../src/cdp/client.js";
import { discoverInspectorTargets } from "../../src/inspector/discovery.js";
import { CfInspectorError } from "../../src/types.js";

import {
  CLI_PATH,
  ensureCliBuilt,
  runCli,
  spawnFixture,
} from "./helpers.js";

interface RunningCli {
  readonly child: ChildProcess;
  readonly result: Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

interface ListedTarget {
  readonly workers: readonly unknown[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_HOST_FIXTURE = resolve(HERE, "fixtures", "000-thread-host.mjs");

test("raw CDP clients demonstrate deterministic breakpoint collision and resume conflict", async () => {
  const fixture = await spawnFixture({
    fixturePath: WORKER_HOST_FIXTURE,
    readyText: "thread-host ready",
  });
  const clients: CdpClient[] = [];
  try {
    const target = (await discoverInspectorTargets("127.0.0.1", fixture.port, 5_000))[0];
    if (target === undefined) {
      throw new Error("Local inspector target was not discovered");
    }
    const first = await CdpClient.connect({ url: target.webSocketDebuggerUrl });
    const second = await CdpClient.connect({ url: target.webSocketDebuggerUrl });
    clients.push(first, second);
    await Promise.all(clients.map(async (client) => {
      await client.send("Runtime.enable");
      await client.send("Debugger.enable");
    }));
    const breakpoint = {
      lineNumber: 8,
      urlRegex: "000-thread-host\\.mjs$",
    };
    const [firstBreakpoint, secondBreakpoint] = await Promise.all(clients.map(async (client) =>
      await client.send<{ readonly breakpointId?: string }>("Debugger.setBreakpointByUrl", breakpoint)));
    expect(firstBreakpoint?.breakpointId).toBeDefined();
    expect(firstBreakpoint?.breakpointId).toBe(secondBreakpoint?.breakpointId);

    const pauses = clients.map(async (client) => await client.waitFor("Debugger.paused", { timeoutMs: 5_000 }));
    await Promise.all(pauses);
    await first.send("Debugger.resume");
    let resumeError: unknown;
    try {
      await second.send("Debugger.resume");
    } catch (error: unknown) {
      resumeError = error;
    }
    expect(resumeError).toBeInstanceOf(CfInspectorError);
    expect(resumeError).toMatchObject({ code: "CDP_REQUEST_FAILED" });
    expect((resumeError as CfInspectorError).detail).toContain('"code":-32000');
  } finally {
    for (const client of clients) {
      client.dispose();
    }
    await fixture.close();
  }
});

test("a live debug session excludes every other debugger-enabling command", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({
    fixturePath: WORKER_HOST_FIXTURE,
    readyText: "thread-host ready",
  });
  const stateRoot = await mkdtemp(join(tmpdir(), "cf-inspector-concurrency-e2e-"));
  const env = { CF_INSPECTOR_STATE_DIR: stateRoot };
  const first = spawnCli([
    "watch", "--port", fixture.port.toString(), "--bp", "fixtures/not-loaded.mjs:1",
    "--duration", "4", "--timeout", "1",
  ], env);
  try {
    await waitForLock(stateRoot);
    const commands: readonly (readonly string[])[] = [
      ["snapshot", "--port", fixture.port.toString(), "--bp", "fixtures/sample-app.mjs:14", "--timeout", "1"],
      ["watch", "--port", fixture.port.toString(), "--bp", "fixtures/sample-app.mjs:14", "--duration", "1"],
      ["exception", "--port", fixture.port.toString(), "--timeout", "1"],
      ["log", "--port", fixture.port.toString(), "--at", "fixtures/sample-app.mjs:14", "--expr", "counter", "--duration", "1"],
      ["check-breakpoint", "--port", fixture.port.toString(), "--bp", "fixtures/sample-app.mjs:14"],
      ["eval", "--port", fixture.port.toString(), "--expr", "process.pid"],
      ["list-scripts", "--port", fixture.port.toString()],
    ];
    const ownerPid = first.child.pid;
    if (ownerPid === undefined) {
      throw new Error("First CLI process did not expose a PID");
    }
    for (const command of commands) {
      const contender = await runCli(command, 10_000, env);
      expect(contender.exitCode, `${command[0] ?? "unknown"} stderr: ${contender.stderr}`).toBe(1);
      expect(contender.stderr).toContain("Error [TARGET_ALREADY_DEBUGGED]");
      expect(contender.stderr).toContain(`PID ${ownerPid.toString()}`);
    }
    const listed = await runCli(["list-targets", "--port", fixture.port.toString()], 10_000, env);
    expect(listed.exitCode, listed.stderr).toBe(0);
    const listedTargets = JSON.parse(listed.stdout) as readonly ListedTarget[];
    expect(listedTargets[0]?.workers).toHaveLength(1);
    const attached = await runCli(["attach", "--port", fixture.port.toString()], 10_000, env);
    expect(attached.exitCode, attached.stderr).toBe(0);
    expect(first.child.exitCode).toBeNull();
    const firstResult = await first.result;
    expect(firstResult.exitCode, firstResult.stderr).toBe(0);
    expect(firstResult.stderr).not.toContain("INSPECTOR_CONNECTION_FAILED");
    const afterRelease = await runCli(
      ["eval", "--port", fixture.port.toString(), "--expr", "process.pid"],
      10_000,
      env,
    );
    expect(afterRelease.exitCode, afterRelease.stderr).toBe(0);
  } finally {
    await stop(first.child);
    await fixture.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("normal errors release the target lock", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  const stateRoot = await mkdtemp(join(tmpdir(), "cf-inspector-error-release-e2e-"));
  const env = { CF_INSPECTOR_STATE_DIR: stateRoot };
  try {
    const failed = await runCli([
      "snapshot", "--port", fixture.port.toString(), "--bp", "fixtures/sample-app.mjs:14",
      "--condition", "(", "--timeout", "1",
    ], 10_000, env);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("INVALID_EXPRESSION");
    const replacement = await runCli(
      ["eval", "--port", fixture.port.toString(), "--expr", "process.pid"],
      10_000,
      env,
    );
    expect(replacement.exitCode, replacement.stderr).toBe(0);
  } finally {
    await fixture.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("SIGTERM cleanup releases the target lock", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  const stateRoot = await mkdtemp(join(tmpdir(), "cf-inspector-sigterm-lock-e2e-"));
  const env = { CF_INSPECTOR_STATE_DIR: stateRoot };
  const first = spawnCli([
    "watch", "--port", fixture.port.toString(), "--bp", "fixtures/not-loaded.mjs:1",
    "--duration", "30", "--timeout", "1",
  ], env);
  try {
    await waitForLock(stateRoot);
    first.child.kill("SIGTERM");
    await first.result;
    const replacement = await runCli(
      ["eval", "--port", fixture.port.toString(), "--expr", "process.pid"],
      10_000,
      env,
    );
    expect(replacement.exitCode, replacement.stderr).toBe(0);
  } finally {
    await stop(first.child);
    await fixture.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a SIGKILL-stale lock is reclaimed by the next real CLI session", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  const stateRoot = await mkdtemp(join(tmpdir(), "cf-inspector-stale-lock-e2e-"));
  const env = { CF_INSPECTOR_STATE_DIR: stateRoot };
  const first = spawnCli([
    "watch", "--port", fixture.port.toString(), "--bp", "fixtures/not-loaded.mjs:1",
    "--duration", "30", "--timeout", "1",
  ], env);
  try {
    await waitForLock(stateRoot);
    first.child.kill("SIGKILL");
    await first.result;
    const replacement = await runCli(
      ["eval", "--port", fixture.port.toString(), "--expr", "process.pid"],
      10_000,
      env,
    );
    expect(replacement.exitCode, replacement.stderr).toBe(0);
    expect(Number.isSafeInteger(JSON.parse(replacement.stdout).result.value)).toBe(true);
  } finally {
    await stop(first.child);
    await fixture.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

function spawnCli(args: readonly string[], env: Readonly<Record<string, string>>): RunningCli {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const result = new Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>(
    (resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        resolve({ exitCode: code ?? 0, stdout, stderr });
      });
    },
  );
  return { child, result };
}

async function waitForLock(stateRoot: string): Promise<void> {
  const directory = join(stateRoot, "cf-inspector", "locks");
  await expect.poll(async () => {
    return await readdir(directory).catch(() => []);
  }, { timeout: 10_000 }).not.toHaveLength(0);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
}
