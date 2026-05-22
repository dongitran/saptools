import { expect, test } from "@playwright/test";

import { createEnv, fakeAuditEvent, prepareCase, runWatchCli } from "./helpers.js";
import type { Scenario } from "./helpers.js";

const ROOT = "cf-events-e2e-watch";
const APP_GUID = "e1b2c3d4-e5f6-7890-abcd-ef1234567890";

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
        events: [
          fakeAuditEvent({
            guid: "watch-1",
            type: "audit.app.start",
            created_at: "2026-05-22T10:00:00Z",
          }),
          fakeAuditEvent({
            guid: "watch-2",
            type: "audit.app.ssh-authorized",
            created_at: "2026-05-22T11:00:00Z",
          }),
        ],
      },
    },
  };
}

test("watch prints new events then exits cleanly on SIGTERM", async () => {
  const paths = await prepareCase(ROOT, "stream", makeScenario());
  const result = await runWatchCli(
    createEnv(paths),
    ["watch", "ap10/demo-org/dev/orders-srv", "--interval", "2000", "--lookback", "3650d"],
    2800,
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("App started");
  expect(result.stdout).toContain("SSH session authorized");
  expect(result.stderr).toContain("Watching ap10/demo-org/dev/orders-srv");
});
