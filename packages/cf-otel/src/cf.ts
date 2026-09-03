import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const CF_RETRY_ATTEMPTS = 3;
const CF_RETRY_BASE_DELAY_MS = 500;

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

export function getApiEndpointForRegion(regionKey: string): string | undefined {
  return REGION_API_MAP[regionKey.trim().toLowerCase()];
}

const SAP_CF_API_HOSTNAME_PATTERN =
  /^https:\/\/api\.cf\.([a-z]{2}\d{2}(?:-\d{3})?)\.(?:hana\.ondemand\.com|platform\.sapcloud\.cn)$/;

export function getRegionKeyForApi(apiEndpoint: string): string | undefined {
  const normalized = apiEndpoint.trim().toLowerCase().replace(/\/+$/, "");
  for (const [key, endpoint] of Object.entries(REGION_API_MAP)) {
    if (endpoint.toLowerCase() === normalized) {
      return key;
    }
  }
  // Fall back to extracting the region key directly from a standard-shaped
  // SAP CF API hostname even if it's not yet in the hardcoded map above —
  // otherwise a real region added after this map was last updated fails to
  // resolve on both the explicit and ambient targeting paths, with no escape
  // hatch (mirrors cf-hana's identical fallback, for the identical reason).
  // Only ever used for the ambient path's *display*/regionConfirmed
  // purposes — the actual API endpoint used there is always the verbatim
  // ambient `cf target` value, never reconstructed from this extracted key.
  return SAP_CF_API_HOSTNAME_PATTERN.exec(normalized)?.[1];
}

/** Run work inside a fresh temporary CF_HOME. Directory is always cleaned. */
export async function withCfSession<T>(work: (ctx: CfExecContext) => Promise<T>): Promise<T> {
  const cfHome = await mkdtemp(join(tmpdir(), "saptools-cf-otel-"));
  const ctx: CfExecContext = { cfHome };
  try {
    return await work(ctx);
  } finally {
    await rm(cfHome, { recursive: true, force: true });
  }
}

export function resolveCfBin(): { bin: string; argsPrefix: readonly string[] } {
  const raw = process.env["CF_OTEL_CF_BIN"] ?? "cf";
  if (/\.(?:c|m)?js$/i.test(raw)) {
    return { bin: process.execPath, argsPrefix: [raw] };
  }
  return { bin: raw, argsPrefix: [] };
}

function buildEnv(ctx: CfExecContext, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  // Everything this package reads back from `cf` is parsed, and the table
  // parsers locate columns by character position. An inherited `CF_COLOR=true`
  // makes `cf` style its table headers with ANSI escapes even when stdout is a
  // pipe, which shifts every index: measured against a real tenant on cf
  // 8.18.0, `cf services` went from 42 parsed rows to 0 and `cf service-keys`
  // from 54 parsed names to 0, i.e. instance discovery and key discovery both
  // failed outright. A child-level "false" overrides an exported "true".
  // `stripAnsi` below covers the same ground for callers outside this package.
  env["CF_COLOR"] = "false";
  env["CF_HOME"] = ctx.cfHome;
  return env;
}

function isTransientFailure(error: {
  killed?: boolean;
  code?: number | string;
  stderr?: string | Buffer;
  message?: string;
}): boolean {
  const output = `${error.message ?? ""} ${error.stderr ? String(error.stderr) : ""}`.toLowerCase();
  return (
    error.killed === true ||
    output.includes("error performing request") ||
    output.includes("timeout") ||
    output.includes("connection reset") ||
    output.includes("connection refused") ||
    output.includes("eof") ||
    output.includes("502 bad gateway") ||
    output.includes("503 service unavailable") ||
    output.includes("504 gateway timeout") ||
    output.includes("dial tcp") ||
    output.includes("no such host")
  );
}

async function execWithRetries(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  maxAttempts: number = CF_RETRY_ATTEMPTS,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        env,
        maxBuffer: MAX_BUFFER,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      return stdout;
    } catch (err) {
      lastErr = err;
      const e = err as { killed?: boolean; code?: number | string; stderr?: string | Buffer; message?: string };
      const isEnoent = e.code === "ENOENT";
      if (isEnoent || !isTransientFailure(e)) {
        throw err;
      }
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, CF_RETRY_BASE_DELAY_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

interface RunCfExecOptions {
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

async function runCf(
  args: readonly string[],
  ctx: CfExecContext,
  overrides: Record<string, string> = {},
  execOptions: RunCfExecOptions = {},
): Promise<string> {
  const { bin, argsPrefix } = resolveCfBin();
  const env = buildEnv(ctx, overrides);
  try {
    return await execWithRetries(
      bin,
      [...argsPrefix, ...args],
      env,
      execOptions.timeoutMs,
      execOptions.maxAttempts,
    );
  } catch (lastErr) {
    const e = lastErr as { stderr?: string | Buffer; message?: string } | undefined;
    const detail = redactSecretLikeText(e?.stderr ? String(e.stderr) : (e?.message ?? ""));
    throw new Error(`cf ${args.join(" ")} failed: ${detail}`.trim(), { cause: lastErr });
  }
}

// A bare `[^"]*` has no notion of JSON's backslash-escaping: a secret value
// containing an escaped quote (`\"`, exactly what JSON.stringify produces for
// an embedded `"`) would make `[^"]*` stop matching at that escape, redacting
// only the prefix and leaking the remainder in plaintext right next to
// "[REDACTED]". `(?:[^"\\]|\\.)*` — "a non-quote-non-backslash, or a
// backslash plus any one character" — matches a JSON string's contents
// correctly regardless of embedded escapes.
const JSON_STRING_CONTENTS = String.raw`(?:[^"\\]|\\.)*`;
const SENSITIVE_JSON_VALUE_PATTERN = new RegExp(
  `"(${JSON_STRING_CONTENTS}(?:password|secret|private|signature)${JSON_STRING_CONTENTS})"\\s*:\\s*"(${JSON_STRING_CONTENTS})"`,
  "gi",
);
const PEM_BLOCK_PATTERN = /-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/gi;
// A PEM block truncated before its closing fence (plausible with buffered CLI
// stderr) would otherwise leak in full — redact from an unmatched BEGIN to
// the end of the text as a fallback, after complete blocks are already handled.
const UNCLOSED_PEM_BLOCK_PATTERN = /-----BEGIN[^-]*-----[\s\S]*$/gi;

/**
 * Best-effort defense-in-depth redaction for arbitrary `cf` CLI stderr, which
 * is otherwise embedded verbatim into thrown errors. `cfUpdateService`/
 * `cfCreateServiceKey` operate on SAML-secret-bearing params — if a broker
 * ever echoed part of a rejected request back in a validation error, this
 * catches the two shapes most likely to appear: PEM key material, and
 * JSON-style "key":"value" pairs whose key name looks sensitive.
 */
export function redactSecretLikeText(text: string): string {
  return text
    .replace(PEM_BLOCK_PATTERN, "[REDACTED PEM BLOCK]")
    .replace(UNCLOSED_PEM_BLOCK_PATTERN, "[REDACTED PEM BLOCK]")
    .replace(SENSITIVE_JSON_VALUE_PATTERN, (_match, key: string) => `"${key}":"[REDACTED]"`);
}

export async function cfApi(apiEndpoint: string, ctx: CfExecContext): Promise<void> {
  await runCf(["api", apiEndpoint], ctx);
}

export async function cfAuth(email: string, password: string, ctx: CfExecContext): Promise<void> {
  await runCf(["auth"], ctx, { CF_USERNAME: email, CF_PASSWORD: password });
}

export async function cfTargetSpace(orgName: string, spaceName: string, ctx: CfExecContext): Promise<void> {
  await runCf(["target", "-o", orgName, "-s", spaceName], ctx);
}

/** List service instances in the targeted space, raw `cf services` stdout. */
export async function cfServices(ctx: CfExecContext): Promise<string> {
  return await runCf(["services"], ctx);
}

/** List service key names on an instance, raw `cf service-keys` stdout. */
export async function cfServiceKeys(instance: string, ctx: CfExecContext): Promise<string> {
  return await runCf(["service-keys", instance], ctx);
}

/** Read one service key's payload, raw `cf service-key` stdout (contains embedded JSON). */
export async function cfServiceKey(instance: string, keyName: string, ctx: CfExecContext): Promise<string> {
  return await runCf(["service-key", instance, keyName], ctx);
}

/** Read one app's environment, raw `cf env` stdout (contains VCAP_SERVICES/VCAP_APPLICATION). */
export async function cfEnv(appName: string, ctx: CfExecContext): Promise<string> {
  return await runCf(["env", appName], ctx);
}

/** Read one service instance's full params blob, raw `cf service --params` stdout. */
export async function cfServiceParams(instance: string, ctx: CfExecContext): Promise<string> {
  return await runCf(["service", instance, "--params"], ctx);
}

/** Show one service instance's status/details, raw `cf service` stdout. */
export async function cfServiceShow(instance: string, ctx: CfExecContext): Promise<string> {
  return await runCf(["service", instance], ctx);
}

/**
 * Update a service instance's params from a file. This is a mutation against
 * shared infrastructure and is never retried: a timeout leaves the caller
 * unsure whether the update actually applied, and retrying could double-apply
 * or race a still-in-flight update.
 */
export async function cfUpdateService(
  instance: string,
  paramsFilePath: string,
  ctx: CfExecContext,
): Promise<void> {
  await runCf(["update-service", instance, "-c", paramsFilePath], ctx, {}, { maxAttempts: 1 });
}

/** Create a new service key. Never retried — see {@link cfUpdateService}. */
export async function cfCreateServiceKey(instance: string, keyName: string, ctx: CfExecContext): Promise<void> {
  await runCf(["create-service-key", instance, keyName], ctx, {}, { maxAttempts: 1 });
}

/**
 * Delete a service key. Never retried — see {@link cfUpdateService}.
 *
 * `-f` is not optional: without it CF CLI v8 asks for confirmation on stdin,
 * which here is a pipe nobody is attached to, so the command would block until
 * the exec timeout killed it. Deleting a key that no longer exists is not an
 * error either — v8 reports "does not exist" and still exits 0 — which is what
 * makes this safe to call when it is unclear whether the key was ever created.
 */
export async function cfDeleteServiceKey(instance: string, keyName: string, ctx: CfExecContext): Promise<void> {
  await runCf(["delete-service-key", instance, keyName, "-f"], ctx, {}, { maxAttempts: 1 });
}

export async function readCurrentCfTarget(): Promise<CurrentCfTarget | undefined> {
  const { bin, argsPrefix } = resolveCfBin();
  const env = { ...process.env };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  // `cf target` was measured not to colorize its output at all, even with
  // CF_COLOR=true, so this is uniformity rather than a fix: every `cf` this
  // package runs does so with color off. This path builds its own env because
  // it deliberately runs in the user's own CF_HOME rather than a temporary one.
  env["CF_COLOR"] = "false";
  try {
    const stdout = await execWithRetries(bin, [...argsPrefix, "target"], env);
    return parseCfTargetOutput(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Remove ANSI escape sequences from `cf` output before parsing it.
 *
 * `buildEnv` already forces `CF_COLOR=false` for every invocation this package
 * makes, so this is defense in depth for the parsers themselves — they are
 * exported, and locating columns by character position is silently wrong the
 * moment a styled header shifts those positions. Verified against a real
 * tenant: with `CF_COLOR=true`, `cf service-keys` yielded 0 of 54 key names and
 * `cf services` 0 of 42 rows, and stripping the sequences reproduced the
 * uncolored output byte for byte — CF pads its columns by visible width, so
 * removing the escapes restores the exact layout rather than shifting it.
 *
 * Built from a character code because a control character written directly
 * into a regular expression is what `no-control-regex` exists to catch.
 */
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function parseTargetFields(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key && val) {
      map.set(key, val);
    }
  }
  return map;
}

export function parseCfTargetOutput(stdout: string): CurrentCfTarget | undefined {
  const fields = parseTargetFields(stdout);
  const api = fields.get("api endpoint");
  const org = fields.get("org");
  const space = fields.get("space");
  if (!api || !org || !space) {
    return undefined;
  }
  const regionKey = getRegionKeyForApi(api);
  return {
    apiEndpoint: api,
    orgName: org,
    spaceName: space,
    ...(regionKey ? { regionKey } : {}),
  };
}

export interface CfServiceRow {
  readonly name: string;
  readonly offering: string;
  readonly boundApps: readonly string[];
}

/**
 * Parses `cf services` table output. Column order (name, offering/service,
 * plan, bound apps, last operation) is stable across CF CLI v6-v8 even though
 * the second header's exact word ("service" vs "offering") is not, so columns
 * are sliced by character position rather than by splitting on whitespace —
 * splitting would silently misalign columns whenever "bound apps" is blank.
 */
export function parseServicesTable(stdout: string): readonly CfServiceRow[] {
  const lines = stripAnsi(stdout).split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*name\s+\S/i.test(line));
  if (headerIndex === -1) {
    return [];
  }
  const headerLine = lines[headerIndex] ?? "";
  const lowerHeader = headerLine.toLowerCase();
  const nameStart = lowerHeader.indexOf("name");
  const offeringStart = /\boffering\b/.test(lowerHeader)
    ? lowerHeader.indexOf("offering")
    : lowerHeader.indexOf("service");
  const boundAppsStart = lowerHeader.indexOf("bound apps");
  if (nameStart === -1 || offeringStart === -1 || boundAppsStart === -1) {
    return [];
  }
  const planStart = lowerHeader.indexOf("plan");
  const offeringEnd = planStart === -1 ? boundAppsStart : planStart;
  const lastOperationStart = lowerHeader.indexOf("last operation");
  const rows: CfServiceRow[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim().length === 0) {
      continue;
    }
    const name = line.slice(nameStart, offeringStart).trim();
    if (name.length === 0) {
      continue;
    }
    const offering = line.slice(offeringStart, offeringEnd).trim();
    const boundAppsCell = (
      lastOperationStart === -1 ? line.slice(boundAppsStart) : line.slice(boundAppsStart, lastOperationStart)
    ).trim();
    const boundApps = boundAppsCell.length === 0
      ? []
      : boundAppsCell.split(",").map((app) => app.trim()).filter((app) => app.length > 0);
    rows.push({ name, offering, boundApps });
  }
  return rows;
}

/**
 * Start of the column following `name` in a table header, or -1 when `name` is
 * the only column. Located by scanning for the next non-space run rather than
 * by matching the literal header text, so a renamed, added or reordered second
 * column cannot silently turn each whole row back into a "key name".
 */
function columnAfterName(headerLine: string, nameStart: number): number {
  const afterName = nameStart + "name".length;
  const match = /\S/.exec(headerLine.slice(afterName));
  return match === null ? -1 : afterName + match.index;
}

/**
 * Parses `cf service-keys <instance>` output.
 *
 * Two header shapes exist and both are accepted. CF CLI v6/v7 printed a single
 * `name` column; v8 prints a three-column table — `name`, `last operation`,
 * `message`, rendered by `DisplayTableWithHeader` — so requiring the header
 * line to equal "name" found nothing at all on v8. That reported "no service
 * keys exist" for an instance that has them, and forced every run down the far
 * slower per-app `cf env` scan.
 *
 * Cells are sliced by column position rather than split on whitespace, for the
 * same reason {@link parseServicesTable} does it: `message` is routinely blank
 * and `last operation` contains a space, so splitting would read
 * `key1   create succeeded` as three columns and take the wrong one.
 *
 * `cf` does not expose key creation timestamps in this table, so callers that
 * need "newest first" treat the platform's default listing order as
 * creation-ascending and reverse it — a best-effort proxy, not a verified
 * guarantee.
 */
export function parseServiceKeyNames(stdout: string): readonly string[] {
  const lines = stripAnsi(stdout).split(/\r?\n/);
  // Anchored at the line start, so neither the flavor line ("Getting keys for
  // service instance X as ...") nor the empty-result line ("No service keys
  // for service instance X") can be mistaken for a header.
  const headerIndex = lines.findIndex((line) => /^\s*name(?:\s|$)/i.test(line));
  if (headerIndex === -1) {
    return [];
  }
  const headerLine = lines[headerIndex] ?? "";
  const nameStart = headerLine.toLowerCase().indexOf("name");
  const nameEnd = columnAfterName(headerLine, nameStart);
  const names: string[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim().length === 0) {
      break;
    }
    const name = (nameEnd === -1 ? line.slice(nameStart) : line.slice(nameStart, nameEnd)).trim();
    if (name.length > 0) {
      names.push(name);
    }
  }
  return names;
}

function findJsonObjectEnd(source: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < source.length; index++) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === "{") {
      depth++;
      continue;
    }
    if (character === "}" && --depth === 0) {
      return index;
    }
  }
  return -1;
}

/** Extract the first top-level `{...}` JSON object from arbitrary CLI output. */
export function extractFirstJsonObject(stdout: string): string {
  const openIndex = stdout.indexOf("{");
  if (openIndex === -1) {
    throw new Error("No JSON object found in command output");
  }
  const closeIndex = findJsonObjectEnd(stdout, openIndex);
  if (closeIndex === -1) {
    throw new Error("Malformed JSON object in command output");
  }
  return stdout.slice(openIndex, closeIndex + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract and parse the VCAP_SERVICES JSON block from `cf env` output. */
export function extractVcapServices(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("VCAP_SERVICES:");
  if (start === -1) {
    throw new Error("VCAP_SERVICES section not found in cf env output");
  }
  const after = stdout.slice(start + "VCAP_SERVICES:".length);
  const end = after.indexOf("VCAP_APPLICATION:");
  const block = (end === -1 ? after : after.slice(0, end)).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    // Never surface the raw SyntaxError message here: V8 can quote a verbatim
    // snippet of the source next to the bad token, and this block is exactly
    // the credentials of every service bound to the app, not just Cloud Logging.
    throw new Error("VCAP_SERVICES is not valid JSON (parse error details omitted; the source may contain credentials)");
  }
  if (!isRecord(parsed)) {
    throw new Error("VCAP_SERVICES must be an object");
  }
  return parsed;
}

/** Best-effort extraction of a `status:` field from `cf service` output. */
export function parseServiceStatus(stdout: string): string | undefined {
  return parseTargetFields(stdout).get("status");
}
