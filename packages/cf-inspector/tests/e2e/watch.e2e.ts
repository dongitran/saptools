import { expect, test } from "@playwright/test";

import type { WatchEvent } from "../../src/types.js";

import { ensureCliBuilt, runCli, spawnFixture } from "./helpers.js";

interface WatchSummary {
  readonly stopped: string;
  readonly emitted: number;
}

function parseEvents(stdout: string): readonly WatchEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WatchEvent);
}

function parseTrailer(stderr: string): WatchSummary {
  const last = stderr.trim().split("\n").pop() ?? "{}";
  return JSON.parse(last) as WatchSummary;
}

test("watch streams a JSON-line snapshot for each hit and stops on duration", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "watch",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--capture",
        "user.id, accumulator.length",
        "--duration",
        "1",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const events = parseEvents(result.stdout);
    expect(events.length).toBeGreaterThan(1);
    for (const [index, event] of events.entries()) {
      expect(event.hit).toBe(index + 1);
      expect(event.reason).toBe("other");
      expect(event.captures.find((c) => c.expression === "user.id")?.value).toBeDefined();
      expect(event.captures.find((c) => c.expression === "accumulator.length")?.value).toBe("4");
    }
    const summary = parseTrailer(result.stderr);
    expect(summary.stopped).toBe("duration");
    expect(summary.emitted).toBe(events.length);
  } finally {
    await fixture.close();
  }
});

test("watch stops when --max-events is reached", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "watch",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--capture",
        "counter",
        "--max-events",
        "2",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const events = parseEvents(result.stdout);
    expect(events.length).toBe(2);
    const summary = parseTrailer(result.stderr);
    expect(summary.stopped).toBe("max-events");
    expect(summary.emitted).toBe(2);
  } finally {
    await fixture.close();
  }
});

test("watch --condition only emits when the predicate is truthy", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "watch",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--condition",
        "counter % 2 === 0",
        "--capture",
        "counter",
        "--max-events",
        "2",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const events = parseEvents(result.stdout);
    expect(events.length).toBe(2);
    for (const event of events) {
      const counterCapture = event.captures.find((c) => c.expression === "counter");
      const value = Number.parseInt(counterCapture?.value ?? "-1", 10);
      expect(value % 2).toBe(0);
    }
  } finally {
    await fixture.close();
  }
});

test("watch fails fast on an invalid condition expression", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const startedAt = Date.now();
    const result = await runCli(
      [
        "watch",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-app.mjs:14",
        "--condition",
        "1 +)",
        "--max-events",
        "1",
      ],
      30_000,
    );
    const elapsed = Date.now() - startedAt;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("INVALID_EXPRESSION");
    expect(elapsed).toBeLessThan(5_000);
  } finally {
    await fixture.close();
  }
});

test("watch requires at least one --bp", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "watch",
        "--port",
        fixture.port.toString(),
        "--max-events",
        "1",
      ],
      15_000,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("INVALID_BREAKPOINT");
  } finally {
    await fixture.close();
  }
});
