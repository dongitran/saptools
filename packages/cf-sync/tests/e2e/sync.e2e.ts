import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { cfApi, cfAuth, cfOrgs } from "../../src/cf.js";
import { cfStructurePath } from "../../src/paths.js";
import { getAllRegions } from "../../src/regions.js";
import { REGION_KEYS, type CfStructure } from "../../src/types.js";

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_DIR, "dist", "cli.js");
const AUTO_REGION_LIMIT = 2;

function requireEnv(name: "SAP_EMAIL" | "SAP_PASSWORD"): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function loadOnlyRegionsFromEnv(): readonly (typeof REGION_KEYS)[number][] | undefined {
  const raw = process.env["CF_SYNC_E2E_ONLY"];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const requested = raw
    .split(",")
    .map((region) => region.trim())
    .filter((region): region is string => region.length > 0);

  const allowed = new Set<string>(REGION_KEYS);
  const invalid = requested.filter((region) => !allowed.has(region));
  expect(invalid, `CF_SYNC_E2E_ONLY has unknown regions: ${invalid.join(", ")}`).toEqual([]);

  return requested.filter((region): region is (typeof REGION_KEYS)[number] => allowed.has(region));
}

async function probeRegion(
  apiEndpoint: string,
  email: string,
  password: string,
): Promise<"unavailable" | "accessible-empty" | "accessible-with-orgs"> {
  try {
    await cfApi(apiEndpoint);
    await cfAuth(email, password);
  } catch {
    return "unavailable";
  }

  try {
    const orgs = await cfOrgs();
    return orgs.length > 0 ? "accessible-with-orgs" : "accessible-empty";
  } catch {
    return "accessible-empty";
  }
}

async function detectValidRegions(
  email: string,
  password: string,
): Promise<readonly (typeof REGION_KEYS)[number][]> {
  const validRegions: (typeof REGION_KEYS)[number][] = [];

  for (const region of getAllRegions()) {
    // Keep the sync test bounded by sampling a small real subset of regions the user can actually use.
     
    const status = await probeRegion(region.apiEndpoint, email, password);
    if (status !== "accessible-with-orgs") {
      continue;
    }

    validRegions.push(region.key);
    if (validRegions.length === AUTO_REGION_LIMIT) {
      return validRegions;
    }
  }

  return validRegions;
}

test("cf-sync sync writes ~/.saptools/cf-structure.json", async () => {
  const email = requireEnv("SAP_EMAIL");
  const password = requireEnv("SAP_PASSWORD");
  expect(existsSync(CLI_PATH), `CLI must be built at ${CLI_PATH}`).toBe(true);

  const onlyRegions = loadOnlyRegionsFromEnv() ?? (await detectValidRegions(email, password));
  expect(
    onlyRegions.length,
    "E2E preflight must detect at least one CF region that contains orgs",
  ).toBeGreaterThan(0);

  const args = ["sync", "--verbose", "--only", onlyRegions.join(",")];

  const { stdout } = await execFileAsync("node", [CLI_PATH, ...args], {
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 9 * 60 * 1000,
  });

  expect(stdout).toContain("Structure written to");

  const raw = await readFile(cfStructurePath(), "utf8");
  const parsed = JSON.parse(raw) as CfStructure;
  expect(parsed.regions.length).toBeGreaterThan(0);
  expect(parsed.regions.map((region) => region.key)).toEqual(onlyRegions);
  expect(parsed.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  const accessible = parsed.regions.filter((r) => r.accessible);
  expect(accessible.length).toBeGreaterThan(0);
});
