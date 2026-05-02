import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

import {
  CLI_PATH,
  FAKE_CF_BIN,
  type Scenario,
  createEnv,
  prepareCase,
  readDbSyncHistory,
  runJsonCommand,
  waitForDbRuntimeState,
  waitForExit,
} from "./helpers.js";

const ROOT_NAME = "cf-sync-db-e2e";

const HANA_ENV_OUTPUT = [
  "Getting env variables for app orders-srv in org org-alpha / space dev as user@example.com...",
  "",
  "System-Provided:",
  "VCAP_SERVICES: {",
  '  "hana": [',
  "    {",
  '      "name": "hana-primary",',
  '      "label": "hana",',
  '      "plan": "hdi-shared",',
  '      "credentials": {',
  '        "host": "hana.example.internal",',
  '        "port": "443",',
  '        "user": "DB_USER",',
  '        "password": "db-password",',
  '        "schema": "APP_SCHEMA",',
  '        "hdi_user": "HDI_USER",',
  '        "hdi_password": "HDI_PASSWORD",',
  '        "url": "jdbc:sap://hana.example.internal:443",',
  '        "database_id": "DB-123",',
  '        "certificate": "-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----"',
  "      }",
  "    }",
  "  ]",
  "}",
  "",
  "VCAP_APPLICATION: {",
  '  "application_name": "orders-srv"',
  "}",
].join("\n");

function createDbScenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgs: [
          {
            name: "org-alpha",
            spaces: [
              {
                name: "dev",
                apps: [
                  {
                    name: "orders-srv",
                    envDelayMs: 120,
                    envOutput: HANA_ENV_OUTPUT,
                  },
                  {
                    name: "worker-srv",
                    envDelayMs: 1_500,
                    envOutput: "VCAP_SERVICES: {}\nVCAP_APPLICATION: {}",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function createAmbiguousScenario(): Scenario {
  return {
    regions: [
      {
        key: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgs: [
          {
            name: "org-alpha",
            spaces: [
              {
                name: "dev",
                apps: [{ name: "shared-srv", envOutput: HANA_ENV_OUTPUT }],
              },
            ],
          },
        ],
      },
      {
        key: "eu10",
        apiEndpoint: "https://api.cf.eu10.hana.ondemand.com",
        orgs: [
          {
            name: "org-beta",
            spaces: [
              {
                name: "prod",
                apps: [{ name: "shared-srv", envOutput: HANA_ENV_OUTPUT }],
              },
            ],
          },
        ],
      },
    ],
  };
}

test.describe("DB sync commands", () => {
  test.beforeAll(() => {
    expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
    expect(existsSync(FAKE_CF_BIN), `Fake CF fixture must exist at ${FAKE_CF_BIN}`).toBe(true);
  });

  test("User can read an empty DB view before any DB sync has run", async () => {
    const paths = await prepareCase(ROOT_NAME, "db-read-empty", createDbScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    await expect(runJsonCommand(env, ["db-read"])).resolves.toBeNull();
    await expect(runJsonCommand(env, ["db-read", "api-app"])).resolves.toBeNull();
    expect(existsSync(paths.dbRuntimeStatePath)).toBe(false);
    expect(existsSync(paths.dbSnapshotPath)).toBe(false);
  });

  test("User can start a background DB sync for cached apps and inspect runtime progress", async () => {
    const paths = await prepareCase(ROOT_NAME, "db-sync-background", createDbScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const topologySync = spawn("node", [CLI_PATH, "sync", "--only", "ap10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const topologyResult = await waitForExit(topologySync);
    expect(topologyResult.code, `stderr was: ${topologyResult.stderr}`).toBe(0);

    const launcher = spawn("node", [CLI_PATH, "db-sync"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launchResult = await waitForExit(launcher);
    expect(launchResult.code, `stderr was: ${launchResult.stderr}`).toBe(0);
    expect(launchResult.stdout).toContain("Background DB sync requested");

    const runtimeState = await waitForDbRuntimeState(paths.dbRuntimeStatePath, (state) => {
      const completed = state["completedTargets"];
      return (
        Array.isArray(completed) &&
        completed.includes("ap10/org-alpha/dev/orders-srv") &&
        !completed.includes("ap10/org-alpha/dev/worker-srv")
      );
    });
    expect(runtimeState["status"]).toBe("running");

    const view = await runJsonCommand(env, ["db-read"]);
    expect(view).toMatchObject({
      source: "runtime",
      metadata: {
        status: "running",
        completedTargets: ["ap10/org-alpha/dev/orders-srv"],
        pendingTargets: ["ap10/org-alpha/dev/worker-srv"],
      },
      snapshot: {
        entries: [
          {
            selector: "ap10/org-alpha/dev/orders-srv",
            appName: "orders-srv",
          },
        ],
      },
    });

    const completedState = await waitForDbRuntimeState(
      paths.dbRuntimeStatePath,
      (state) => state["status"] === "completed",
      15_000,
    );
    expect(completedState["completedTargets"]).toEqual([
      "ap10/org-alpha/dev/orders-srv",
      "ap10/org-alpha/dev/worker-srv",
    ]);

    const appView = await runJsonCommand(env, ["db-read", "orders-srv"]);
    expect(appView).toMatchObject({
      source: "runtime",
      entry: {
        selector: "ap10/org-alpha/dev/orders-srv",
        appName: "orders-srv",
        bindings: [expect.objectContaining({ kind: "hana", name: "hana-primary" })],
      },
    });

    const history = await readDbSyncHistory(paths.dbHistoryPath);
    expect(history.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        "db_sync_requested",
        "db_sync_lock_acquired",
        "db_runtime_initialized",
        "db_app_started",
        "db_app_loaded",
        "db_sync_completed",
        "db_sync_lock_released",
      ]),
    );
  });

  test("User can sync one app by explicit selector without an existing topology snapshot", async () => {
    const paths = await prepareCase(ROOT_NAME, "db-sync-explicit-selector", createDbScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const launcher = spawn("node", [CLI_PATH, "db-sync", "ap10/org-alpha/dev/orders-srv"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launchResult = await waitForExit(launcher);
    expect(launchResult.code, `stderr was: ${launchResult.stderr}`).toBe(0);

    await waitForDbRuntimeState(paths.dbRuntimeStatePath, (state) => state["status"] === "completed");

    const view = await runJsonCommand(env, ["db-read", "ap10/org-alpha/dev/orders-srv"]);
    expect(view).toMatchObject({
      source: "runtime",
      entry: {
        selector: "ap10/org-alpha/dev/orders-srv",
        appName: "orders-srv",
        bindings: [expect.objectContaining({ kind: "hana", name: "hana-primary" })],
      },
    });
  });

  test("User gets a clear error when DB sync is requested before any topology snapshot exists", async () => {
    const paths = await prepareCase(ROOT_NAME, "db-sync-no-topology", createDbScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const launcher = spawn("node", [CLI_PATH, "db-sync"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launchResult = await waitForExit(launcher);

    expect(launchResult.code).toBe(1);
    expect(launchResult.stderr).toContain("Run `cf-sync sync` first");
    expect(existsSync(paths.dbRuntimeStatePath)).toBe(false);
  });

  test("User gets a clear error when a plain app name matches multiple topology entries", async () => {
    const paths = await prepareCase(ROOT_NAME, "db-sync-ambiguous-selector", createAmbiguousScenario());
    const env = createEnv(paths.homeDir, paths.scenarioPath, paths.logPath);

    const topologySync = spawn("node", [CLI_PATH, "sync", "--only", "ap10,eu10"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const topologyResult = await waitForExit(topologySync);
    expect(topologyResult.code, `stderr was: ${topologyResult.stderr}`).toBe(0);

    const launcher = spawn("node", [CLI_PATH, "db-sync", "shared-srv"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launchResult = await waitForExit(launcher);

    expect(launchResult.code).toBe(1);
    expect(launchResult.stderr).toContain("shared-srv");
    expect(launchResult.stderr).toContain("ap10/org-alpha/dev/shared-srv");
    expect(launchResult.stderr).toContain("eu10/org-beta/prod/shared-srv");
  });
});
