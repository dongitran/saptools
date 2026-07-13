import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import type { SnapshotResult } from "../../src/types.js";

import { ensureCliBuilt, runCli, spawnFixture } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_FIXTURE = resolve(HERE, "fixtures", "000-thread-host.mjs");
const WORKER_FIXTURE = resolve(HERE, "fixtures", "001-thread-worker.mjs");

interface ListedWorker {
  readonly index: number;
  readonly workerId: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
}

interface ListedTarget {
  readonly index: number;
  readonly likelyWorker: boolean;
  readonly webSocketDebuggerUrl: string;
  readonly workers: readonly ListedWorker[];
}

function markerLine(path: string, marker: string): number {
  const index = readFileSync(path, "utf8")
    .split("\n")
    .findIndex((line) => line.includes(marker));
  if (index < 0) {
    throw new Error(`Missing fixture marker: ${marker}`);
  }
  return index + 1;
}

function captureValue(result: SnapshotResult, expression: string): string | undefined {
  return result.captures.find((capture) => capture.expression === expression)?.value;
}

test("User can discover a live worker under its raw inspector target", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: HOST_FIXTURE, readyText: "thread-host ready" });
  try {
    const result = await runCli(["list-targets", "--port", fixture.port.toString()], 30_000);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const targets = JSON.parse(result.stdout) as readonly ListedTarget[];
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ index: 0, likelyWorker: false });
    expect(typeof targets[0]?.webSocketDebuggerUrl).toBe("string");
    expect(targets[0]?.workers).toHaveLength(1);
    expect(targets[0]?.workers[0]).toMatchObject({
      index: 0,
      type: expect.stringMatching(/worker/i) as unknown as string,
    });
    expect(targets[0]?.workers[0]?.workerId.length).toBeGreaterThan(0);
    expect(targets[0]?.workers[0]?.title).toContain("cf-inspector-e2e-worker");
    expect(targets[0]?.workers[0]?.url).toContain("001-thread-worker.mjs");
    expect(result.stderr).toMatch(/1 (?:raw )?inspector target/i);
    expect(result.stderr).toMatch(/1 worker/i);
  } finally {
    await fixture.close();
  }
});

test("User can snapshot worker-local state and the worker resumes afterward", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: HOST_FIXTURE, readyText: "thread-host ready" });
  const breakpoint = `fixtures/001-thread-worker.mjs:${markerLine(WORKER_FIXTURE, "cf-inspector-worker-breakpoint").toString()}`;
  const args = [
    "snapshot", "--port", fixture.port.toString(), "--worker", "0", "--bp", breakpoint,
    "--capture", "workerLocal.threadLabel, workerCounter", "--timeout", "10",
  ];
  try {
    const first = await runCli(args, 45_000);
    expect(first.exitCode, `stderr: ${first.stderr}`).toBe(0);
    const firstSnapshot = JSON.parse(first.stdout) as SnapshotResult;
    expect(firstSnapshot.topFrame?.url).toContain("001-thread-worker.mjs");
    expect(captureValue(firstSnapshot, "workerLocal.threadLabel")).toBe('"worker-session"');
    const firstCounter = Number.parseInt(captureValue(firstSnapshot, "workerCounter") ?? "", 10);
    expect(Number.isFinite(firstCounter)).toBe(true);

    const second = await runCli(args, 45_000);
    expect(second.exitCode, `stderr: ${second.stderr}`).toBe(0);
    const secondSnapshot = JSON.parse(second.stdout) as SnapshotResult;
    const secondCounter = Number.parseInt(captureValue(secondSnapshot, "workerCounter") ?? "", 10);
    expect(secondCounter).toBeGreaterThan(firstCounter);
  } finally {
    await fixture.close();
  }
});

test("User can still select raw target zero and inspect the main isolate", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: HOST_FIXTURE, readyText: "thread-host ready" });
  const breakpoint = `fixtures/000-thread-host.mjs:${markerLine(HOST_FIXTURE, "cf-inspector-main-breakpoint").toString()}`;
  try {
    const result = await runCli([
      "snapshot", "--port", fixture.port.toString(), "--target", "0", "--bp", breakpoint,
      "--capture", "mainLocal.threadLabel", "--timeout", "10",
    ], 45_000);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const snapshot = JSON.parse(result.stdout) as SnapshotResult;
    expect(snapshot.topFrame?.url).toContain("000-thread-host.mjs");
    expect(captureValue(snapshot, "mainLocal.threadLabel")).toBe('"main-session"');

    const help = await runCli(["snapshot", "--help"], 15_000);
    expect(help.exitCode, `stderr: ${help.stderr}`).toBe(0);
    expect(help.stdout).toContain("--target <index>");
    expect(help.stdout).toContain("/json/list");
    expect(help.stdout).toContain("--worker <index>");
  } finally {
    await fixture.close();
  }
});
