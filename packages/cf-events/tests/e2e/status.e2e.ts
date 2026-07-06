import { expect, test } from "@playwright/test";

import { createEnv, fakeAuditEvent, prepareCase, runCli } from "./helpers.js";
import type { Scenario } from "./helpers.js";

const ROOT = "cf-events-e2e-status";
const APP_GUID = "d1b2c3d4-e5f6-7890-abcd-ef1234567890";

function makeScenario(): Scenario {
  return {
    regionKey: "ap10",
    apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    org: "demo-org",
    space: "dev",
    apps: {
      "orders-srv": {
        guid: APP_GUID,
        app: { guid: APP_GUID, name: "orders-srv", state: "STARTED" },
        sshEnabled: { enabled: true, reason: "" },
        stats: {
          resources: [
            {
              type: "web",
              index: 0,
              state: "RUNNING",
              uptime: 90_000,
              usage: { cpu: 0.12, mem: 268_435_456, disk: 134_217_728 },
              mem_quota: 536_870_912,
              disk_quota: 1_073_741_824,
            },
          ],
        },
        events: [
          fakeAuditEvent({ guid: "ev-1", type: "audit.app.start", created_at: "2026-05-22T10:00:00Z" }),
        ],
      },
    },
  };
}

test("status renders app health with instances", async () => {
  const paths = await prepareCase(ROOT, "text", makeScenario());
  const result = await runCli(createEnv(paths), ["status", "ap10/demo-org/dev/orders-srv"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("App status: orders-srv");
  expect(result.stdout).toContain("Requested state: STARTED");
  expect(result.stdout).toContain("RUNNING");
  expect(result.stdout).toContain("Last event: App started");
});

test("status emits structured JSON with --json", async () => {
  const paths = await prepareCase(ROOT, "json", makeScenario());
  const result = await runCli(createEnv(paths), [
    "status",
    "ap10/demo-org/dev/orders-srv",
    "--json",
  ]);
  expect(result.code).toBe(0);
  const health = JSON.parse(result.stdout) as {
    requestedState: string;
    instances: unknown[];
  };
  expect(health.requestedState).toBe("STARTED");
  expect(health.instances).toHaveLength(1);
});

test("status rejects a space selector clearly", async () => {
  const paths = await prepareCase(ROOT, "space-reject", makeScenario());
  const result = await runCli(createEnv(paths), ["status", "ap10/demo-org/dev"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("The status command requires an app selector");
});
