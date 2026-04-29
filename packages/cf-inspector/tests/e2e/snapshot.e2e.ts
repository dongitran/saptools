import { expect, test } from "@playwright/test";

import type { SnapshotResult } from "../../src/types.js";

import { ensureCliBuilt, runCli, spawnFixture } from "./helpers.js";

test("snapshot captures the paused frame on the marker line", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--capture",
        "user.id, accumulator.length",
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const stdout = result.stdout.trim();
    expect(stdout.startsWith("{")).toBe(true);
    const parsed = JSON.parse(stdout) as SnapshotResult;
    expect(parsed.reason).toBe("other");
    expect(parsed.hitBreakpoints.length).toBeGreaterThan(0);
    expect(parsed.topFrame).toBeDefined();

    const captures = Object.fromEntries(
      parsed.captures.map((c) => [c.expression, c.value ?? c.error ?? null]),
    );
    expect(captures["user.id"]).toBeDefined();
    expect(captures["accumulator.length"]).toBe("4");
  } finally {
    await fixture.close();
  }
});

test("snapshot rejects an invalid breakpoint spec", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "missing-line.ts",
      ],
      15_000,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("INVALID_BREAKPOINT");
  } finally {
    await fixture.close();
  }
});

test("snapshot --condition only pauses when the predicate evaluates truthy", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    // counter starts at 0 and increments every 200ms; the condition only matches
    // once it exceeds 5. With timeout 10s the BP MUST hit at least once.
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--condition",
        "counter > 5",
        "--capture",
        "counter",
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    const counter = parsed.captures.find((c) => c.expression === "counter");
    expect(counter?.value).toBeDefined();
    const counterValue = Number.parseInt(counter?.value ?? "0", 10);
    // The condition is evaluated BEFORE the line increments counter, so the
    // first pause happens when counter == 6 (the first value > 5). Future runs
    // could pause later if the condition takes a few iterations to propagate;
    // the strict assertion is that counter is at least 6.
    expect(counterValue).toBeGreaterThanOrEqual(6);
  } finally {
    await fixture.close();
  }
});

test("snapshot --condition that never matches returns BREAKPOINT_NOT_HIT after timeout", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--condition",
        "counter < 0",
        "--timeout",
        "2",
      ],
      30_000,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BREAKPOINT_NOT_HIT");
  } finally {
    await fixture.close();
  }
});

test("snapshot accepts repeated --bp and captures the first hit (multi-bp)", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    // Two breakpoints inside handle(): line 7 (`const accumulator…`) hits
    // before line 14 on every invocation, so we should always capture line 7.
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:7",
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--capture",
        "payload.id",
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    expect(parsed.topFrame?.line).toBe(7);
    const payload = parsed.captures.find((c) => c.expression === "payload.id");
    expect(payload?.value).toBeDefined();
  } finally {
    await fixture.close();
  }
});
