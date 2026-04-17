import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CfAuthResult {
  readonly orgs: string[];
}

export interface CfTargetResult {
  readonly spaces: string[];
}

// ── Step 1: Set API endpoint (non-interactive, no block) ──────────
export async function cfApi(apiEndpoint: string): Promise<void> {
  await execFileAsync("cf", ["api", apiEndpoint]);
}

// ── Step 2: Authenticate without prompting for org/space ─────────
// cf auth never asks for org selection — safe to use in non-TTY
export async function cfAuth(email: string, password: string): Promise<void> {
  await execFileAsync("cf", ["auth", email, password]);
}

// ── Step 3: List all orgs for the authenticated user ─────────────
export async function cfOrgs(): Promise<string[]> {
  const { stdout } = await execFileAsync("cf", ["orgs"]);

  return parseOrgsTable(stdout);
}

export async function cfTarget(org: string): Promise<CfTargetResult> {
  const { stdout } = await execFileAsync("cf", ["target", "-o", org]);

  return { spaces: parseSpaceList(stdout) };
}

export async function cfTargetSpace(org: string, space: string): Promise<void> {
  await execFileAsync("cf", ["target", "-o", org, "-s", space]);
}

export async function cfApps(): Promise<string[]> {
  const { stdout } = await execFileAsync("cf", ["apps"]);

  return parseAppNames(stdout);
}

// List all spaces in the currently targeted org
export async function cfSpaces(): Promise<string[]> {
  const { stdout } = await execFileAsync("cf", ["spaces"]);

  return parseSpacesTable(stdout);
}

export async function cfEnv(appName: string): Promise<string> {
  const { stdout } = await execFileAsync("cf", ["env", appName]);

  return extractVcapServicesJson(stdout);
}

// ── Pure parse functions (exported for unit testing) ─────────────

// Parses `cf orgs` table output:
//   name
//   org-one
//   org-two
export function parseOrgsTable(stdout: string): string[] {
  const lines = stdout.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === "name");

  if (headerIdx === -1) return [];

  return lines
    .slice(headerIdx + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// Parses `cf spaces` table output (same format as `cf orgs`)
export function parseSpacesTable(stdout: string): string[] {
  const lines = stdout.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === "name");

  if (headerIdx === -1) return [];

  return lines
    .slice(headerIdx + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// Legacy: parses numbered org list from old cf login output (used in tests)
export function parseOrgList(stdout: string): string[] {
  const orgs: string[] = [];

  for (const line of stdout.split("\n")) {
    const match = /^\d+\.\s+(.+)$/.exec(line.trim());

    if (match?.[1] !== undefined) {
      orgs.push(match[1].trim());
    }
  }

  return orgs;
}

export function parseSpaceList(stdout: string): string[] {
  const spaces: string[] = [];

  for (const line of stdout.split("\n")) {
    const match = /^space:\s+(.+)$/.exec(line.trim());

    if (match?.[1] !== undefined) {
      spaces.push(match[1].trim());
    }
  }

  return spaces;
}

export function parseAppNames(stdout: string): string[] {
  const apps: string[] = [];
  let pastHeader = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();

    if (!pastHeader) {
      if (trimmed.startsWith("name")) {
        pastHeader = true;
      }
      continue;
    }

    if (trimmed.length === 0) continue;

    const appName = trimmed.split(/\s+/)[0];

    if (appName !== undefined) {
      apps.push(appName);
    }
  }

  return apps;
}

export function extractVcapServicesJson(stdout: string): string {
  const startMarker = "VCAP_SERVICES:";
  const endMarker = "VCAP_APPLICATION:";

  const startIdx = stdout.indexOf(startMarker);

  if (startIdx === -1) {
    throw new Error("VCAP_SERVICES section not found in cf env output");
  }

  const afterStart = stdout.slice(startIdx + startMarker.length);
  const endIdx = afterStart.indexOf(endMarker);
  const rawBlock = endIdx === -1 ? afterStart : afterStart.slice(0, endIdx);

  return rawBlock.trim();
}
