import { expect, test } from "@playwright/test";

import { createEnv, fakeAuditEvent, prepareCase, runCli } from "./helpers.js";
import type { Scenario } from "./helpers.js";

const ROOT = "cf-events-e2e-events";
const APP_GUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const BILLING_GUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567891";

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
  expect(result.stderr).toContain("Failed to resolve the GUID for app \"ghost-app\"");
});

test("events prints a space-wide audit-event report", async () => {
  const scenario = makeScenario(SAMPLE_EVENTS);
  const paths = await prepareCase(ROOT, "space-text", {
    ...scenario,
    apps: {
      ...scenario.apps,
      "billing-srv": {
        guid: BILLING_GUID,
        app: { guid: BILLING_GUID, name: "billing-srv", state: "STARTED" },
        events: [fakeAuditEvent({ guid: "billing-start", target: { guid: BILLING_GUID, type: "app", name: "billing-srv" } })],
      },
    },
  });
  const result = await runCli(createEnv(paths), ["events", "ap10/demo-org/dev", "--since", "3650d", "--limit", "100"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Audit events for space ap10/demo-org/dev");
  expect(result.stdout).toContain("orders-srv");
  expect(result.stdout).toContain("billing-srv");
});

test("events emits a space-wide JSON array with --json", async () => {
  const paths = await prepareCase(ROOT, "space-json", makeScenario(SAMPLE_EVENTS));
  const result = await runCli(createEnv(paths), ["events", "ap10/demo-org/dev", "--json"]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as unknown[];
  expect(parsed).toHaveLength(2);
});

test("events --since uses a CF-compatible timestamp and returns recent app events", async () => {
  const now = Date.now();
  const paths = await prepareCase(ROOT, "since-no-millis", makeScenario([
    fakeAuditEvent({
      guid: "recent",
      type: "audit.app.start",
      created_at: new Date(now - 60 * 60_000).toISOString(),
    }),
    fakeAuditEvent({
      guid: "old",
      type: "audit.app.start",
      created_at: new Date(now - 48 * 60 * 60_000).toISOString(),
    }),
  ]));
  const result = await runCli(createEnv(paths), [
    "events",
    "ap10/demo-org/dev/orders-srv",
    "--since",
    "24h",
    "--limit",
    "20",
    "--json",
  ]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as { guid?: string }[];
  expect(parsed.map((event) => event.guid)).toEqual(["recent"]);
});

test("events surfaces CF API errors instead of returning an empty array", async () => {
  const paths = await prepareCase(ROOT, "api-error", {
    ...makeScenario(SAMPLE_EVENTS),
    auditEventsError: {
      code: 10005,
      title: "CF-BadQueryParameter",
      detail: "The query parameter is invalid: Created ats has an invalid timestamp format. Timestamps should be formatted as 'YYYY-MM-DDThh:mm:ssZ'",
    },
  });
  const result = await runCli(createEnv(paths), [
    "events",
    "ap10/demo-org/dev/orders-srv",
    "--since",
    "24h",
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("CF-BadQueryParameter");
  expect(result.stderr).toContain("YYYY-MM-DDThh:mm:ssZ");
});
