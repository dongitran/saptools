import { expect, test } from "@playwright/test";

import type { SnapshotResult } from "../../src/types.js";

import { ensureCliBuilt, runCli, spawnFixture, STACK_FIXTURE_PATH } from "./helpers.js";

test("exception captures uncaught exception with materialized exception value", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({
    fixturePath: STACK_FIXTURE_PATH,
    env: { STACK_THROW_MODE: "uncaught", STACK_THROW_AT: "1" },
  });
  try {
    const result = await runCli(
      [
        "exception",
        "--port",
        fixture.port.toString(),
        "--type",
        "uncaught",
        "--timeout",
        "5",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    expect(parsed.reason).toBe("exception");
    expect(parsed.exception).toBeDefined();
    const exceptionValue = parsed.exception?.value ?? "";
    expect(exceptionValue.length).toBeGreaterThan(0);
    expect(parsed.exception?.description ?? exceptionValue).toContain("stack-fixture uncaught");
    expect(typeof parsed.pausedDurationMs).toBe("number");
  } finally {
    await fixture.close();
  }
});

test("exception with --type all also pauses on caught exceptions", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({
    fixturePath: STACK_FIXTURE_PATH,
    env: { STACK_THROW_MODE: "caught" },
  });
  try {
    const result = await runCli(
      [
        "exception",
        "--port",
        fixture.port.toString(),
        "--type",
        "all",
        "--timeout",
        "5",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    expect(parsed.reason).toBe("exception");
    expect(parsed.exception).toBeDefined();
    expect(parsed.exception?.description ?? parsed.exception?.value ?? "").toContain("stack-fixture caught");
  } finally {
    await fixture.close();
  }
});

test("exception rejects an invalid --type", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: STACK_FIXTURE_PATH });
  try {
    const result = await runCli(
      [
        "exception",
        "--port",
        fixture.port.toString(),
        "--type",
        "everything",
      ],
      15_000,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("INVALID_PAUSE_TYPE");
  } finally {
    await fixture.close();
  }
});

test("exception times out cleanly when nothing throws", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: STACK_FIXTURE_PATH });
  try {
    const result = await runCli(
      [
        "exception",
        "--port",
        fixture.port.toString(),
        "--type",
        "uncaught",
        "--timeout",
        "1",
      ],
      30_000,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BREAKPOINT_NOT_HIT");
  } finally {
    await fixture.close();
  }
});

test("exception captures stack with --stack-depth and per-frame captures", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({
    fixturePath: STACK_FIXTURE_PATH,
    env: { STACK_THROW_MODE: "uncaught", STACK_THROW_AT: "1" },
  });
  try {
    const result = await runCli(
      [
        "exception",
        "--port",
        fixture.port.toString(),
        "--type",
        "uncaught",
        "--stack-depth",
        "2",
        "--stack-captures",
        "session.id, payload.id",
        "--timeout",
        "5",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    expect(parsed.stack?.length).toBeGreaterThanOrEqual(2);
    const top = parsed.stack?.[0];
    expect(top?.functionName).toBe("entry");
    const idCapture = top?.captures?.find((c) => c.expression === "session.id");
    expect(idCapture?.value).toBeDefined();
  } finally {
    await fixture.close();
  }
});
