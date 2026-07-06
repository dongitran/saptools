import { expect, test } from "@playwright/test";

import { createEnv, fakeAuditEvent, prepareCase, runCli } from "./helpers.js";
import type { Scenario } from "./helpers.js";

const ROOT = "cf-events-e2e-ssh";
const APP_GUID = "c1b2c3d4-e5f6-7890-abcd-ef1234567890";

function makeScenario(
  sshEnabled: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
): Scenario {
  return {
    regionKey: "ap10",
    apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    org: "demo-org",
    space: "dev",
    apps: {
      "orders-srv": {
        guid: APP_GUID,
        app: { guid: APP_GUID, name: "orders-srv", state: "STARTED" },
        sshEnabled,
        events,
      },
    },
  };
}

test("ssh-status reports the SSH flag and recent sessions", async () => {
  const scenario = makeScenario({ enabled: true, reason: "" }, [
    fakeAuditEvent({
      guid: "ssh-1",
      type: "audit.app.ssh-authorized",
      created_at: "2026-05-22T11:00:00Z",
    }),
    fakeAuditEvent({
      guid: "ssh-2",
      type: "audit.app.ssh-unauthorized",
      created_at: "2026-05-22T10:00:00Z",
    }),
  ]);
  const paths = await prepareCase(ROOT, "enabled", scenario);
  const result = await runCli(createEnv(paths), [
    "ssh-status",
    "ap10/demo-org/dev/orders-srv",
    "--since",
    "3650d",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("SSH status for orders-srv");
  expect(result.stdout).toContain("SSH enabled:            yes");
  expect(result.stdout).toContain("Denied SSH attempts: 1");
  expect(result.stdout).toContain("inferred from recent ssh-authorized");
});

test("ssh-status shows the disabled reason as JSON", async () => {
  const scenario = makeScenario({ enabled: false, reason: "Disabled for the space" }, []);
  const paths = await prepareCase(ROOT, "disabled", scenario);
  const result = await runCli(createEnv(paths), [
    "ssh-status",
    "ap10/demo-org/dev/orders-srv",
    "--json",
  ]);
  expect(result.code).toBe(0);
  const status = JSON.parse(result.stdout) as { sshEnabled: boolean; sshReason: string };
  expect(status.sshEnabled).toBe(false);
  expect(status.sshReason).toBe("Disabled for the space");
});

test("ssh-status rejects a space selector clearly", async () => {
  const scenario = makeScenario({ enabled: true, reason: "" }, []);
  const paths = await prepareCase(ROOT, "space-reject", scenario);
  const result = await runCli(createEnv(paths), ["ssh-status", "ap10/demo-org/dev"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("The ssh-status command requires an app selector");
});
