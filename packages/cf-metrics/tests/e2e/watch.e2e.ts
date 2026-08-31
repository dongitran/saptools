import { spawn } from "node:child_process";

import { expect, test } from "@playwright/test";

import { FAKE_PASSWORD, FAKE_USERNAME, seedWatchArrival, startFakeOpenSearch } from "./fixtures/fake-opensearch.js";
import { BASE_ENV, CLI_PATH, FAKE_CF_PATH, runCli, targetArgs, waitFor } from "./helpers.js";

let fakeOpenSearch: Awaited<ReturnType<typeof startFakeOpenSearch>>;

test.beforeAll(async () => {
  fakeOpenSearch = await startFakeOpenSearch();
});

test.afterAll(async () => {
  await fakeOpenSearch.close();
});

function env(): Record<string, string> {
  return {
    ...BASE_ENV,
    CF_METRICS_FAKE_DASHBOARDS_URL: fakeOpenSearch.url,
    CF_METRICS_FAKE_DASHBOARDS_USERNAME: FAKE_USERNAME,
    CF_METRICS_FAKE_DASHBOARDS_PASSWORD: FAKE_PASSWORD,
  };
}

test("watch polls for new points and prints them as they land, stops cleanly on SIGTERM", async () => {
  const child = spawn("node", [CLI_PATH, "watch", "--service", "watch-app", "--json", "--interval", "2000", ...targetArgs()], {
    env: { ...process.env, CF_METRICS_CF_BIN: FAKE_CF_PATH, ...env() },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  // Wait for the CLI to finish target/credential resolution and actually
  // enter the polling loop before seeding new data — polling the real
  // condition instead of guessing a fixed startup delay removes the
  // flakiness risk of seeding too early (or wastefully late) under CI load.
  await waitFor(() => stderr.includes("watching watch-app"), 'stderr to contain "watching watch-app"');
  seedWatchArrival("watch-app", "container.cpu.usage", 0.42, new Date().toISOString());

  function sawSeededPoint(): boolean {
    return stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .some((line) => {
        try {
          const point = JSON.parse(line) as Record<string, unknown>;
          return point["name"] === "container.cpu.usage" && point["value"] === 0.42;
        } catch {
          return false;
        }
      });
  }

  // Wait for the freshly-seeded point to actually appear in stdout, instead
  // of guessing how long the next poll interval plus processing will take.
  await waitFor(sawSeededPoint, "stdout to contain the seeded container.cpu.usage=0.42 point");

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => {
      resolve(code ?? 0);
    });
    child.kill("SIGTERM");
  });

  expect(exitCode).toBe(0);
  expect(stderr).toContain("press Ctrl+C to stop");
  expect(sawSeededPoint()).toBe(true);
});

test("--interval below the 2000ms minimum is rejected before any polling starts", async () => {
  const result = await runCli(["watch", "--service", "watch-app", "--interval", "500", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--interval must be at least 2000ms");
});

test("watch requires --service", async () => {
  const result = await runCli(["watch", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
});

test("--lookback with an unparseable value is rejected before any polling starts", async () => {
  const result = await runCli(["watch", "--service", "watch-app", "--lookback", "not-a-duration", ...targetArgs()], env());
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid --lookback value "not-a-duration"');
});
