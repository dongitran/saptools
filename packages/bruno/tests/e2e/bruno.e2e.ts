import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { test, expect } from "@playwright/test";

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
const FAKE_BRU = join(PACKAGE_DIR, "tests", "e2e", "fixtures", "fake-bru.mjs");

interface CtxPaths {
  readonly home: string;
  readonly bruDir: string;
  readonly bruLog: string;
  readonly root: string;
  readonly appDir: string;
  readonly envFile: string;
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

void execFileAsync;
