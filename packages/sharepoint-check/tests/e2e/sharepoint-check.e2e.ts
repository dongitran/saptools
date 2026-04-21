import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { buildBaseEnv, CLI_PATH, PACKAGE_ROOT, runCli, startFakeGraph } from "./helpers.js";
import type { FakeGraphProcess } from "./helpers.js";

const execFileAsync = promisify(execFile);

function buildScenario(): {
  readonly scenario: Readonly<Record<string, unknown>>;
  readonly credentials: { readonly tenantId: string; readonly clientId: string; readonly clientSecret: string };
  readonly siteRef: string;
} {
  const tenantId = "demo-tenant";
  const clientId = "demo-client";
  const clientSecret = "demo-secret";
  const siteRef = "demo.sharepoint.example/sites/demo";

  const scenario = {
    credentials: { tenantId, clientId, clientSecret },
    appDisplayName: "Demo Connector",
    roles: ["Sites.Selected", "Files.ReadWrite.All"],
    site: {
      id: "site-001",
      name: "demo",
      displayName: "Demo Site",
      hostname: "demo.sharepoint.example",
      path: "sites/demo",
      webUrl: "https://demo.sharepoint.example/sites/demo",
    },
    drives: [
      { id: "drive-docs", name: "Documents", driveType: "documentLibrary", webUrl: "https://docs" },
      { id: "drive-shared", name: "Shared", driveType: "documentLibrary", webUrl: "https://shared" },
    ],
    driveItems: {
      "drive-docs": {
        id: "drive-docs-root",
        name: "root",
        isFolder: true,
        children: [
          {
            id: "folder-apps",
            name: "Apps",
            isFolder: true,
            children: [
              {
                id: "folder-apps-sample",
                name: "sample-app",
                isFolder: true,
                children: [
                  { id: "file-readme", name: "README.md", isFolder: false, size: 42 },
                  { id: "file-config", name: "config.json", isFolder: false, size: 77 },
                ],
              },
              { id: "folder-apps-demo", name: "demo-app", isFolder: true, children: [] },
            ],
          },
          { id: "file-top", name: "top-level.txt", isFolder: false, size: 10 },
        ],
      },
      "drive-shared": {
        id: "drive-shared-root",
        name: "root",
        isFolder: true,
        children: [],
      },
    },
    writable: true,
  } as const;

  return {
    scenario,
    credentials: { tenantId, clientId, clientSecret },
    siteRef,
  };
}

test.describe("fake-graph CLI flow", () => {
  let server: FakeGraphProcess | undefined;
  let baseEnv: Readonly<Record<string, string>>;
  let credsEnv: Readonly<Record<string, string>>;

  test.beforeAll(async () => {
    await execFileAsync("pnpm", ["--filter", "@saptools/sharepoint-check", "build"], {
      cwd: PACKAGE_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });

    const { scenario, credentials, siteRef } = buildScenario();
    server = await startFakeGraph({ scenario });
    baseEnv = buildBaseEnv(server.port);
    credsEnv = {
      SHAREPOINT_TENANT_ID: credentials.tenantId,
      SHAREPOINT_CLIENT_ID: credentials.clientId,
      SHAREPOINT_CLIENT_SECRET: credentials.clientSecret,
      SHAREPOINT_SITE: siteRef,
    };
  });

  test.afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  test("CLI path resolves to the built dist", () => {
    expect(CLI_PATH).toContain("dist");
  });

  test("`test` command returns JSON with site + claims", async () => {
    const result = await runCli({
      args: ["test", "--json"],
      env: { ...baseEnv, ...credsEnv },
    });
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      readonly token: { readonly tokenType: string };
      readonly site: { readonly id: string; readonly displayName: string };
      readonly claims: { readonly roles: readonly string[] };
    };
    expect(parsed.token.tokenType).toBe("Bearer");
    expect(parsed.site.id).toBe("site-001");
    expect(parsed.site.displayName).toBe("Demo Site");
    expect(parsed.claims.roles).toContain("Sites.Selected");
  });

  test("`drives` lists all document libraries", async () => {
    const result = await runCli({
      args: ["drives", "--json"],
      env: { ...baseEnv, ...credsEnv },
    });
    expect(result.code, result.stderr).toBe(0);
    const drives = JSON.parse(result.stdout) as { readonly name: string }[];
    expect(drives.map((d) => d.name).sort()).toEqual(["Documents", "Shared"]);
  });

  test("`tree` walks the folder structure with file counts", async () => {
    const result = await runCli({
      args: ["tree", "--json", "--drive", "Documents", "--root", "Apps"],
      env: { ...baseEnv, ...credsEnv },
    });
    expect(result.code, result.stderr).toBe(0);
    const tree = JSON.parse(result.stdout) as {
      readonly name: string;
      readonly folderCount: number;
      readonly children: readonly { readonly name: string; readonly fileCount: number }[];
    };
    expect(tree.name).toBe("Apps");
    expect(tree.folderCount).toBe(2);
    const sample = tree.children.find((c) => c.name === "sample-app");
    expect(sample?.fileCount).toBe(2);
  });

  test("`validate` reports present vs missing subdirectories", async () => {
    const result = await runCli({
      args: [
        "validate",
        "--json",
        "--drive",
        "Documents",
        "--root",
        "Apps",
        "--subdirs",
        "sample-app,demo-app,ghost-app",
      ],
      env: { ...baseEnv, ...credsEnv },
    });
    expect(result.code, result.stderr).toBe(2);
    const parsed = JSON.parse(result.stdout) as {
      readonly root: { readonly exists: boolean };
      readonly subdirectories: readonly { readonly path: string; readonly exists: boolean }[];
      readonly allPresent: boolean;
    };
    expect(parsed.root.exists).toBe(true);
    expect(parsed.allPresent).toBe(false);
    const missing = parsed.subdirectories.find((s) => s.path.endsWith("ghost-app"));
    expect(missing?.exists).toBe(false);
    const present = parsed.subdirectories.find((s) => s.path.endsWith("sample-app"));
    expect(present?.exists).toBe(true);
  });

  test("`write-test` creates and deletes a probe folder", async () => {
    const result = await runCli({
      args: ["write-test", "--json", "--drive", "Documents", "--root", "Apps"],
      env: { ...baseEnv, ...credsEnv },
    });
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      readonly created: boolean;
      readonly deleted: boolean;
      readonly probePath: string;
    };
    expect(parsed.created).toBe(true);
    expect(parsed.deleted).toBe(true);
    expect(parsed.probePath.startsWith("Apps/")).toBe(true);
  });

  test("invalid credentials fail with a redacted error", async () => {
    const result = await runCli({
      args: ["test"],
      env: {
        ...baseEnv,
        ...credsEnv,
        SHAREPOINT_CLIENT_SECRET: "wrong-secret",
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("invalid_client");
  });

  test("missing env vars produce a helpful error", async () => {
    const result = await runCli({
      args: ["drives"],
      env: { ...baseEnv },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Tenant ID is required|SHAREPOINT_TENANT_ID/);
  });

  test("`check` runs the full diagnostic pipeline", async () => {
    const result = await runCli({
      args: ["check", "--drive", "Documents", "--root", "Apps", "--subdirs", "sample-app,demo-app"],
      env: { ...baseEnv, ...credsEnv },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Authenticated");
    expect(result.stdout).toContain("Demo Site");
    expect(result.stdout).toContain("Write probe passed");
  });

  test("unknown drive name yields a helpful error", async () => {
    const result = await runCli({
      args: ["tree", "--json", "--drive", "ghost-drive", "--root", "Apps"],
      env: { ...baseEnv, ...credsEnv },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("ghost-drive");
    expect(result.stderr).toMatch(/not found/i);
  });

  test("unknown site path surfaces the 404 hint", async () => {
    const result = await runCli({
      args: ["test"],
      env: {
        ...baseEnv,
        ...credsEnv,
        SHAREPOINT_SITE: "demo.sharepoint.example/sites/nope",
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/site not found/i);
  });
});

test.describe("fake-graph read-only tenant", () => {
  let server: FakeGraphProcess | undefined;
  let baseEnv: Readonly<Record<string, string>>;
  let credsEnv: Readonly<Record<string, string>>;

  test.beforeAll(async () => {
    await execFileAsync("pnpm", ["--filter", "@saptools/sharepoint-check", "build"], {
      cwd: PACKAGE_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });

    const { scenario, credentials, siteRef } = buildScenario();
    const readonlyScenario = { ...scenario, writable: false };
    server = await startFakeGraph({ scenario: readonlyScenario });
    baseEnv = buildBaseEnv(server.port);
    credsEnv = {
      SHAREPOINT_TENANT_ID: credentials.tenantId,
      SHAREPOINT_CLIENT_ID: credentials.clientId,
      SHAREPOINT_CLIENT_SECRET: credentials.clientSecret,
      SHAREPOINT_SITE: siteRef,
    };
  });

  test.afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  test("`write-test` reports accessDenied when tenant blocks writes", async () => {
    const result = await runCli({
      args: ["write-test", "--json", "--drive", "Documents", "--root", "Apps"],
      env: { ...baseEnv, ...credsEnv },
    });
    expect(result.code).toBe(2);
    const parsed = JSON.parse(result.stdout) as {
      readonly created: boolean;
      readonly deleted: boolean;
      readonly error?: string;
    };
    expect(parsed.created).toBe(false);
    expect(parsed.deleted).toBe(false);
    expect(parsed.error ?? "").toMatch(/accessDenied/i);
  });
});
