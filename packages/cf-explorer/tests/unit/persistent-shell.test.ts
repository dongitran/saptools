import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { PersistentShell } from "../../src/broker/persistent-shell.js";

const RESPONDER_SCRIPT = [
  "process.stdin.setEncoding('utf8');",
  "let buffer = '';",
  "let count = 0;",
  "function respond(id, body, code = 0) {",
  "  process.stdout.write(`__CF_EXPLORER_START_${id}__\\n`);",
  "  process.stdout.write(body);",
  "  process.stdout.write(`__CF_EXPLORER_END_${id}__:${code}\\n`);",
  "}",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const match = /__CF_EXPLORER_START_([a-zA-Z0-9]+)__/.exec(buffer);",
  "  if (!match) return;",
  "  const id = match[1];",
  "  if (!buffer.includes(`__CF_EXPLORER_END_${id}__`)) return;",
  "  const command = buffer;",
  "  buffer = '';",
  "  count += 1;",
  "  if (command.includes('exit-seven')) { respond(id, '', 7); return; }",
  "  if (command.includes('malformed-frame')) {",
  "    process.stdout.write(`__CF_EXPLORER_START_${id}__\\n`);",
  "    process.stdout.write(`__CF_EXPLORER_END_${id}__:nope\\n`);",
  "    return;",
  "  }",
  "  if (command.includes('large-output')) { process.stdout.write('x'.repeat(128)); return; }",
  "  if (command.includes('partial-frame')) {",
  "    process.stdout.write(`__CF_EXPLORER_START_${id}__\\n`);",
  "    setTimeout(() => {",
  "      process.stdout.write('partial-ok\\n');",
  "      process.stdout.write(`__CF_EXPLORER_END_${id}__:0\\n`);",
  "    }, 20);",
  "    return;",
  "  }",
  "  if (command.includes('first')) { setTimeout(() => respond(id, `first:${count}\\n`), 25); return; }",
  "  if (command.includes('second')) { respond(id, `second:${count}\\n`); return; }",
  "  respond(id, `ok:${count}\\n`);",
  "});",
  "setInterval(() => {}, 1000);",
].join("\n");

const IDLE_SCRIPT = "process.stdin.resume(); setInterval(() => {}, 1000);";
const CLOSED_SCRIPT = [
  "process.stdin.resume();",
  "setTimeout(() => process.stderr.write('closed by peer\\n'), 10);",
  "setInterval(() => {}, 1000);",
].join("\n");

describe("persistent shell", () => {
  const children: ChildProcessWithoutNullStreams[] = [];

  afterEach(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("close", () => {
          resolve();
        });
      });
    }));
    children.length = 0;
  });

  it("executes a wrapped command and returns bounded stdout", async () => {
    const shell = createShell(RESPONDER_SCRIPT);

    const result = await shell.execute("printf ok");

    expect(result.stdout).toBe("ok:1\n");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.truncated).toBe(false);
  });

  it("waits for a complete frame before resolving", async () => {
    const shell = createShell(RESPONDER_SCRIPT);

    await expect(shell.execute("printf partial-frame")).resolves.toMatchObject({
      stdout: "partial-ok\n",
    });
  });

  it("exposes liveness and stops the child process", async () => {
    const child = spawnChild(IDLE_SCRIPT);
    const shell = new PersistentShell(child);

    expect(shell.isAlive).toBe(true);
    shell.stop();
    await new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    });
    expect(child.killed).toBe(true);
    expect(shell.isAlive).toBe(false);
  });

  it("serializes concurrent commands through one shell queue", async () => {
    const shell = createShell(RESPONDER_SCRIPT);

    const first = shell.execute("printf first");
    const second = shell.execute("printf second");

    await expect(first).resolves.toMatchObject({ stdout: "first:1\n" });
    await expect(second).resolves.toMatchObject({ stdout: "second:2\n" });
  });

  it("rejects output that exceeds the configured byte limit", async () => {
    const shell = createShell(RESPONDER_SCRIPT);

    await expect(shell.execute("printf large-output", 30_000, 16))
      .rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
  });

  it("rejects timed out commands and terminates the child", async () => {
    const child = spawnChild(IDLE_SCRIPT);
    const shell = new PersistentShell(child);

    await expect(shell.execute("printf slow", 10))
      .rejects.toMatchObject({ code: "SESSION_RECOVERY_FAILED" });
    await sleep(20);
    expect(child.killed).toBe(true);
  });

  it("rejects non-zero remote protocol frames", async () => {
    const shell = createShell(RESPONDER_SCRIPT);

    await expect(shell.execute("printf exit-seven"))
      .rejects.toMatchObject({ code: "SESSION_PROTOCOL_ERROR" });
  });

  it("rejects malformed remote protocol frames", async () => {
    const shell = createShell(RESPONDER_SCRIPT);

    await expect(shell.execute("printf malformed-frame"))
      .rejects.toMatchObject({ code: "SESSION_PROTOCOL_ERROR" });
  });

  it("marks the shell stale when the persistent stream closes", async () => {
    let exitReason = "";
    const shell = createShell(CLOSED_SCRIPT, (reason) => {
      exitReason = reason;
    });

    await expect.poll(() => exitReason).toBe("Persistent SSH shell closed.");
    await expect(shell.execute("printf ok")).rejects.toMatchObject({ code: "SESSION_STALE" });
  });

  it("ignores exit callback failures", async () => {
    const shell = createShell(CLOSED_SCRIPT, () => {
      throw new Error("listener failed");
    });

    await expect.poll(() => shell.isAlive).toBe(false);
    await expect(shell.execute("printf ok")).rejects.toMatchObject({ code: "SESSION_STALE" });
  });

  function createShell(script: string, onExit?: (reason: string) => void): PersistentShell {
    return new PersistentShell(spawnChild(script), onExit);
  }

  function spawnChild(script: string): ChildProcessWithoutNullStreams {
    const child = spawn(process.execPath, ["-e", script]);
    children.push(child);
    return child;
  }
});
