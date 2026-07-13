import { expect, test } from "@playwright/test";

import type { SnapshotResult } from "../../src/types.js";

import { ensureCliBuilt, runCli, spawnFixture, STACK_FIXTURE_PATH } from "./helpers.js";

test("User can capture a snapshot and see ordered progress", async () => {
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
    expect(parsed.topFrame?.url).toContain("sample-app.mjs");
    expect(parsed.topFrame?.line).toBe(14);
    expect(parsed.topFrame === undefined ? false : "scopes" in parsed.topFrame).toBe(false);

    const captures = Object.fromEntries(
      parsed.captures.map((c) => [c.expression, c.value ?? c.error ?? null]),
    );
    expect(captures["user.id"]).toBeDefined();
    expect(captures["accumulator.length"]).toBe("4");
    expect(parsed.captures.find((capture) => capture.expression === "user.id")?.mutationRisk).toBeUndefined();

    const expectedProgress = [
      `Connecting to the Node.js inspector at 127.0.0.1:${fixture.port.toString()}...`,
      "Inspector session is ready.",
      "Setting 1 breakpoint...",
      "Breakpoint setup complete: 1 resolved location.",
      "Waiting up to 10s for a breakpoint hit...",
      "Breakpoint hit; capturing 2 expressions...",
      "Snapshot captured; resuming the target...",
      "Target resumed.",
      "Closing the inspector session...",
      "Inspector session closed.",
      "Snapshot complete.",
    ];
    let previousIndex = -1;
    for (const message of expectedProgress) {
      const currentIndex = result.stderr.indexOf(`[cf-inspector] ${message}`);
      expect(currentIndex, `missing or out-of-order progress: ${message}`).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }
  } finally {
    await fixture.close();
  }
});

test("User can suppress snapshot progress with --quiet", async () => {
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
        "--quiet",
      ],
      45_000,
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect(() => JSON.parse(result.stdout) as SnapshotResult).not.toThrow();
    expect(result.stderr).not.toContain("[cf-inspector]");
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

test("snapshot exposes sensitive-looking values by default", async () => {
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
        "user",
        "--timeout",
        "10",
        "--include-scopes",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    const userCapture = parsed.captures.find((entry) => entry.expression === "user");
    const capturedUser = JSON.parse(userCapture?.value ?? "{}") as { token?: string };
    expect(capturedUser.token).toBe("fixture-token");

    const localScope = parsed.topFrame?.scopes?.find((scope) => scope.type === "local");
    const userVar = localScope?.variables.find((variable) => variable.name === "user");
    expect(userVar?.children?.find((child) => child.name === "token")?.value).toBe("\"fixture-token\"");
  } finally {
    await fixture.close();
  }
});

test("snapshot blocks side-effecting captures by default without mutating live state", async () => {
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
        "counter = 999, accumulator.push('mutated'), mutationProbe(), counter, accumulator.length",
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    for (const expression of ["counter = 999", "accumulator.push('mutated')", "mutationProbe()"]) {
      expect(parsed.captures.find((capture) => capture.expression === expression)).toMatchObject({
        blocked: true,
        mutationRisk: true,
        error: expect.stringContaining("MUTATION_NOT_ALLOWED") as unknown as string,
      });
    }
    expect(parsed.captures.find((capture) => capture.expression === "counter")?.value).not.toBe("999");
    expect(parsed.captures.find((capture) => capture.expression === "accumulator.length")?.value).toBe("4");
  } finally {
    await fixture.close();
  }
});

test("snapshot --allow-mutation runs and annotates a mutation", async () => {
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
        "counter = 999, accumulator.push('mutated')",
        "--allow-mutation",
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    expect(parsed.captures[0]).toMatchObject({
      expression: "counter = 999",
      value: "999",
      mutationRisk: true,
    });
    expect(parsed.captures[1]).toMatchObject({
      expression: "accumulator.push('mutated')",
      value: "5",
      mutationRisk: true,
    });
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
        'payload, "x".repeat(5000)',
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
    const largeCapture = parsed.captures.find((entry) => {
      return entry.expression === '"x".repeat(5000)';
    });
    expect(largeCapture?.value).toHaveLength(5_002);
    expect(largeCapture?.truncated).toBeUndefined();
    expect(largeCapture?.originalLength).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

test("snapshot honors a custom max value length", async () => {
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
        "--max-value-length",
        "30",
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    const payloadCapture = parsed.captures.find((entry) => entry.expression === "payload");
    expect(payloadCapture?.value).toHaveLength(30);
    expect(payloadCapture?.value?.endsWith("...")).toBe(false);
    expect(payloadCapture?.truncated).toBe(true);
    expect(payloadCapture?.originalLength).toBeGreaterThan(30);
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
    expect(result.stderr).toContain("no hit was observed");
    expect(result.stderr).toContain("worker isolate");
    expect(result.stderr).toContain("list-targets");
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

test("snapshot --hit-count waits until the breakpoint has been hit N times", async () => {
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
        "--hit-count",
        "5",
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
    // The counter is incremented one line before the BP marker, so the first
    // pause that satisfies hit-count=5 has counter >= 5.
    expect(counterValue).toBeGreaterThanOrEqual(5);
  } finally {
    await fixture.close();
  }
});

test("snapshot --hit-count rejects a non-positive value", async () => {
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
        "--hit-count",
        "0",
      ],
      15_000,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("INVALID_ARGUMENT");
  } finally {
    await fixture.close();
  }
});

test("snapshot --stack-depth captures multiple frames and runs --stack-captures per frame", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: STACK_FIXTURE_PATH });
  try {
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-stack.mjs:13",
        "--stack-depth",
        "3",
        "--stack-captures",
        "tagged.id, payload.id, session.traceId",
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    expect(parsed.stack).toBeDefined();
    expect(parsed.stack?.length).toBeGreaterThanOrEqual(3);
    const fnNames = parsed.stack?.map((frame) => frame.functionName) ?? [];
    expect(fnNames[0]).toBe("deeperHelper");
    expect(fnNames[1]).toBe("helper");
    expect(fnNames[2]).toBe("entry");
    const deepCaptures = parsed.stack?.[0]?.captures ?? [];
    const deeperTaggedId = deepCaptures.find((c) => c.expression === "tagged.id");
    expect(deeperTaggedId?.value).toBeDefined();
    const helperCaptures = parsed.stack?.[1]?.captures ?? [];
    const helperPayloadId = helperCaptures.find((c) => c.expression === "payload.id");
    expect(helperPayloadId?.value).toBeDefined();
    const entryCaptures = parsed.stack?.[2]?.captures ?? [];
    const entryTraceId = entryCaptures.find((c) => c.expression === "session.traceId");
    expect(entryTraceId?.value).toBeDefined();
  } finally {
    await fixture.close();
  }
});

test("snapshot applies the mutation guard to --stack-captures", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: STACK_FIXTURE_PATH });
  try {
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-stack.mjs:13",
        "--stack-depth",
        "2",
        "--stack-captures",
        "tagged.id = 999",
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect((JSON.parse(result.stdout) as SnapshotResult).stack?.[0]?.captures?.[0]).toMatchObject({
      blocked: true,
      mutationRisk: true,
      error: expect.stringContaining("MUTATION_NOT_ALLOWED") as unknown as string,
    });
  } finally {
    await fixture.close();
  }
});

test("snapshot --allow-mutation runs and annotates a stack capture mutation", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture({ fixturePath: STACK_FIXTURE_PATH });
  try {
    const result = await runCli(
      [
        "snapshot",
        "--port",
        fixture.port.toString(),
        "--bp",
        "fixtures/sample-stack.mjs:13",
        "--stack-depth",
        "2",
        "--stack-captures",
        "tagged.id = 999",
        "--allow-mutation",
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect((JSON.parse(result.stdout) as SnapshotResult).stack?.[0]?.captures?.[0]).toMatchObject({
      expression: "tagged.id = 999",
      value: "999",
      mutationRisk: true,
    });
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

test("capture command help includes mutation controls", async () => {
  ensureCliBuilt();
  for (const command of ["snapshot", "watch", "exception"]) {
    const result = await runCli([command, "--help"], 15_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--allow-mutation");
    expect(result.stdout).toContain("--max-value-length <chars>");
    expect(result.stdout).toContain(command === "watch" ? "default: 4096" : "default: 131072");
    if (command === "snapshot") {
      expect(result.stdout).toContain("--setup-eval <expr>");
    }
  }
});

test("capture-free commands do not expose --allow-mutation", async () => {
  ensureCliBuilt();
  for (const command of ["eval", "log", "list-scripts", "list-targets", "attach"]) {
    const result = await runCli([command, "--help"], 15_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("--allow-mutation");
    if (command === "log") {
      expect(result.stdout).toContain("--max-value-length <chars>");
      expect(result.stdout).toContain("default: 4096");
    }
  }
});

test("snapshot rejects mutation-shaped native conditions without opt-in", async () => {
  ensureCliBuilt();
  const result = await runCli(
    [
      "snapshot",
      "--port",
      "9229",
      "--bp",
      "fixtures/sample-app.mjs:14",
      "--condition",
      "counter = 999",
    ],
    15_000,
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("MUTATION_NOT_ALLOWED");
  expect(result.stderr).toContain("--allow-mutation");
  expect(result.stderr).not.toContain("Connecting to the Node.js inspector");
});

test("snapshot setup eval can initialize a global before breakpoint capture", async () => {
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
        "--setup-eval",
        "globalThis.__cfInspectorSetup = { value: 41 }",
        "--setup-eval",
        "globalThis.__cfInspectorSetup.value += 1",
        "--capture",
        "globalThis.__cfInspectorSetup.value",
        "--timeout",
        "10",
      ],
      45_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as SnapshotResult;
    expect(parsed.captures.find((c) => c.expression === "globalThis.__cfInspectorSetup.value")?.value).toBe("42");
    expect(result.stderr).toContain("Running 2 setup evaluations");
    expect(result.stderr).toContain("snapshot --setup-eval");
  } finally {
    await fixture.close();
  }
});

test("snapshot setup eval failure returns SETUP_EVAL_FAILED", async () => {
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
        "--setup-eval",
        "throw new Error('setup eval exploded')",
        "--timeout",
        "10",
      ],
      30_000,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("SETUP_EVAL_FAILED");
    expect(result.stderr).toContain("setup eval exploded");
    expect(result.stderr).not.toContain("Breakpoint setup complete");
  } finally {
    await fixture.close();
  }
});
