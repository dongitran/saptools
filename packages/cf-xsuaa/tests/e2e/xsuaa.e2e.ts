import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { xsuaaDataPath } from "../../src/paths.js";
import type { XsuaaStore } from "../../src/types.js";

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");

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
  // Prefer apps whose names hint at approuter / xsuaa bindings
  // (srv, router, approuter, web, api). These almost always have xsuaa.
  const hintedNames = /(approuter|router|xsuaa|srv|web|api)/i;
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

async function appHasXsuaa(target: TestTarget): Promise<boolean> {
  try {
    await execFileAsync("node", [CLI_PATH, "fetch-secret",
      "--region", target.region,
      "--org", target.org,
      "--space", target.space,
      "--app", target.app,
    ], { env: process.env, timeout: 90 * 1000 });
    return true;
  } catch {
    return false;
  }
}

// Shared discovery result so each test doesn't re-scan.
let discovered: TestTarget | undefined;

async function discoverTarget(): Promise<TestTarget> {
  if (discovered) {
    return discovered;
  }
  const envTarget = parseTargetEnv();
  if (envTarget) {
    if (!(await appHasXsuaa(envTarget))) {
      throw new Error(
        `E2E_TARGET ${process.env["E2E_TARGET"] ?? ""} is not reachable via fetch-secret ` +
          `or does not have an xsuaa binding.`,
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
    if (await appHasXsuaa(candidate)) {
      discovered = candidate;
      return candidate;
    }
  }
  throw new Error(
    `Could not find an app with XSUAA binding in ~/.saptools/cf-structure.json ` +
      `after ${attempts.toString()} attempts. Set E2E_TARGET=region/org/space/app to override.`,
  );
}

test("fetch-secret stores XSUAA credentials", async () => {
  expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);
  expect(process.env["SAP_EMAIL"]).toBeTruthy();
  expect(process.env["SAP_PASSWORD"]).toBeTruthy();

  const target = await discoverTarget();

  const raw = await readFile(xsuaaDataPath(), "utf8");
  const store = JSON.parse(raw) as XsuaaStore;
  const entry = store.entries.find(
    (e) => e.region === target.region && e.org === target.org && e.space === target.space && e.app === target.app,
  );
  expect(entry?.credentials.clientId).toBeTruthy();
  expect(entry?.credentials.url).toContain("https");
});

test("get-token returns a non-empty JWT", async () => {
  const target = await discoverTarget();
  const { stdout } = await execFileAsync("node", [CLI_PATH, "get-token",
    "--region", target.region,
    "--org", target.org,
    "--space", target.space,
    "--app", target.app,
  ], { env: process.env, timeout: 2 * 60 * 1000 });
  const token = stdout.trim();
  expect(token.split(".").length).toBe(3);
});

test("get-token-cached returns the same token on second call", async () => {
  const target = await discoverTarget();
  const args = [CLI_PATH, "get-token-cached",
    "--region", target.region,
    "--org", target.org,
    "--space", target.space,
    "--app", target.app,
  ];
  const first = await execFileAsync("node", args, { env: process.env, timeout: 2 * 60 * 1000 });
  const second = await execFileAsync("node", args, { env: process.env, timeout: 2 * 60 * 1000 });
  expect(first.stdout.trim().length).toBeGreaterThan(0);
  expect(second.stdout.trim()).toBe(first.stdout.trim());
});
