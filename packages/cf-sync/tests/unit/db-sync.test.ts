import { mkdtemp, rm } from "node:fs/promises";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "saptools-db-sync-test-"));
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof NodeOs>("node:os");
    return { ...actual, homedir: () => tempHome };
  });
});

afterEach(async () => {
  vi.doUnmock("../../src/cf/index.js");
  vi.doUnmock("node:os");
  await rm(tempHome, { recursive: true, force: true });
});

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

describe("runDbSync", () => {
  it("syncs every targeted app and groups CF calls by region, org, and space", async () => {
    const cfApi = vi.fn().mockResolvedValue(void 0);
    const cfAuth = vi.fn().mockResolvedValue(void 0);
    const cfTargetOrg = vi.fn().mockResolvedValue(void 0);
    const cfTargetSpace = vi.fn().mockResolvedValue(void 0);
    const cfEnv = vi
      .fn()
      .mockResolvedValueOnce(HANA_ENV_OUTPUT)
      .mockResolvedValueOnce("VCAP_SERVICES: {}\nVCAP_APPLICATION: {}");

    vi.doMock("../../src/cf/index.js", () => ({
      cfApi,
      cfAuth,
      cfTargetOrg,
      cfTargetSpace,
      cfEnv,
    }));

    const { runDbSync } = await import("../../src/db-sync.js");
    const result = await runDbSync({
      email: "user@example.com",
      password: "secret-password",
      targets: [
        {
          selector: "ap10/org-alpha/dev/orders-srv",
          regionKey: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          orgName: "org-alpha",
          spaceName: "dev",
          appName: "orders-srv",
        },
        {
          selector: "ap10/org-alpha/dev/worker-srv",
          regionKey: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          orgName: "org-alpha",
          spaceName: "dev",
          appName: "worker-srv",
        },
      ],
    });

    expect(cfApi).toHaveBeenCalledTimes(1);
    expect(cfAuth).toHaveBeenCalledTimes(1);
    expect(cfTargetOrg).toHaveBeenCalledTimes(1);
    expect(cfTargetSpace).toHaveBeenCalledTimes(1);
    expect(cfEnv).toHaveBeenCalledTimes(2);

    expect(result.snapshot.entries).toEqual([
      expect.objectContaining({
        selector: "ap10/org-alpha/dev/orders-srv",
        appName: "orders-srv",
        bindings: [expect.objectContaining({ kind: "hana", name: "hana-primary" })],
      }),
      expect.objectContaining({
        selector: "ap10/org-alpha/dev/worker-srv",
        appName: "worker-srv",
        bindings: [],
      }),
    ]);
  });

  it("records an app-level error and continues with the remaining apps", async () => {
    const cfEnv = vi
      .fn()
      .mockRejectedValueOnce(new Error("cf env failed: permission denied"))
      .mockResolvedValueOnce(HANA_ENV_OUTPUT);

    vi.doMock("../../src/cf/index.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockResolvedValue(void 0),
      cfTargetOrg: vi.fn().mockResolvedValue(void 0),
      cfTargetSpace: vi.fn().mockResolvedValue(void 0),
      cfEnv,
    }));

    const { runDbSync } = await import("../../src/db-sync.js");
    const result = await runDbSync({
      email: "user@example.com",
      password: "secret-password",
      targets: [
        {
          selector: "ap10/org-alpha/dev/broken-srv",
          regionKey: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          orgName: "org-alpha",
          spaceName: "dev",
          appName: "broken-srv",
        },
        {
          selector: "ap10/org-alpha/dev/orders-srv",
          regionKey: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          orgName: "org-alpha",
          spaceName: "dev",
          appName: "orders-srv",
        },
      ],
    });

    expect(result.snapshot.entries).toEqual([
      expect.objectContaining({
        selector: "ap10/org-alpha/dev/broken-srv",
        error: "cf env failed: permission denied",
        bindings: [],
      }),
      expect.objectContaining({
        selector: "ap10/org-alpha/dev/orders-srv",
        bindings: [expect.objectContaining({ kind: "hana" })],
      }),
    ]);
  });

  it("records region authentication failures on every target in that region", async () => {
    const cfTargetOrg = vi.fn();
    const cfTargetSpace = vi.fn();
    const cfEnv = vi.fn();

    vi.doMock("../../src/cf/index.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockRejectedValue(new Error("auth denied")),
      cfTargetOrg,
      cfTargetSpace,
      cfEnv,
    }));

    const { runDbSync } = await import("../../src/db-sync.js");
    const result = await runDbSync({
      email: "user@example.com",
      password: "secret-password",
      targets: [
        {
          selector: "ap10/org-alpha/dev/api-app",
          regionKey: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          orgName: "org-alpha",
          spaceName: "dev",
          appName: "api-app",
        },
        {
          selector: "ap10/org-alpha/jobs/job-app",
          regionKey: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          orgName: "org-alpha",
          spaceName: "jobs",
          appName: "job-app",
        },
      ],
    });

    expect(cfTargetOrg).not.toHaveBeenCalled();
    expect(cfTargetSpace).not.toHaveBeenCalled();
    expect(cfEnv).not.toHaveBeenCalled();
    expect(result.snapshot.entries).toEqual([
      expect.objectContaining({
        selector: "ap10/org-alpha/dev/api-app",
        error: "auth denied",
        bindings: [],
      }),
      expect.objectContaining({
        selector: "ap10/org-alpha/jobs/job-app",
        error: "auth denied",
        bindings: [],
      }),
    ]);
  });

  it("reuses a completed DB runtime snapshot when another process already holds the DB lock", async () => {
    vi.doMock("../../src/cf/index.js", () => ({
      cfApi: vi.fn(),
      cfAuth: vi.fn(),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfEnv: vi.fn(),
    }));

    const { cfDbRuntimeStatePath, cfDbSyncLockPath } = await import("../../src/paths.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(cfDbRuntimeStatePath()), { recursive: true });
    await writeFile(
      cfDbRuntimeStatePath(),
      `${JSON.stringify(
        {
          syncId: "external-db-sync",
          status: "completed",
          startedAt: "2026-04-24T00:00:00.000Z",
          updatedAt: "2026-04-24T00:00:02.000Z",
          finishedAt: "2026-04-24T00:00:02.000Z",
          requestedTargets: ["ap10/org-alpha/dev/orders-srv"],
          completedTargets: ["ap10/org-alpha/dev/orders-srv"],
          snapshot: {
            version: 1,
            syncedAt: "2026-04-24T00:00:02.000Z",
            entries: [
              {
                selector: "ap10/org-alpha/dev/orders-srv",
                regionKey: "ap10",
                orgName: "org-alpha",
                spaceName: "dev",
                appName: "orders-srv",
                syncedAt: "2026-04-24T00:00:02.000Z",
                bindings: [],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(cfDbSyncLockPath(), "locked\n", "utf8");

    const { runDbSync } = await import("../../src/db-sync.js");
    await expect(
      runDbSync({
        email: "user@example.com",
        password: "secret-password",
        targets: [
          {
            selector: "ap10/org-alpha/dev/orders-srv",
            regionKey: "ap10",
            apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
            orgName: "org-alpha",
            spaceName: "dev",
            appName: "orders-srv",
          },
        ],
      }),
    ).resolves.toMatchObject({
      snapshot: {
        entries: [{ selector: "ap10/org-alpha/dev/orders-srv" }],
      },
    });
  });

  it("rejects an empty DB target list", async () => {
    vi.doMock("../../src/cf/index.js", () => ({
      cfApi: vi.fn(),
      cfAuth: vi.fn(),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfEnv: vi.fn(),
    }));

    const { runDbSync } = await import("../../src/db-sync.js");
    await expect(
      runDbSync({
        email: "user@example.com",
        password: "secret-password",
        targets: [],
      }),
    ).rejects.toThrow(/No DB sync targets/);
  });
});

describe("resolveDbSyncTargetsFromCurrentTopology", () => {
  it("resolves an explicit selector without a topology snapshot", async () => {
    const { resolveDbSyncTargetsFromCurrentTopology } = await import("../../src/db-sync.js");

    await expect(
      resolveDbSyncTargetsFromCurrentTopology("ap10/org-alpha/dev/orders-srv"),
    ).resolves.toEqual([
      {
        selector: "ap10/org-alpha/dev/orders-srv",
        regionKey: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgName: "org-alpha",
        spaceName: "dev",
        appName: "orders-srv",
      },
    ]);
  });

  it("resolves every app from the stable topology snapshot", async () => {
    const { writeStructure } = await import("../../src/structure.js");
    await writeStructure({
      syncedAt: "2026-04-24T00:00:00.000Z",
      regions: [
        {
          key: "ap10",
          label: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          accessible: true,
          orgs: [
            {
              name: "org-alpha",
              spaces: [{ name: "dev", apps: [{ name: "orders-srv" }] }],
            },
          ],
        },
      ],
    });

    const { resolveDbSyncTargetsFromCurrentTopology } = await import("../../src/db-sync.js");
    await expect(resolveDbSyncTargetsFromCurrentTopology()).resolves.toEqual([
      {
        selector: "ap10/org-alpha/dev/orders-srv",
        regionKey: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgName: "org-alpha",
        spaceName: "dev",
        appName: "orders-srv",
      },
    ]);
  });

  it("falls back to a completed runtime topology snapshot when the stable file is missing", async () => {
    const { cfRuntimeStatePath } = await import("../../src/paths.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(cfRuntimeStatePath()), { recursive: true });
    await writeFile(
      cfRuntimeStatePath(),
      `${JSON.stringify(
        {
          syncId: "topology-runtime",
          status: "completed",
          startedAt: "2026-04-24T00:00:00.000Z",
          updatedAt: "2026-04-24T00:00:02.000Z",
          finishedAt: "2026-04-24T00:00:02.000Z",
          requestedRegionKeys: ["ap10"],
          completedRegionKeys: ["ap10"],
          structure: {
            syncedAt: "2026-04-24T00:00:02.000Z",
            regions: [
              {
                key: "ap10",
                label: "ap10",
                apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
                accessible: true,
                orgs: [
                  {
                    name: "org-alpha",
                    spaces: [{ name: "dev", apps: [{ name: "orders-srv" }] }],
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { resolveDbSyncTargetsFromCurrentTopology } = await import("../../src/db-sync.js");
    await expect(
      resolveDbSyncTargetsFromCurrentTopology("orders-srv"),
    ).resolves.toEqual([
      {
        selector: "ap10/org-alpha/dev/orders-srv",
        regionKey: "ap10",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        orgName: "org-alpha",
        spaceName: "dev",
        appName: "orders-srv",
      },
    ]);
  });

  it("rejects DB target resolution while topology sync is still running", async () => {
    const { cfRuntimeStatePath } = await import("../../src/paths.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(cfRuntimeStatePath()), { recursive: true });
    await writeFile(
      cfRuntimeStatePath(),
      `${JSON.stringify(
        {
          syncId: "topology-running",
          status: "running",
          startedAt: "2026-04-24T00:00:00.000Z",
          updatedAt: "2026-04-24T00:00:01.000Z",
          requestedRegionKeys: ["ap10"],
          completedRegionKeys: [],
          structure: {
            syncedAt: "2026-04-24T00:00:01.000Z",
            regions: [],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { resolveDbSyncTargetsFromCurrentTopology } = await import("../../src/db-sync.js");
    await expect(
      resolveDbSyncTargetsFromCurrentTopology("orders-srv"),
    ).rejects.toThrow(/still running/);
  });

  it("rejects an empty topology snapshot when no apps are cached", async () => {
    const { writeStructure } = await import("../../src/structure.js");
    await writeStructure({
      syncedAt: "2026-04-24T00:00:00.000Z",
      regions: [
        {
          key: "ap10",
          label: "ap10",
          apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
          accessible: true,
          orgs: [],
        },
      ],
    });

    const { resolveDbSyncTargetsFromCurrentTopology } = await import("../../src/db-sync.js");
    await expect(resolveDbSyncTargetsFromCurrentTopology()).rejects.toThrow(/No apps were found/);
  });
});
