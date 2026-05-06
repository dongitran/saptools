import { expect, test } from "@playwright/test";

import type { LogpointEvent } from "../../src/logpoint/events.js";

import { ensureCliBuilt, runCli, spawnFixture } from "./helpers.js";

test("log streams JSON Lines from a logpoint and stops on duration", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "log",
        "--port",
        fixture.port.toString(),
        "--at",
        "fixtures/sample-app.mjs:14",
        "--expr",
        "user.id",
        "--duration",
        "1",
      ],
      30_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const events = lines.map((line) => JSON.parse(line) as LogpointEvent);
    for (const event of events) {
      expect(event.at).toBe("fixtures/sample-app.mjs:14");
      expect(typeof event.ts).toBe("string");
      expect(event.value !== undefined || event.error !== undefined).toBe(true);
    }
    // Trailer goes to stderr in JSON mode for agent consumption.
    expect(result.stderr).toContain('"stopped":"duration"');
    const trailer = JSON.parse(result.stderr.trim().split("\n").pop() ?? "{}") as {
      stopped: string;
      emitted: number;
    };
    expect(trailer.stopped).toBe("duration");
    expect(trailer.emitted).toBe(events.length);
  } finally {
    await fixture.close();
  }
});

test("log --expr with a syntax error fails fast with INVALID_EXPRESSION", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const startedAt = Date.now();
    const result = await runCli(
      [
        "log",
        "--port",
        fixture.port.toString(),
        "--at",
        "fixtures/sample-app.mjs:14",
        "--expr",
        "1 +)",
        "--duration",
        "30",
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

test("log --max-events stops the stream after N events with stoppedReason='max-events'", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "log",
        "--port",
        fixture.port.toString(),
        "--at",
        "fixtures/sample-app.mjs:14",
        "--expr",
        "user.id",
        "--max-events",
        "3",
      ],
      30_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(3);
    expect(result.stderr).toContain('"stopped":"max-events"');
  } finally {
    await fixture.close();
  }
});

test("log --condition gates emission to predicate=true hits", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "log",
        "--port",
        fixture.port.toString(),
        "--at",
        "fixtures/sample-app.mjs:14",
        "--expr",
        "counter",
        "--condition",
        "counter % 2 === 0",
        "--max-events",
        "2",
      ],
      30_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const event = JSON.parse(line) as LogpointEvent;
      const value = event.value === undefined ? -1 : Number.parseInt(event.value, 10);
      expect(value).toBeGreaterThan(0);
      expect(value % 2).toBe(0);
    }
  } finally {
    await fixture.close();
  }
});

test("log --hit-count starts emitting at the Nth hit", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "log",
        "--port",
        fixture.port.toString(),
        "--at",
        "fixtures/sample-app.mjs:14",
        "--expr",
        "counter",
        "--hit-count",
        "5",
        "--max-events",
        "1",
      ],
      30_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0] ?? "{}") as LogpointEvent;
    const value = event.value === undefined ? -1 : Number.parseInt(event.value, 10);
    expect(value).toBeGreaterThanOrEqual(5);
  } finally {
    await fixture.close();
  }
});

test("log --condition with a syntax error fails fast with INVALID_EXPRESSION", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const startedAt = Date.now();
    const result = await runCli(
      [
        "log",
        "--port",
        fixture.port.toString(),
        "--at",
        "fixtures/sample-app.mjs:14",
        "--expr",
        "user.id",
        "--condition",
        "1 +)",
        "--duration",
        "30",
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

test("log expression that throws emits structured error events without crashing", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      [
        "log",
        "--port",
        fixture.port.toString(),
        "--at",
        "fixtures/sample-app.mjs:14",
        "--expr",
        "userDoesNotExist.field",
        "--duration",
        "1",
      ],
      30_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const events = lines.map((line) => JSON.parse(line) as LogpointEvent);
    expect(events.length).toBeGreaterThan(0);
    // All events should be tagged as error since the expression always throws.
    for (const event of events) {
      expect(event.error).toBeDefined();
      expect(event.value).toBeUndefined();
    }
  } finally {
    await fixture.close();
  }
});
