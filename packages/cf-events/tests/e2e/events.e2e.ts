import { expect, test } from "@playwright/test";

import { createEnv, fakeAuditEvent, prepareCase, runCli } from "./helpers.js";
import type { Scenario } from "./helpers.js";

const ROOT = "cf-events-e2e-events";
const APP_GUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

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
        sshEnabled: { enabled: true, reason: "" },
        events,
      },
    },
  };
}

const SAMPLE_EVENTS = [
  fakeAuditEvent({ guid: "ev-start", type: "audit.app.start", created_at: "2026-05-22T10:00:00Z" }),
  fakeAuditEvent({
    guid: "ev-ssh",
    type: "audit.app.ssh-authorized",
    created_at: "2026-05-22T11:00:00Z",
  }),
];

test("events prints an audit-event report", async () => {
  const paths = await prepareCase(ROOT, "text", makeScenario(SAMPLE_EVENTS));
  const result = await runCli(createEnv(paths), ["events", "ap10/demo-org/dev/orders-srv"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Audit events for orders-srv");
  expect(result.stdout).toContain("App started");
  expect(result.stdout).toContain("SSH session authorized");
});

test("events emits a JSON array with --json", async () => {
  const paths = await prepareCase(ROOT, "json", makeScenario(SAMPLE_EVENTS));
  const result = await runCli(createEnv(paths), [
    "events",
    "ap10/demo-org/dev/orders-srv",
    "--json",
  ]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as unknown[];
  expect(parsed).toHaveLength(2);
});

test("events resolves a bare app name from the current CF target", async () => {
  const paths = await prepareCase(ROOT, "bare", makeScenario(SAMPLE_EVENTS));
  const result = await runCli(createEnv(paths), ["events", "orders-srv"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Audit events for orders-srv");
});

test("events fails clearly when the app is unknown", async () => {
  const paths = await prepareCase(ROOT, "unknown", makeScenario(SAMPLE_EVENTS));
  const result = await runCli(createEnv(paths), ["events", "ghost-app"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("was not found");
});
