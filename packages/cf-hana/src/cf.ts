import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { HanaBinding } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const CF_RETRY_ATTEMPTS = 3;
const CF_RETRY_BASE_DELAY_MS = 120;

/** Minimal context for an isolated CF CLI invocation. */
export interface CfExecContext {
  readonly cfHome: string;
}

/** Data from `cf target`. */
export interface CurrentCfTarget {
  readonly apiEndpoint: string;
  readonly orgName: string;
  readonly spaceName: string;
  readonly regionKey?: string;
}

const REGION_API_MAP: Record<string, string> = {
  ae01: "https://api.cf.ae01.hana.ondemand.com",
  ap01: "https://api.cf.ap01.hana.ondemand.com",
  ap10: "https://api.cf.ap10.hana.ondemand.com",
  ap11: "https://api.cf.ap11.hana.ondemand.com",
  ap12: "https://api.cf.ap12.hana.ondemand.com",
  ap20: "https://api.cf.ap20.hana.ondemand.com",
  ap21: "https://api.cf.ap21.hana.ondemand.com",
  ap30: "https://api.cf.ap30.hana.ondemand.com",
  ap31: "https://api.cf.ap31.hana.ondemand.com",
  br10: "https://api.cf.br10.hana.ondemand.com",
  br20: "https://api.cf.br20.hana.ondemand.com",
  br30: "https://api.cf.br30.hana.ondemand.com",
  ca10: "https://api.cf.ca10.hana.ondemand.com",
  ca20: "https://api.cf.ca20.hana.ondemand.com",
  ch20: "https://api.cf.ch20.hana.ondemand.com",
  cn20: "https://api.cf.cn20.platform.sapcloud.cn",
  cn40: "https://api.cf.cn40.platform.sapcloud.cn",
  eu01: "https://api.cf.eu01.hana.ondemand.com",
  eu02: "https://api.cf.eu02.hana.ondemand.com",
  eu10: "https://api.cf.eu10.hana.ondemand.com",
  "eu10-002": "https://api.cf.eu10-002.hana.ondemand.com",
  "eu10-003": "https://api.cf.eu10-003.hana.ondemand.com",
  "eu10-004": "https://api.cf.eu10-004.hana.ondemand.com",
  "eu10-005": "https://api.cf.eu10-005.hana.ondemand.com",
  "eu10-006": "https://api.cf.eu10-006.hana.ondemand.com",
  eu11: "https://api.cf.eu11.hana.ondemand.com",
  eu12: "https://api.cf.eu12.hana.ondemand.com",
  eu13: "https://api.cf.eu13.hana.ondemand.com",
  eu20: "https://api.cf.eu20.hana.ondemand.com",
  "eu20-001": "https://api.cf.eu20-001.hana.ondemand.com",
  "eu20-002": "https://api.cf.eu20-002.hana.ondemand.com",
  eu21: "https://api.cf.eu21.hana.ondemand.com",
  eu22: "https://api.cf.eu22.hana.ondemand.com",
  eu30: "https://api.cf.eu30.hana.ondemand.com",
  eu31: "https://api.cf.eu31.hana.ondemand.com",
  il30: "https://api.cf.il30.hana.ondemand.com",
  in30: "https://api.cf.in30.hana.ondemand.com",
  jp01: "https://api.cf.jp01.hana.ondemand.com",
  jp10: "https://api.cf.jp10.hana.ondemand.com",
  jp20: "https://api.cf.jp20.hana.ondemand.com",
  jp30: "https://api.cf.jp30.hana.ondemand.com",
  jp31: "https://api.cf.jp31.hana.ondemand.com",
  sa30: "https://api.cf.sa30.hana.ondemand.com",
  sa31: "https://api.cf.sa31.hana.ondemand.com",
  uk20: "https://api.cf.uk20.hana.ondemand.com",
  us01: "https://api.cf.us01.hana.ondemand.com",
  us02: "https://api.cf.us02.hana.ondemand.com",
  us10: "https://api.cf.us10.hana.ondemand.com",
  "us10-001": "https://api.cf.us10-001.hana.ondemand.com",
  "us10-002": "https://api.cf.us10-002.hana.ondemand.com",
  "us10-003": "https://api.cf.us10-003.hana.ondemand.com",
  us11: "https://api.cf.us11.hana.ondemand.com",
  us20: "https://api.cf.us20.hana.ondemand.com",
  us21: "https://api.cf.us21.hana.ondemand.com",
  "us21-001": "https://api.cf.us21-001.hana.ondemand.com",
  us22: "https://api.cf.us22.hana.ondemand.com",
  us30: "https://api.cf.us30.hana.ondemand.com",
  us32: "https://api.cf.us32.hana.ondemand.com",
};

export function normalizeSapCfApiEndpoint(apiEndpoint: string): string {
  const trimmed = apiEndpoint.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid or untrusted CF API endpoint "${apiEndpoint}".`);
  }
  if (/^https:\/\/[^/]*:\d+(?:[/?#]|$)/i.test(trimmed)) {
    throw new Error(`Invalid or untrusted CF API endpoint "${apiEndpoint}".`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname.replace(/\/+$/, "") !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`Invalid or untrusted CF API endpoint "${apiEndpoint}".`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const match = /^api\.cf\.([a-z]{2}\d{2}(?:-\d{3})?)\.(hana\.ondemand\.com|platform\.sapcloud\.cn)$/.exec(hostname);
  if (!match) {
    throw new Error(`Invalid or untrusted CF API endpoint "${apiEndpoint}".`);
  }
  return `https://${hostname}`;
}

export function getApiEndpointForRegion(regionKey: string): string | undefined {
  return REGION_API_MAP[regionKey.trim().toLowerCase()];
}

export function getRegionKeyForApi(apiEndpoint: string): string | undefined {
  let normalized: string;
  try {
    normalized = normalizeSapCfApiEndpoint(apiEndpoint);
  } catch {
    return undefined;
  }
  for (const [key, endpoint] of Object.entries(REGION_API_MAP)) {
    if (endpoint.toLowerCase() === normalized) {
      return key;
    }
  }
  return /^https:\/\/api\.cf\.([a-z]{2}\d{2}(?:-\d{3})?)\.hana\.ondemand\.com$/.exec(normalized)?.[1];
}

/** Run work inside a fresh temporary CF_HOME. Directory is always cleaned. */
export async function withCfSession<T>(work: (ctx: CfExecContext) => Promise<T>): Promise<T> {
  const cfHome = await mkdtemp(join(tmpdir(), "saptools-cf-hana-"));
  const ctx: CfExecContext = { cfHome };
  try {
    return await work(ctx);
  } finally {
    await rm(cfHome, { recursive: true, force: true });
  }
}

function resolveCfBin(): { bin: string; argsPrefix: readonly string[] } {
  const raw = process.env["CF_HANA_CF_BIN"] ?? "cf";
  if (/\.(?:c|m)?js$/i.test(raw)) {
    return { bin: process.execPath, argsPrefix: [raw] };
  }
  return { bin: raw, argsPrefix: [] };
}

function buildEnv(ctx: CfExecContext, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  env["CF_HOME"] = ctx.cfHome;
  return env;
}

async function runCf(
  args: readonly string[],
  ctx: CfExecContext,
  overrides: Record<string, string> = {},
): Promise<string> {
  const { bin, argsPrefix } = resolveCfBin();
  const env = buildEnv(ctx, overrides);

  let lastErr: unknown;

  for (let attempt = 0; attempt < CF_RETRY_ATTEMPTS; attempt++) {
    try {
      const { stdout } = await execFileAsync(bin, [...argsPrefix, ...args], {
        env,
        maxBuffer: MAX_BUFFER,
        timeout: DEFAULT_TIMEOUT_MS,
      });
      return stdout;
    } catch (err) {
      lastErr = err;
      if (attempt < CF_RETRY_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, CF_RETRY_BASE_DELAY_MS * (attempt + 1)));
      }
    }
  }

  const e = lastErr as { stderr?: string | Buffer; message?: string } | undefined;
  const detail = e?.stderr ? String(e.stderr) : (e?.message ?? "");
  const cmd = args[0] === "auth" ? "cf auth" : `cf ${args.join(" ")}`;
  throw new Error(`${cmd} failed: ${detail}`.trim(), { cause: lastErr });
}

export async function cfApi(apiEndpoint: string, ctx: CfExecContext): Promise<void> {
  await runCf(["api", apiEndpoint], ctx);
}

/** Auth using env vars (professional, matches cf-events pattern). */
export async function cfAuth(email: string, password: string, ctx: CfExecContext): Promise<void> {
  await runCf(["auth"], ctx, {
    CF_USERNAME: email,
    CF_PASSWORD: password,
  });
}

export async function cfTargetSpace(
  orgName: string,
  spaceName: string,
  ctx: CfExecContext,
): Promise<void> {
  await runCf(["target", "-o", orgName, "-s", spaceName], ctx);
}

export async function cfEnv(appName: string, ctx: CfExecContext): Promise<string> {
  return await runCf(["env", appName], ctx);
}

/**
 * Direct current user CF context for bare app names.
 * No isolated CF_HOME or forced re-authentication: the current target supplies the app scope.
 */
export async function cfEnvDirect(appName: string): Promise<string> {
  const { bin, argsPrefix } = resolveCfBin();
  const env = { ...process.env };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  const { stdout } = await execFileAsync(bin, [...argsPrefix, "env", appName], {
    env,
    maxBuffer: MAX_BUFFER,
    timeout: DEFAULT_TIMEOUT_MS,
  });
  return stdout;
}

export async function readCurrentCfTarget(): Promise<CurrentCfTarget | undefined> {
  const { bin, argsPrefix } = resolveCfBin();
  const env = { ...process.env };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];

  try {
    const { stdout } = await execFileAsync(bin, [...argsPrefix, "target"], {
      env,
      maxBuffer: MAX_BUFFER,
      timeout: 10_000,
    });
    return parseCfTargetOutput(stdout);
  } catch {
    return undefined;
  }
}

export function parseCfTargetOutput(stdout: string): CurrentCfTarget | undefined {
  const fields = parseTargetFields(stdout);
  const api = fields.get("api endpoint");
  const org = fields.get("org");
  const space = fields.get("space");
  if (!api || !org || !space) {
    return undefined;
  }
  let normalizedApi: string;
  try {
    normalizedApi = normalizeSapCfApiEndpoint(api);
  } catch {
    return undefined;
  }
  const regionKey = getRegionKeyForApi(normalizedApi);
  return {
    apiEndpoint: normalizedApi,
    orgName: org,
    spaceName: space,
    ...(regionKey ? { regionKey } : {}),
  };
}

function parseTargetFields(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) {continue;}
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key && val) {map.set(key, val);}
  }
  return map;
}

export function formatCurrentCfAppSelector(target: CurrentCfTarget, appName: string): string {
  const name = appName.trim();
  if (!name) {throw new Error("App name is required.");}
  const region = target.regionKey ?? "current";
  return `${region}/${target.orgName}/${target.spaceName}/${name}`;
}

/* VCAP parser */

function extractVcapSection(stdout: string): string {
  const start = stdout.indexOf("VCAP_SERVICES:");
  if (start === -1) {throw new Error("VCAP_SERVICES section not found in cf env output");}
  const after = stdout.slice(start + "VCAP_SERVICES:".length);
  const end = after.indexOf("VCAP_APPLICATION:");
  const block = end === -1 ? after : after.slice(0, end);
  return block.trim();
}

interface RawHanaCreds {
  host: string;
  port: string;
  user: string;
  password: string;
  schema: string;
  hdi_user: string;
  hdi_password: string;
  url: string;
  database_id: string;
  certificate: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertCreds(raw: unknown): RawHanaCreds {
  if (!isRecord(raw)) {throw new Error("HANA credentials must be an object");}
  const req = ["host", "port", "user", "password", "schema", "hdi_user", "hdi_password", "url", "database_id", "certificate"];
  for (const k of req) {
    if (typeof raw[k] !== "string") {throw new Error(`Missing/invalid HANA credential field: "${k}"`);}
  }
  return raw as unknown as RawHanaCreds;
}

function mapCreds(raw: RawHanaCreds): HanaBinding["credentials"] {
  return {
    host: raw.host,
    port: raw.port,
    user: raw.user,
    password: raw.password,
    schema: raw.schema,
    hdiUser: raw.hdi_user,
    hdiPassword: raw.hdi_password,
    ...(raw.url ? { url: raw.url } : {}),
    databaseId: raw.database_id,
    certificate: raw.certificate,
  };
}

export function extractHanaBindingsFromCfEnv(stdout: string): readonly HanaBinding[] {
  const jsonText = extractVcapSection(stdout);
  let vcap: unknown;
  try {
    vcap = JSON.parse(jsonText);
  } catch {
    throw new Error("VCAP_SERVICES is not valid JSON");
  }
  if (!isRecord(vcap)) {throw new Error("VCAP_SERVICES must be an object");}

  const hana = vcap["hana"];
  if (hana === undefined) {return [];}
  if (!Array.isArray(hana)) {throw new Error("VCAP_SERVICES.hana must be an array when present");}

  return hana.map((b: unknown) => {
    if (!isRecord(b)) {throw new Error("HANA binding must be an object");}
    const credsRaw = assertCreds(b["credentials"]);
    const name = typeof b["name"] === "string" ? b["name"] : undefined;
    return {
      ...(name ? { name } : {}),
      credentials: mapCreds(credsRaw),
    } as HanaBinding;
  });
}

/**
 * Professional classification: only re-auth for real session/unauth problems.
 */
export function classifyCfError(stderr: string | undefined = "", stdout: string | undefined = ""): {
  readonly isAuthError: boolean;
  readonly reason: string;
} {
  const text = `${stderr} ${stdout}`.toLowerCase();
  if (
    text.includes("not logged in") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("credentials were rejected") ||
    text.includes("authentication failed") ||
    text.includes("cf auth") ||
    text.includes("token") ||
    text.includes("expired") ||
    text.includes("session")
  ) {
    return { isAuthError: true, reason: "auth/session issue" };
  }
  return { isAuthError: false, reason: "" };
}
