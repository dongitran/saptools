import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { test, expect } from "@playwright/test";
import type { RegionNode } from "@saptools/cf-sync";

import { promptForAppSelection } from "../../src/app-search-prompt.js";
import type { CfInfoDeps } from "../../src/cf-info.js";
import { setupApp } from "../../src/setup-app.js";

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
const FAKE_BRU = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-bru.mjs");
const FAKE_CF = resolve(PACKAGE_DIR, "..", "cf-sync", "tests", "e2e", "fixtures", "fake-cf.mjs");

interface CtxPaths {
  readonly home: string;
  readonly bruDir: string;
  readonly bruLog: string;
  readonly root: string;
  readonly appDir: string;
  readonly envFile: string;
}

interface SyncCtx {
  readonly home: string;
  readonly cfDir: string;
  readonly scenarioPath: string;
  readonly logPath: string;
}

interface RunCliOptions {
  readonly cwd?: string;
  readonly collectionEnv?: string;
  readonly legacyRootEnv?: string;
}

async function makeFixture(): Promise<CtxPaths> {
  const home = await mkdtemp(join(tmpdir(), "saptools-bruno-e2e-"));
  const saptoolsDir = join(home, ".saptools");
  await mkdir(saptoolsDir, { recursive: true });

  const cfStructure = {
    syncedAt: "2026-04-18T00:00:00Z",
    regions: [
      {
        key: "ap10",
        label: "Singapore",
        apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
        accessible: true,
        orgs: [
          {
            name: "demo-org",
            spaces: [
              {
                name: "dev-space",
                apps: [{ name: "my-app" }],
              },
            ],
          },
        ],
      },
    ],
  };
  await writeFile(join(saptoolsDir, "cf-structure.json"), `${JSON.stringify(cfStructure, null, 2)}\n`, "utf8");

  const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const xsuaaStore = {
    version: 1,
    entries: [
      {
        region: "ap10",
        org: "demo-org",
        space: "dev-space",
        app: "my-app",
        credentials: {
          clientId: "cid",
          clientSecret: "csec",
          url: "https://uaa.example.com",
        },
        token: {
          accessToken: "fake-access-token-xyz",
          expiresAt: farFuture,
        },
        fetchedAt: new Date().toISOString(),
      },
    ],
  };
  await writeFile(join(saptoolsDir, "xsuaa-data.json"), `${JSON.stringify(xsuaaStore, null, 2)}\n`, "utf8");

  const root = await mkdtemp(join(tmpdir(), "saptools-bruno-root-"));
  const appDir = join(root, "region__ap10", "org__demo-org", "space__dev-space", "my-app");
  const envDir = join(appDir, "environments");
  await mkdir(envDir, { recursive: true });
  const envFile = join(envDir, "dev.bru");
  await writeFile(
    envFile,
    [
      "vars {",
      "  __cf_region: ap10",
      "  __cf_org: demo-org",
      "  __cf_space: dev-space",
      "  __cf_app: my-app",
      "  baseUrl: https://api.example.com",
      "}",
      "",
      "vars:secret [",
      "  accessToken",
      "]",
      "",
    ].join("\n"),
    "utf8",
  );

  const bruDir = await mkdtemp(join(tmpdir(), "saptools-bruno-bin-"));
  await symlink(FAKE_BRU, join(bruDir, "bru"));

  const bruLog = join(home, "bru-invocations.log");
  await writeFile(bruLog, "", "utf8");

  return { home, bruDir, bruLog, root, appDir, envFile };
}

async function makeSyncFixture(): Promise<SyncCtx> {
  const home = await mkdtemp(join(tmpdir(), "saptools-bruno-sync-home-"));
  const cfDir = await mkdtemp(join(tmpdir(), "saptools-bruno-cf-bin-"));
  const scenarioPath = join(home, "fake-cf-scenario.json");
  const logPath = join(home, "fake-cf.log");

  await writeFile(
    scenarioPath,
    `${JSON.stringify(
      {
        regions: [
          {
            key: "ap10",
            apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
            orgs: [
              {
                name: "demo-org",
                spaces: [{ name: "dev-space", apps: ["my-app"] }],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await symlink(FAKE_CF, join(cfDir, "cf"));

  return { home, cfDir, scenarioPath, logPath };
}

function runCli(
  args: readonly string[],
  ctx: CtxPaths,
  extraEnv: NodeJS.ProcessEnv = {},
  options: RunCliOptions = {},
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      {
        cwd: options.cwd ?? ctx.root,
        env: {
          ...process.env,
          HOME: ctx.home,
          PATH: `${ctx.bruDir}:${process.env["PATH"] ?? ""}`,
          FAKE_BRU_LOG: ctx.bruLog,
          ...(options.collectionEnv ? { SAPTOOLS_BRUNO_COLLECTION: options.collectionEnv } : {}),
          ...(options.legacyRootEnv ? { SAPTOOLS_BRUNO_ROOT: options.legacyRootEnv } : {}),
          ...extraEnv,
        },
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const maybeCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          code = typeof maybeCode === "number" ? maybeCode : 1;
        }
        resolvePromise({ stdout, stderr, code });
      },
    );
  });
}

test("use → run: writes context, invokes bru with token", async () => {
  const ctx = await makeFixture();
  try {
    const useResult = await runCli(["use", "ap10/demo-org/dev-space/my-app"], ctx);
    expect(useResult.code).toBe(0);
    expect(useResult.stdout).toMatch(/Default context set/);

    const contextRaw = await readFile(join(ctx.home, ".saptools", "bruno-context.json"), "utf8");
    const context = JSON.parse(contextRaw) as { readonly app: string };
    expect(context.app).toBe("my-app");

    const runResult = await runCli(["run", "--env", "dev"], ctx);
    expect(runResult.code).toBe(0);
    expect(runResult.stdout).toContain("FAKE_BRU_OK");

    const log = await readFile(ctx.bruLog, "utf8");
    const firstLine = log.split("\n").find((l) => l.length > 0);
    expect(firstLine).toBeDefined();
    const invocation = JSON.parse(firstLine ?? "{}") as { readonly argv: readonly string[] };
    expect(invocation.argv).toContain("run");
    expect(invocation.argv).toContain("--env");
    expect(invocation.argv).toContain("dev");
    const envVarArg = invocation.argv[invocation.argv.indexOf("--env-var") + 1];
    expect(envVarArg).toBe("accessToken=fake-access-token-xyz");

    const envRaw = await readFile(ctx.envFile, "utf8");
    expect(envRaw).toContain("accessToken: fake-access-token-xyz");
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.bruDir, { recursive: true, force: true });
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("run with shorthand path resolves to fixture env", async () => {
  const ctx = await makeFixture();
  try {
    const result = await runCli(["run", "ap10/demo-org/dev-space/my-app", "--env", "dev"], ctx);
    expect(result.code).toBe(0);
    const log = await readFile(ctx.bruLog, "utf8");
    expect(log.length).toBeGreaterThan(0);
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.bruDir, { recursive: true, force: true });
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("sync uses the bundled cf-sync dependency to cache the CF landscape", async () => {
  const ctx = await makeSyncFixture();
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, "sync", "--only", "ap10", "--no-interactive"],
      {
        cwd: ctx.home,
        env: {
          ...process.env,
          HOME: ctx.home,
          CF_HOME: join(ctx.home, ".cf"),
          PATH: `${ctx.cfDir}:${process.env["PATH"] ?? ""}`,
          CF_SYNC_FAKE_SCENARIO: ctx.scenarioPath,
          CF_SYNC_FAKE_LOG_PATH: ctx.logPath,
          SAP_EMAIL: "user@example.com",
          SAP_PASSWORD: "secret",
        },
      },
    );

    expect(stderr).not.toMatch(/Error:/);
    expect(stdout).toContain("Structure written to");

    const structureRaw = await readFile(join(ctx.home, ".saptools", "cf-structure.json"), "utf8");
    const structure = JSON.parse(structureRaw) as {
      readonly regions: readonly {
        readonly key: string;
        readonly accessible: boolean;
        readonly orgs: readonly { readonly name: string }[];
      }[];
    };
    expect(structure.regions).toEqual([
      expect.objectContaining({
        key: "ap10",
        accessible: true,
        orgs: [expect.objectContaining({ name: "demo-org" })],
      }),
    ]);

    const fakeLog = await readFile(ctx.logPath, "utf8");
    expect(fakeLog).toContain('"command":"api"');
    expect(fakeLog).toContain('"command":"auth"');
    expect(fakeLog).toContain('"command":"apps"');
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.cfDir, { recursive: true, force: true });
  }
});

test("run accepts --collection outside the collection cwd", async () => {
  const ctx = await makeFixture();
  try {
    const result = await runCli(["--collection", ctx.root, "run", "ap10/demo-org/dev-space/my-app", "--env", "dev"], ctx, {}, {
      cwd: ctx.home,
    });
    expect(result.code).toBe(0);
    const log = await readFile(ctx.bruLog, "utf8");
    expect(log.length).toBeGreaterThan(0);
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.bruDir, { recursive: true, force: true });
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("run accepts SAPTOOLS_BRUNO_COLLECTION outside the collection cwd", async () => {
  const ctx = await makeFixture();
  try {
    const result = await runCli(["run", "ap10/demo-org/dev-space/my-app", "--env", "dev"], ctx, {}, {
      cwd: ctx.home,
      collectionEnv: ctx.root,
    });
    expect(result.code).toBe(0);
    const log = await readFile(ctx.bruLog, "utf8");
    expect(log.length).toBeGreaterThan(0);
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.bruDir, { recursive: true, force: true });
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("run still accepts legacy SAPTOOLS_BRUNO_ROOT outside the collection cwd", async () => {
  const ctx = await makeFixture();
  try {
    const result = await runCli(["run", "ap10/demo-org/dev-space/my-app", "--env", "dev"], ctx, {}, {
      cwd: ctx.home,
      legacyRootEnv: ctx.root,
    });
    expect(result.code).toBe(0);
    const log = await readFile(ctx.bruLog, "utf8");
    expect(log.length).toBeGreaterThan(0);
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.bruDir, { recursive: true, force: true });
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("use rejects an unknown region", async () => {
  const ctx = await makeFixture();
  try {
    const result = await runCli(["use", "zz99/a/b/c"], ctx);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Unknown region/);
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.bruDir, { recursive: true, force: true });
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("run fails clearly when a pre-cached token does not exist (would reach out to live OAuth)", async () => {
  const ctx = await makeFixture();
  await rm(join(ctx.home, ".saptools", "xsuaa-data.json"));
  try {
    const result = await runCli(["run", "ap10/demo-org/dev-space/my-app", "--env", "dev"], ctx, {
      // force cf-xsuaa to skip network entirely by removing creds
      SAP_EMAIL: "",
      SAP_PASSWORD: "",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.bruDir, { recursive: true, force: true });
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("use --no-verify accepts a known region without consulting the CF structure", async () => {
  const ctx = await makeFixture();
  await rm(join(ctx.home, ".saptools", "cf-structure.json"));
  try {
    const result = await runCli(["use", "--no-verify", "ap10/whatever/any/app"], ctx);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Default context set/);

    const contextRaw = await readFile(join(ctx.home, ".saptools", "bruno-context.json"), "utf8");
    const context = JSON.parse(contextRaw) as {
      readonly region: string;
      readonly org: string;
      readonly space: string;
      readonly app: string;
    };
    expect(context).toMatchObject({ region: "ap10", org: "whatever", space: "any", app: "app" });
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.bruDir, { recursive: true, force: true });
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("run with a specific .bru file shorthand passes the request path to bru", async () => {
  const ctx = await makeFixture();
  const requestsDir = join(ctx.appDir, "requests");
  await mkdir(requestsDir, { recursive: true });
  const requestFile = join(requestsDir, "hello.bru");
  await writeFile(
    requestFile,
    ["meta {", "  name: hello", "  type: http", "  seq: 1", "}", "", "get {", "  url: {{baseUrl}}/hello", "}", ""].join("\n"),
    "utf8",
  );

  try {
    const result = await runCli(
      ["run", "ap10/demo-org/dev-space/my-app/requests/hello.bru", "--env", "dev"],
      ctx,
    );
    expect(result.code).toBe(0);
    const log = await readFile(ctx.bruLog, "utf8");
    const firstLine = log.split("\n").find((l) => l.length > 0);
    expect(firstLine).toBeDefined();
    const invocation = JSON.parse(firstLine ?? "{}") as {
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly saptoolsAccessToken: string | null;
    };
    expect(realpathSync(invocation.cwd)).toBe(realpathSync(ctx.appDir));
    expect(invocation.argv[0]).toBe("run");
    expect(invocation.argv[1]).toBe(join("requests", "hello.bru"));
    expect(invocation.saptoolsAccessToken).toBe("fake-access-token-xyz");
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.bruDir, { recursive: true, force: true });
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("run falls back to the bundled @usebruno/cli when bru is not on PATH", async () => {
  const ctx = await makeFixture();
  await rm(ctx.bruDir, { recursive: true, force: true });
  const emptyPathDir = await mkdtemp(join(tmpdir(), "saptools-bruno-empty-path-"));
  try {
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>(
      (resolvePromise) => {
        execFile(
          process.execPath,
          [CLI_PATH, "run", "ap10/demo-org/dev-space/my-app", "--env", "dev"],
          {
            cwd: ctx.root,
            env: {
              HOME: ctx.home,
              PATH: emptyPathDir,
              FAKE_BRU_LOG: ctx.bruLog,
              NODE_PATH: process.env["NODE_PATH"] ?? "",
            },
          },
          (err, out, errOut) => {
            let c = 0;
            if (err) {
              const maybeCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
              c = typeof maybeCode === "number" ? maybeCode : 1;
            }
            resolvePromise({ stdout: out, stderr: errOut, code: c });
          },
        );
      },
    );
    // We don't assert bruno actually succeeds end-to-end — only that the CLI
    // resolved the bundled bru (no "Unable to find Bruno CLI" error) and spawned it.
    expect(stderr).not.toMatch(/Unable to find Bruno CLI/);
    void stdout;
    void code;
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
    await rm(emptyPathDir, { recursive: true, force: true });
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("setup-app can narrow a large app list through the searchable app prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "saptools-bruno-setup-root-"));
  const apps = Array.from({ length: 50 }, (_, index) => ({ name: `service-${index.toString().padStart(2, "0")}` }));
  apps.push({ name: "config-main" }, { name: "config-system" }, { name: "config-admin" });

  const region: RegionNode = {
    key: "ap10",
    label: "Singapore",
    apiEndpoint: "https://api.cf.ap10.hana.ondemand.com",
    accessible: true,
    orgs: [
      {
        name: "demo-org",
        spaces: [
          {
            name: "app",
            apps,
          },
        ],
      },
    ],
  };

  const deps: CfInfoDeps = {
    readStructureView: async () => ({
      source: "stable",
      structure: {
        syncedAt: "2026-04-19T00:00:00Z",
        regions: [region],
      },
      metadata: undefined,
    }),
    readRegionsView: async () => ({
      source: "stable",
      regions: [{ key: "ap10", label: "Singapore", apiEndpoint: region.apiEndpoint }],
      metadata: undefined,
    }),
    readRegionView: async () => ({
      source: "stable",
      region,
      metadata: undefined,
    }),
    getRegionView: async () => ({
      source: "stable",
      region,
      metadata: undefined,
    }),
  };

  try {
    const result = await setupApp({
      root,
      deps,
      prompts: {
        selectRegion: async () => "ap10",
        selectOrg: async () => "demo-org",
        selectSpace: async () => "app",
        selectApp: async (choices) => await promptForAppSelection(choices, {
          searchPrompt: async (config) => {
            const filtered = await config.source("config-ad", { signal: new AbortController().signal });
            expect(filtered).toEqual([{ value: "config-admin", name: "config-admin" }]);
            return "config-admin";
          },
        }),
        confirmCreate: async () => true,
        selectEnvironments: async () => ["local", "uit"],
      },
    });

    expect(result.created).toBe(true);
    expect(result.ref.app).toBe("config-admin");
    expect(result.appPath).toContain("config-admin");
    expect(result.environments).toHaveLength(2);
    await expect(readFile(join(result.appPath, "bruno.json"), "utf8")).resolves.toContain('"type": "collection"');
    await expect(readFile(join(root, "bruno.json"), "utf8")).rejects.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
