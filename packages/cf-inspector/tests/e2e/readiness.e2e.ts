import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import type { ArmedCommand, ArmedEvent } from "../../src/types.js";

import {
  CLI_PATH,
  ensureCliBuilt,
  type RunCliResult,
  spawnFixture,
  type SpawnedFixture,
} from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRIGGER_FIXTURE = resolve(HERE, "fixtures", "003-armed-trigger.mjs");

function markerLine(marker: string): number {
  const index = readFileSync(TRIGGER_FIXTURE, "utf8")
    .split("\n")
    .findIndex((line) => line.includes(marker));
  if (index < 0) {
    throw new Error(`Missing readiness fixture marker: ${marker}`);
  }
  return index + 1;
}

interface ArmedRunResult extends RunCliResult {
  readonly armed: ArmedEvent;
}

async function runAfterArmed(
  fixture: SpawnedFixture,
  args: readonly string[],
  trigger: "breakpoint" | "exception",
  timeoutMs = 20_000,
): Promise<ArmedRunResult> {
  const input = fixture.child.stdin;
  if (input === null) {
    throw new Error("Readiness fixture stdin is unavailable");
  }
  return await new Promise<ArmedRunResult>((resolveOnce, rejectOnce) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let stderrLines = "";
    let armed: ArmedEvent | undefined;
    let armedCount = 0;
    let settled = false;
    const finishError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectOnce(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finishError(
        new Error(`CLI did not finish after readiness within ${timeoutMs.toString()}ms: ${stderr}`),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      stderrLines += text;
      while (stderrLines.includes("\n")) {
        const newline = stderrLines.indexOf("\n");
        const line = stderrLines.slice(0, newline);
        stderrLines = stderrLines.slice(newline + 1);
        if (!line.startsWith("{")) {
          continue;
        }
        try {
          const candidate = JSON.parse(line) as Partial<ArmedEvent>;
          if (candidate.event === "breakpoint-armed") {
            armedCount += 1;
            if (armed === undefined) {
              armed = candidate as ArmedEvent;
              input.write(`${trigger}\n`);
            }
          }
        } catch {
          // Other stderr lines remain human-oriented and are not event JSON.
        }
      }
    });
    child.once("error", finishError);
    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      if (armed === undefined) {
        finishError(new Error(`CLI exited before emitting readiness: ${stderr}`));
        return;
      }
      if (armedCount !== 1) {
        finishError(
          new Error(`CLI emitted ${armedCount.toString()} readiness events instead of one: ${stderr}`),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveOnce({ stdout, stderr, exitCode: code ?? 0, armed });
    });
  });
}

async function withTriggeredFixture(
  run: (fixture: SpawnedFixture) => Promise<void>,
): Promise<void> {
  ensureCliBuilt();
  const fixture = await spawnFixture({
    fixturePath: TRIGGER_FIXTURE,
    readyText: "armed-trigger ready",
    pipeStdin: true,
  });
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

function expectCommonArmedEvent(
  event: ArmedEvent,
  command: ArmedCommand,
  timeoutMs: number | null,
): void {
  expect(event).toMatchObject({
    event: "breakpoint-armed",
    schemaVersion: 1,
    command,
    sessions: 1,
    timeoutMs,
  });
}

test("snapshot emits readiness after binding and captures a subsequent external trigger", async () => {
  await withTriggeredFixture(async (fixture) => {
    const result = await runAfterArmed(fixture, [
      "snapshot",
      "--port", fixture.port.toString(),
      "--main-only",
      "--bp", `fixtures/003-armed-trigger.mjs:${markerLine("cf-inspector-armed-breakpoint").toString()}`,
      "--capture", "triggerState.count",
      "--timeout", "5",
      "--quiet",
      "--ready-event",
    ], "breakpoint");

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expectCommonArmedEvent(result.armed, "snapshot", 5_000);
    expect(result.armed.resolvedLocations).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      captures: [{ expression: "triggerState.count", value: "0" }],
    });
  });
});

test("watch emits the same readiness contract before its first external hit", async () => {
  await withTriggeredFixture(async (fixture) => {
    const result = await runAfterArmed(fixture, [
      "watch",
      "--port", fixture.port.toString(),
      "--main-only",
      "--bp", `fixtures/003-armed-trigger.mjs:${markerLine("cf-inspector-armed-breakpoint").toString()}`,
      "--capture", "triggerState.count",
      "--max-events", "1",
      "--timeout", "5",
      "--ready-event",
    ], "breakpoint");

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expectCommonArmedEvent(result.armed, "watch", 5_000);
    expect(result.armed.resolvedLocations).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hit: 1 });
  });
});

test("log emits the same readiness contract before its first external event", async () => {
  await withTriggeredFixture(async (fixture) => {
    const result = await runAfterArmed(fixture, [
      "log",
      "--port", fixture.port.toString(),
      "--main-only",
      "--at", `fixtures/003-armed-trigger.mjs:${markerLine("cf-inspector-armed-breakpoint").toString()}`,
      "--expr", "triggerState.count",
      "--max-events", "1",
      "--ready-event",
    ], "breakpoint");

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expectCommonArmedEvent(result.armed, "log", null);
    expect(result.armed.resolvedLocations).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ value: "0" });
  });
});

test("exception emits the same readiness contract after pause-on-exception is active", async () => {
  await withTriggeredFixture(async (fixture) => {
    const result = await runAfterArmed(fixture, [
      "exception",
      "--port", fixture.port.toString(),
      "--main-only",
      "--type", "caught",
      "--timeout", "5",
      "--ready-event",
    ], "exception");

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expectCommonArmedEvent(result.armed, "exception", 5_000);
    expect(result.armed.resolvedLocations).toBeNull();
    expect(JSON.parse(result.stdout)).toMatchObject({
      reason: "exception",
      exception: { description: expect.stringContaining("cf-inspector-armed-exception") },
    });
  });
});
