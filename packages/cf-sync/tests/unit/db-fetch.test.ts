import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "saptools-db-fetch-test-"));
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof NodeOs>("node:os");
    return { ...actual, homedir: () => tempHome };
  });
});

afterEach(async () => {
  vi.doUnmock("../../src/cf/index.js");
  vi.doUnmock("../../src/db/sync.js");
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

const NO_HANA_ENV_OUTPUT = "VCAP_SERVICES: {}\nVCAP_APPLICATION: {}";

describe("fetchAppDbBindings", () => {
  it("fetches HANA bindings for an explicit selector without a topology snapshot", async () => {
    const cfApi = vi.fn().mockResolvedValue(void 0);
    const cfAuth = vi.fn().mockResolvedValue(void 0);
    const cfTargetSpace = vi.fn().mockResolvedValue(void 0);
    const cfEnv = vi.fn(async (): Promise<string> => HANA_ENV_OUTPUT);

    vi.doMock("../../src/cf/index.js", () => ({
      cfApi,
      cfAuth,
      cfTargetOrg: vi.fn(),
      cfTargetSpace,
      cfEnv,
    }));

    const { fetchAppDbBindings } = await import("../../src/db/fetch.js");
    const result = await fetchAppDbBindings({
      selector: "ap10/org-alpha/dev/orders-srv",
      email: "user@example.com",
      password: "secret-password",
    });

    expect(cfApi).toHaveBeenCalledWith(
      "https://api.cf.ap10.hana.ondemand.com",
      expect.anything(),
    );
    expect(cfAuth).toHaveBeenCalledWith(
      "user@example.com",
      "secret-password",
      expect.anything(),
    );
    expect(cfTargetSpace).toHaveBeenCalledWith("org-alpha", "dev", expect.anything());
    expect(cfEnv).toHaveBeenCalledWith("orders-srv", expect.anything());

    expect(result).toEqual({
      selector: "ap10/org-alpha/dev/orders-srv",
      regionKey: "ap10",
      orgName: "org-alpha",
      spaceName: "dev",
      appName: "orders-srv",
      bindings: [
        expect.objectContaining({ kind: "hana", name: "hana-primary" }),
      ],
    });
  });

  it("resolves a bare app name against the cached topology snapshot", async () => {
    vi.doMock("../../src/cf/index.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockResolvedValue(void 0),
      cfTargetOrg: vi.fn().mockResolvedValue(void 0),
      cfTargetSpace: vi.fn().mockResolvedValue(void 0),
      cfEnv: vi.fn(async (): Promise<string> => HANA_ENV_OUTPUT),
    }));

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

    const { fetchAppDbBindings } = await import("../../src/db/fetch.js");
    const result = await fetchAppDbBindings({
      selector: "orders-srv",
      email: "user@example.com",
      password: "secret-password",
    });

    expect(result).toMatchObject({
      selector: "ap10/org-alpha/dev/orders-srv",
      regionKey: "ap10",
      appName: "orders-srv",
      bindings: [expect.objectContaining({ kind: "hana" })],
    });
  });

  it("returns an empty binding list when the app has no HANA service", async () => {
    vi.doMock("../../src/cf/index.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockResolvedValue(void 0),
      cfTargetOrg: vi.fn().mockResolvedValue(void 0),
      cfTargetSpace: vi.fn().mockResolvedValue(void 0),
      cfEnv: vi.fn(async (): Promise<string> => NO_HANA_ENV_OUTPUT),
    }));

    const { fetchAppDbBindings } = await import("../../src/db/fetch.js");
    const result = await fetchAppDbBindings({
      selector: "ap10/org-alpha/dev/worker-srv",
      email: "user@example.com",
      password: "secret-password",
    });

    expect(result.bindings).toEqual([]);
  });

  it("does not persist any snapshot, lock, or history file under ~/.saptools", async () => {
    vi.doMock("../../src/cf/index.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockResolvedValue(void 0),
      cfTargetOrg: vi.fn().mockResolvedValue(void 0),
      cfTargetSpace: vi.fn().mockResolvedValue(void 0),
      cfEnv: vi.fn(async (): Promise<string> => HANA_ENV_OUTPUT),
    }));

    const { saptoolsDir } = await import("../../src/paths.js");
    const { fetchAppDbBindings } = await import("../../src/db/fetch.js");
    await fetchAppDbBindings({
      selector: "ap10/org-alpha/dev/orders-srv",
      email: "user@example.com",
      password: "secret-password",
    });

    expect(existsSync(saptoolsDir())).toBe(false);
  });

  it("propagates CF authentication failures", async () => {
    vi.doMock("../../src/cf/index.js", () => ({
      cfApi: vi.fn().mockResolvedValue(void 0),
      cfAuth: vi.fn().mockRejectedValue(new Error("auth denied")),
      cfTargetOrg: vi.fn(),
      cfTargetSpace: vi.fn(),
      cfEnv: vi.fn(),
    }));

    const { fetchAppDbBindings } = await import("../../src/db/fetch.js");
    await expect(
      fetchAppDbBindings({
        selector: "ap10/org-alpha/dev/orders-srv",
        email: "user@example.com",
        password: "secret-password",
      }),
    ).rejects.toThrow(/auth denied/);
  });

  it("rejects an empty selector", async () => {
    const { fetchAppDbBindings } = await import("../../src/db/fetch.js");
    await expect(
      fetchAppDbBindings({ selector: "   ", email: "user@example.com", password: "pw" }),
    ).rejects.toThrow(/selector is required/);
  });

  it("rejects an explicit selector with an unknown region", async () => {
    const { fetchAppDbBindings } = await import("../../src/db/fetch.js");
    await expect(
      fetchAppDbBindings({
        selector: "zz99/org-alpha/dev/orders-srv",
        email: "user@example.com",
        password: "pw",
      }),
    ).rejects.toThrow(/Unknown region key/);
  });

  it("throws when the selector resolves to no CF app", async () => {
    vi.doMock("../../src/db/sync.js", () => ({
      resolveDbSyncTargetsFromCurrentTopology: vi.fn().mockResolvedValue([]),
    }));

    const { fetchAppDbBindings } = await import("../../src/db/fetch.js");
    await expect(
      fetchAppDbBindings({
        selector: "ap10/org-alpha/dev/ghost-srv",
        email: "user@example.com",
        password: "pw",
      }),
    ).rejects.toThrow(/Could not resolve a CF app/);
  });
});
