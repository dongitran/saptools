import { expect, test } from "@playwright/test";

import { ensureCliBuilt, runCli, spawnFixture } from "./helpers.js";

test("eval prints a primitive value", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      ["eval", "--port", fixture.port.toString(), "--expr", "1 + 2", "--no-json"],
      30_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("3");
  } finally {
    await fixture.close();
  }
});


test("list-scripts filters script URLs", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      ["list-scripts", "--port", fixture.port.toString(), "--filter", "sample-app\\.mjs"],
      30_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as readonly { url?: string }[];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((entry) => entry.url?.includes("sample-app.mjs") === true)).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("list-targets emits selectable inspector target indices", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(["list-targets", "--port", fixture.port.toString()], 30_000);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as readonly { index?: number; webSocketDebuggerUrl?: string }[];
    expect(parsed[0]?.index).toBe(0);
    expect(typeof parsed[0]?.webSocketDebuggerUrl).toBe("string");
  } finally {
    await fixture.close();
  }
});

test("eval surfaces evaluation errors", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      ["eval", "--port", fixture.port.toString(), "--expr", "undefinedReference", "--no-json"],
      30_000,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("undefinedReference");
  } finally {
    await fixture.close();
  }
});

test("eval exits non-zero for JSON-mode evaluation errors", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      ["eval", "--port", fixture.port.toString(), "--expr", "undefinedReference"],
      30_000,
    );
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { exceptionDetails?: unknown };
    expect(parsed.exceptionDetails).toBeDefined();
  } finally {
    await fixture.close();
  }
});

test("attach reports the inspector version", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      ["attach", "--port", fixture.port.toString()],
      30_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as { browser?: string; protocolVersion?: string };
    expect(typeof parsed.browser).toBe("string");
    expect(typeof parsed.protocolVersion).toBe("string");
  } finally {
    await fixture.close();
  }
});

test("list-scripts emits at least one entry", async () => {
  ensureCliBuilt();
  const fixture = await spawnFixture();
  try {
    const result = await runCli(
      ["list-scripts", "--port", fixture.port.toString()],
      30_000,
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as readonly { url?: string }[];
    expect(Array.isArray(parsed)).toBe(true);
    const hasFixture = parsed.some((entry) => entry.url?.includes("sample-app.mjs") === true);
    expect(hasFixture).toBe(true);
  } finally {
    await fixture.close();
  }
});
