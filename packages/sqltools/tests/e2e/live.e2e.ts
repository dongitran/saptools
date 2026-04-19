import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import type { SqlToolsConnection } from "../../src/types.js";

import { CLI_PATH } from "./helpers.js";

const execFileAsync = promisify(execFile);

interface CfStructureFile {
  readonly regions: readonly {
    readonly key: string;
    readonly accessible: boolean;
    readonly orgs: readonly {
      readonly name: string;
      readonly spaces: readonly {
        readonly name: string;
        readonly apps: readonly { readonly name: string }[];
      }[];
    }[];
  }[];
}

interface TestTarget {
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
}

function structurePath(): string {
  return join(homedir(), ".saptools", "cf-structure.json");
}

function loadStructure(): CfStructureFile {
  const p = structurePath();
  if (!existsSync(p)) {
    throw new Error(`Structure file not found: ${p} — run cf-sync first`);
  }
  return JSON.parse(readFileSync(p, "utf8")) as CfStructureFile;
}

function parseTargetEnv(): TestTarget | undefined {
  const raw = process.env["E2E_TARGET"];
  if (!raw) {
    return undefined;
  }
  const parts = raw.split("/");
  if (parts.length !== 4) {
    throw new Error("E2E_TARGET must be in form region/org/space/app");
  }
  const [region, org, space, app] = parts as [string, string, string, string];
  return { region, org, space, app };
}

function* iterateCandidates(structure: CfStructureFile): IterableIterator<TestTarget> {
  const hintedNames = /(hana|db|srv|service|api|backend)/i;
  const accessible = structure.regions.filter((r) => r.accessible);

  interface Candidate {
    readonly target: TestTarget;
    readonly score: number;
  }
  const candidates: Candidate[] = [];
  for (const region of accessible) {
    for (const org of region.orgs) {
      for (const space of org.spaces) {
        for (const app of space.apps) {
          candidates.push({
            target: { region: region.key, org: org.name, space: space.name, app: app.name },
            score: hintedNames.test(app.name) ? 1 : 0,
          });
        }
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    yield c.target;
  }
}

async function runExportFromApp(
  target: TestTarget,
  workspaceRoot: string,
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(
    "node",
    [
      CLI_PATH,
      "from-app",
      "--region",
      target.region,
      "--org",
      target.org,
      "--space",
      target.space,
      "--app",
      target.app,
      "--cwd",
      workspaceRoot,
      "--no-credentials-file",
    ],
    { env: process.env, timeout: 3 * 60 * 1000 },
  );
}

async function appHasHana(target: TestTarget): Promise<boolean> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "sqltools-live-probe-"));
  try {
    await runExportFromApp(target, workspaceRoot);
    return true;
  } catch {
    return false;
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

let discovered: TestTarget | undefined;

async function discoverTarget(): Promise<TestTarget> {
  if (discovered) {
    return discovered;
  }
  const envTarget = parseTargetEnv();
  if (envTarget) {
    if (!(await appHasHana(envTarget))) {
      throw new Error(
        `E2E_TARGET ${process.env["E2E_TARGET"] ?? ""} is not reachable via from-app ` +
          `or does not have a HANA binding.`,
      );
    }
    discovered = envTarget;
    return envTarget;
  }
  const structure = loadStructure();
  let attempts = 0;
  const MAX_ATTEMPTS = 20;
  for (const candidate of iterateCandidates(structure)) {
    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      break;
    }
    if (await appHasHana(candidate)) {
      discovered = candidate;
      return candidate;
    }
  }
  throw new Error(
    `Could not find an app with HANA binding in ~/.saptools/cf-structure.json ` +
      `after ${attempts.toString()} attempts. Set E2E_TARGET=region/org/space/app to override.`,
  );
}

test("from-app writes a valid SQLTools connection for a real HANA-bound app", async () => {
  expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
  expect(process.env["SAP_EMAIL"]).toBeTruthy();
  expect(process.env["SAP_PASSWORD"]).toBeTruthy();

  const target = await discoverTarget();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "sqltools-live-"));
  try {
    const { stdout } = await runExportFromApp(target, workspaceRoot);
    expect(stdout).toContain("Updated SQLTools connections");

    const settingsPath = join(workspaceRoot, ".vscode", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(settings["sqltools.useNodeRuntime"]).toBe(true);

    const connections = settings["sqltools.connections"] as readonly SqlToolsConnection[];
    expect(connections.length).toBeGreaterThan(0);
    const connection = connections[0];
    expect(connection?.driver).toBe("SAPHana");
    expect(connection?.name).toBe(`${target.app} (${target.region})`);
    expect(typeof connection?.server).toBe("string");
    expect(connection?.server.length ?? 0).toBeGreaterThan(0);
    expect(typeof connection?.port).toBe("number");
    expect(connection?.port ?? 0).toBeGreaterThan(0);
    expect(typeof connection?.username).toBe("string");
    expect(connection?.username.length ?? 0).toBeGreaterThan(0);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("convert pipes a real VCAP into a SQLTools connection JSON", async () => {
  const target = await discoverTarget();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "sqltools-live-convert-"));
  try {
    await runExportFromApp(target, workspaceRoot);

    const settingsPath = join(workspaceRoot, ".vscode", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const connections = settings["sqltools.connections"] as readonly SqlToolsConnection[];
    const connection = connections[0];
    expect(connection).toBeDefined();
    expect(connection?.hanaOptions.encrypt).toBe(true);
    expect(connection?.hanaOptions.sslValidateCertificate).toBe(true);
    expect(connection?.connectionTimeout).toBeGreaterThan(0);
    expect(connection?.previewLimit).toBeGreaterThan(0);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
