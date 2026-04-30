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
    expect(typeof parsed.pausedDurationMs).toBe("number");
    expect(parsed.pausedDurationMs).toBeGreaterThanOrEqual(0);
    expect("captureDurationMs" in parsed).toBe(false);
    expect(parsed.hitBreakpoints.length).toBeGreaterThan(0);
    expect(parsed.topFrame).toBeDefined();
    expect(parsed.topFrame?.line).toBe(14);
    expect(parsed.topFrame === undefined ? false : "scopes" in parsed.topFrame).toBe(false);

    const captures = Object.fromEntries(
      parsed.captures.map((c) => [c.expression, c.value ?? c.error ?? null]),
    );
    expect(captures["user.id"]).toBeDefined();
    expect(captures["accumulator.length"]).toBe("4");
  } finally {
    await fixture.close();
  }
});

test("snapshot --include-scopes captures paused scope variables", async () => {
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
        "user.id",
        "--timeout",
        "10",
        "--include-scopes",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    expect(parsed.topFrame?.scopes).toBeDefined();
    expect(parsed.topFrame?.scopes?.length).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});

test("snapshot materializes object captures as readable JSON strings", async () => {
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
        "payload",
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    const payloadCapture = parsed.captures.find((entry) => entry.expression === "payload");
    expect(payloadCapture?.value).toBeDefined();
    expect(payloadCapture?.value).not.toBe("Object");
    const payload = JSON.parse(payloadCapture?.value ?? "{}") as { id?: number; name?: string };
    expect(typeof payload.id).toBe("number");
    expect(typeof payload.name).toBe("string");
  } finally {
    await fixture.close();
  }
});

test("snapshot keeps nested commas inside a single capture expression", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const expression = "JSON.stringify({ id: user.id, steps: accumulator.length })";
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--capture",
        expression,
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    const capture = parsed.captures.find((entry) => entry.expression === expression);
    expect(capture?.error).toBeUndefined();
    expect(capture?.value).toBeDefined();
    const encoded = JSON.parse(capture?.value ?? "\"\"") as string;
    const decoded = JSON.parse(encoded) as { id?: number; steps?: number };
    expect(typeof decoded.id).toBe("number");
    expect(decoded.steps).toBe(4);
  } finally {
    await fixture.close();
  }
});

test("snapshot --keep-paused human output does not claim a durable pause", async () => {
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
        "--timeout",
        "10",
        "--no-json",
        "--keep-paused",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("paused:  unknown");
    expect(result.stdout).not.toContain("still paused");
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

test("snapshot --condition with a syntax error surfaces INVALID_EXPRESSION fast (no timeout wait)", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const startedAt = Date.now();
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--condition",
        "1 +)",
        "--timeout",
        "30",
      ],
      30_000,
    );
    const elapsed = Date.now() - startedAt;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("INVALID_EXPRESSION");
    // Must fail fast — should NOT wait for the 30s timeout.
    expect(elapsed).toBeLessThan(5_000);
  } finally {
    await fixture.close();
  }
});

test("snapshot reports a dedicated timeout when the target stays paused elsewhere", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ env: { SAMPLE_DEBUG_PAUSE: "1" } });
  try {
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--timeout",
        "2",
      ],
      30_000,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("waiting for it to resume");
    expect(result.stderr).toContain("UNRELATED_PAUSE_TIMEOUT");
    expect(result.stderr).not.toContain("BREAKPOINT_NOT_HIT");
  } finally {
    await fixture.close();
  }
});

test("snapshot can fail immediately on unmatched pauses in strict mode", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ env: { SAMPLE_DEBUG_PAUSE: "1" } });
  try {
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--timeout",
        "10",
        "--fail-on-unmatched-pause",
      ],
      30_000,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("UNRELATED_PAUSE");
    expect(result.stderr).not.toContain("UNRELATED_PAUSE_TIMEOUT");
  } finally {
    await fixture.close();
  }
});

test("snapshot warns to stderr when the breakpoint did not bind to any loaded script", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "no-such-file.mjs:1",
        "--timeout",
        "2",
      ],
      30_000,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("did not bind to any loaded script");
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
