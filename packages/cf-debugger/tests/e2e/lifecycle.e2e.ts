import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { readStateFile, startCli, stopCli } from "./cli-helpers.js";
import { discoverDebugTarget } from "./discovery.js";
import { CLI_PATH, buildEnv, canConnect, cleanupHome, createIsolatedHome, readLiveCreds } from "./helpers.js";

test("start opens a real SSH debug tunnel and stop cleans it up", async () => {
  test.setTimeout(10 * 60 * 1000);

  expect(
    existsSync(CLI_PATH),
    `CLI must be built at ${CLI_PATH}. Run \`pnpm --filter @saptools/cf-debugger build\`.`,
  ).toBe(true);

  const creds = readLiveCreds();
  test.skip(!creds, "SAP_EMAIL / SAP_PASSWORD not set — live debugger test skipped");
  if (!creds) {
    return;
  }

  const target = await discoverDebugTarget(creds.email, creds.password);
  test.skip(
    target === undefined,
    "Could not discover a running CF app to attach the debugger to",
  );
  if (target === undefined) {
    return;
  }

  const homeDir = await createIsolatedHome();

  try {
    const env = buildEnv(homeDir);
    const session = await startCli(
      env,
      [
        "start",
        "--region",
        target.regionKey,
        "--org",
        target.org,
        "--space",
        target.space,
        "--app",
        target.app,
        "--verbose",
      ],
      8 * 60 * 1000,
    );

    try {
      expect(session.localPort).toBeGreaterThanOrEqual(20_000);

      const reachable = await canConnect(session.localPort, 2_000);
      expect(reachable, `tunnel should be reachable on localhost:${String(session.localPort)}`).toBe(true);

      const stateContent = await readStateFile(homeDir);
      expect(stateContent).toContain(target.app);
      expect(stateContent).toContain(`"status": "ready"`);
    } finally {
      await stopCli(session.child);
    }

    const stateAfter = await readStateFile(homeDir);
    expect(stateAfter === "" || !stateAfter.includes(target.app)).toBe(true);
  } finally {
    await cleanupHome(homeDir);
  }
});
