import { expect, test } from "@playwright/test";

import { createEnv, fakeAuditEvent, prepareCase, runCli } from "./helpers.js";
import type { Scenario } from "./helpers.js";

const ROOT = "cf-events-e2e-crashes";
const APP_GUID = "b1b2c3d4-e5f6-7890-abcd-ef1234567890";

function makeScenario(events: readonly Record<string, unknown>[]): Scenario {
  return {
    regionKey: "ap10",
    apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    org: "demo-org",
    space: "dev",
    apps: {
      "orders-srv": {
        guid: APP_GUID,
        app: { guid: APP_GUID, name: "orders-srv", state: "STARTED" },
        events,
      },
    },
  };
}

test("crashes summarizes recent crash events", async () => {
  const scenario = makeScenario([
    fakeAuditEvent({
      guid: "crash-1",
      type: "audit.app.process.crash",
      created_at: "2026-05-22T09:00:00Z",
      data: { index: 0, reason: "CRASHED", exit_status: 1 },
    }),
    fakeAuditEvent({ guid: "start-1", type: "audit.app.start", created_at: "2026-05-22T08:00:00Z" }),
  ]);
  const paths = await prepareCase(ROOT, "with-crashes", scenario);
  const result = await runCli(createEnv(paths), ["crashes", "ap10/demo-org/dev/orders-srv"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Crash report for orders-srv");
  expect(result.stdout).toContain("Crashes: 1");
  expect(result.stdout).toContain("CRASHED");
});

test("crashes reports cleanly when there are none", async () => {
  const scenario = makeScenario([
    fakeAuditEvent({ guid: "start-1", type: "audit.app.start" }),
  ]);
  const paths = await prepareCase(ROOT, "no-crashes", scenario);
  const result = await runCli(createEnv(paths), [
    "crashes",
    "ap10/demo-org/dev/orders-srv",
    "--json",
  ]);
  expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout) as { crashCount: number };
  expect(summary.crashCount).toBe(0);
});
