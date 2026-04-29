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
