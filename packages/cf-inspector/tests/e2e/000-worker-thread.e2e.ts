import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import type { ListedScriptInfo, SnapshotResult, WatchEvent } from "../../src/types.js";

import { ensureCliBuilt, runCli, spawnFixture } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_FIXTURE = resolve(HERE, "fixtures", "000-thread-host.mjs");
const WORKER_FIXTURE = resolve(HERE, "fixtures", "001-thread-worker.mjs");
const LATE_HOST_FIXTURE = resolve(HERE, "fixtures", "002-late-thread-host.mjs");

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

test("list-scripts aggregates main and worker scripts with unambiguous isolate tags", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: HOST_FIXTURE, readyText: "thread-host ready" });
  try {
    const result = await runCli([
      "list-scripts",
      "--port", fixture.port.toString(),
      "--filter", "000-thread-host\\.mjs|001-thread-worker\\.mjs",
    ], 30_000);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const scripts = JSON.parse(result.stdout) as readonly ListedScriptInfo[];
    expect(scripts.some((script) =>
      script.url.includes("000-thread-host.mjs") &&
      script.isolate.kind === "main")).toBe(true);
    expect(scripts.some((script) =>
      script.url.includes("001-thread-worker.mjs") &&
      script.isolate.kind === "worker" &&
      script.isolate.workerId.length > 0)).toBe(true);

    const mainOnly = await runCli([
      "list-scripts",
      "--port", fixture.port.toString(),
      "--main-only",
      "--filter", "000-thread-host\\.mjs|001-thread-worker\\.mjs",
      "--no-json",
    ], 30_000);
    expect(mainOnly.exitCode, `stderr: ${mainOnly.stderr}`).toBe(0);
    expect(mainOnly.stdout).toContain("000-thread-host.mjs\tmain");
    expect(mainOnly.stdout).not.toContain("001-thread-worker.mjs");
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

test("User can snapshot worker-local state without selecting a worker", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: HOST_FIXTURE, readyText: "thread-host ready" });
  const breakpoint = `fixtures/001-thread-worker.mjs:${markerLine(WORKER_FIXTURE, "cf-inspector-worker-breakpoint").toString()}`;
  try {
    const result = await runCli([
      "snapshot", "--port", fixture.port.toString(), "--bp", breakpoint,
      "--capture", "workerLocal.threadLabel", "--timeout", "10",
    ], 45_000);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const snapshot = JSON.parse(result.stdout) as SnapshotResult;
    expect(snapshot.isolate).toMatchObject({ kind: "worker", workerId: expect.any(String) as unknown as string });
    expect(captureValue(snapshot, "workerLocal.threadLabel")).toBe('"worker-session"');
  } finally {
    await fixture.close();
  }
});

test("A worker spawned after snapshot starts is armed and can win", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({
    fixturePath: LATE_HOST_FIXTURE,
    readyText: "late-thread-host ready",
  });
  const breakpoint = `fixtures/001-thread-worker.mjs:${markerLine(WORKER_FIXTURE, "cf-inspector-worker-breakpoint").toString()}`;
  try {
    const result = await runCli([
      "snapshot", "--port", fixture.port.toString(), "--bp", breakpoint,
      "--capture", "workerLocal.threadLabel", "--timeout", "10",
    ], 45_000);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect((JSON.parse(result.stdout) as SnapshotResult).isolate).toMatchObject({
      kind: "worker",
      workerId: expect.any(String) as unknown as string,
    });
  } finally {
    await fixture.close();
  }
});

test("User can pin a worker by stable workerId", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: HOST_FIXTURE, readyText: "thread-host ready" });
  const breakpoint = `fixtures/001-thread-worker.mjs:${markerLine(WORKER_FIXTURE, "cf-inspector-worker-breakpoint").toString()}`;
  try {
    const listed = await runCli(["list-targets", "--port", fixture.port.toString()], 30_000);
    const targets = JSON.parse(listed.stdout) as readonly ListedTarget[];
    const workerId = targets[0]?.workers[0]?.workerId;
    expect(workerId).toBeDefined();
    const result = await runCli([
      "snapshot", "--port", fixture.port.toString(), "--worker-id", workerId ?? "missing",
      "--bp", breakpoint, "--capture", "workerLocal.threadLabel", "--timeout", "10",
    ], 45_000);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect((JSON.parse(result.stdout) as SnapshotResult).isolate).toEqual({ kind: "worker", workerId });

    const missing = await runCli([
      "snapshot", "--port", fixture.port.toString(), "--worker-id", "not-attached",
      "--bp", breakpoint, "--timeout", "1",
    ], 15_000);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("workerId \"not-attached\"");
  } finally {
    await fixture.close();
  }
});

test("User can explicitly restrict snapshot to the main isolate", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: HOST_FIXTURE, readyText: "thread-host ready" });
  const breakpoint = `fixtures/000-thread-host.mjs:${markerLine(HOST_FIXTURE, "cf-inspector-main-breakpoint").toString()}`;
  try {
    const result = await runCli([
      "snapshot", "--port", fixture.port.toString(), "--main-only", "--bp", breakpoint,
      "--capture", "mainLocal.threadLabel", "--timeout", "10",
    ], 45_000);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect((JSON.parse(result.stdout) as SnapshotResult).isolate).toEqual({ kind: "main" });
  } finally {
    await fixture.close();
  }
});

test("User can precheck breakable and unbreakable worker lines", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: HOST_FIXTURE, readyText: "thread-host ready" });
  try {
    const breakable = await runCli([
      "check-breakpoint", "--port", fixture.port.toString(), "--bp",
      `fixtures/001-thread-worker.mjs:${markerLine(WORKER_FIXTURE, "cf-inspector-worker-breakpoint").toString()}`,
    ], 30_000);
    expect(breakable.exitCode, `stderr: ${breakable.stderr}`).toBe(0);
    expect(JSON.parse(breakable.stdout)).toMatchObject({ status: "breakable" });

    const unbreakable = await runCli([
      "check-breakpoint", "--port", fixture.port.toString(), "--bp",
      `fixtures/001-thread-worker.mjs:${markerLine(WORKER_FIXTURE, "function runWorkerTask").toString()}`,
    ], 30_000);
    expect(unbreakable.exitCode, `stderr: ${unbreakable.stderr}`).toBe(0);
    expect(JSON.parse(unbreakable.stdout)).toMatchObject({ status: "unbreakable" });

    const missing = await runCli([
      "check-breakpoint", "--port", fixture.port.toString(), "--bp", "fixtures/not-loaded.mjs:1",
    ], 30_000);
    expect(JSON.parse(missing.stdout)).toMatchObject({ status: "script-not-loaded" });
  } finally {
    await fixture.close();
  }
});

test("watch and log auto-attach to worker isolates", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: HOST_FIXTURE, readyText: "thread-host ready" });
  const breakpoint = `fixtures/001-thread-worker.mjs:${markerLine(WORKER_FIXTURE, "cf-inspector-worker-breakpoint").toString()}`;
  try {
    const watch = await runCli([
      "watch", "--port", fixture.port.toString(), "--bp", breakpoint,
      "--capture", "workerCounter", "--max-events", "2", "--timeout", "5",
    ], 30_000);
    expect(watch.exitCode, `stderr: ${watch.stderr}`).toBe(0);
    const watchEvents = watch.stdout.trim().split("\n").map((line) => JSON.parse(line) as WatchEvent);
    expect(watchEvents).toHaveLength(2);
    expect(watchEvents.every((event) => event.isolate?.kind === "worker")).toBe(true);

    const log = await runCli([
      "log", "--port", fixture.port.toString(), "--at", breakpoint,
      "--expr", "workerCounter", "--max-events", "2",
    ], 30_000);
    expect(log.exitCode, `stderr: ${log.stderr}`).toBe(0);
    const logEvents = log.stdout.trim().split("\n").map((line) => JSON.parse(line) as {
      readonly isolate?: { readonly kind: string };
    });
    expect(logEvents).toHaveLength(2);
    expect(logEvents.every((event) => event.isolate?.kind === "worker")).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("exception auto-attaches to a worker isolate", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: HOST_FIXTURE, readyText: "thread-host ready" });
  try {
    const result = await runCli([
      "exception", "--port", fixture.port.toString(), "--type", "all",
      "--capture", "workerCounter", "--timeout", "10",
    ], 30_000);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const snapshot = JSON.parse(result.stdout) as SnapshotResult;
    expect(snapshot.isolate?.kind).toBe("worker");
    expect(snapshot.exception?.description).toContain("worker-caught-exception");
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
    expect(help.stdout).toContain("--worker-id <id>");
    expect(help.stdout).toContain("--main-only");
  } finally {
    await fixture.close();
  }
});
