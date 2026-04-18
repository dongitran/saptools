import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { readState, startCli, stopCli } from "./cli-helpers.js";
import { discoverTwoDebugTargets } from "./discovery.js";
import { CLI_PATH, buildEnv, canConnect, cleanupHome, createIsolatedHome, readLiveCreds } from "./helpers.js";

test("two different apps can be debugged in parallel on distinct ports", async () => {
  test.setTimeout(15 * 60 * 1000);

  expect(
    existsSync(CLI_PATH),
    `CLI must be built at ${CLI_PATH}. Run \`pnpm --filter @saptools/cf-debugger build\`.`,
  ).toBe(true);

  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — parallel test skipped");
  if (!creds) {
    return;
  }

  const targets = await discoverTwoDebugTargets(creds.email, creds.password);
  test.skip(
    targets.length < 2,
    "Could not discover two running CF apps in the same space for parallel test",
  );
  if (targets.length < 2) {
    return;
  }

  const [first, second] = targets;
  if (first === undefined || second === undefined) {
    return;
  }

  const homeDir = await createIsolatedHome();
  const env = buildEnv(homeDir);

  try {
    const [firstSession, secondSession] = await Promise.all([
      startCli(
        env,
        [
          "start",
          "--region",
          first.regionKey,
          "--org",
          first.org,
          "--space",
          first.space,
          "--app",
          first.app,
          "--verbose",
        ],
        10 * 60 * 1000,
      ),
      startCli(
        env,
        [
          "start",
          "--region",
          second.regionKey,
          "--org",
          second.org,
          "--space",
          second.space,
          "--app",
          second.app,
          "--verbose",
        ],
        10 * 60 * 1000,
      ),
    ]);

    try {
      expect(firstSession.localPort).toBeGreaterThanOrEqual(20_000);
      expect(secondSession.localPort).toBeGreaterThanOrEqual(20_000);
      expect(firstSession.localPort).not.toBe(secondSession.localPort);

      const [firstReachable, secondReachable] = await Promise.all([
        canConnect(firstSession.localPort, 2_000),
        canConnect(secondSession.localPort, 2_000),
      ]);
      expect(firstReachable, `first tunnel must be reachable`).toBe(true);
      expect(secondReachable, `second tunnel must be reachable`).toBe(true);

      const state = (await readState(homeDir)) as
        | { sessions?: readonly { app: string; localPort: number; status: string }[] }
        | undefined;
      const sessions = state?.sessions ?? [];
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      const apps = sessions.map((s) => s.app);
      expect(apps).toContain(first.app);
      expect(apps).toContain(second.app);
      const ports = sessions.map((s) => s.localPort);
      expect(new Set(ports).size).toBe(ports.length);
    } finally {
      await Promise.all([stopCli(firstSession.child), stopCli(secondSession.child)]);
    }

    const postState = (await readState(homeDir)) as
      | { sessions?: readonly { app: string }[] }
      | undefined;
    const remaining = postState?.sessions ?? [];
    expect(remaining.some((s) => s.app === first.app || s.app === second.app)).toBe(false);
  } finally {
    await cleanupHome(homeDir);
  }
});
