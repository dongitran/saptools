import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const CF_RETRY_ATTEMPTS = 3;
const CF_RETRY_BASE_DELAY_MS = 500;

/**
 * Which `cf` session a command runs in. `cfHome` names a temporary, isolated
 * CF_HOME created by {@link withCfSession}; when absent the command runs in
 * the user's own session (their `~/.cf`), which is only ever done for
 * read-only commands after `cf target` was confirmed to already point at the
 * requested org/space — see {@link AMBIENT_CF_CONTEXT}.
 */
export interface CfExecContext {
  readonly cfHome?: string;
}

/**
 * The user's own `cf` session. Reusing it skips `cf api`/`cf auth`/`cf target`
 * (measured at ~6s together) and, more importantly, means a matching session
 * needs no SAP_EMAIL/SAP_PASSWORD at all. The session-mutating commands refuse
 * this context outright, so the user's target can never be changed under them.
 */
export const AMBIENT_CF_CONTEXT: CfExecContext = {};

export function isAmbientContext(ctx: CfExecContext): boolean {
  return ctx.cfHome === undefined;
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
  // hatch (mirrors cf-otel's and cf-hana's identical fallback, for the
  // identical reason). Only ever used for the ambient path's *display*/
  // regionConfirmed purposes — the actual API endpoint used there is always
  // the verbatim ambient `cf target` value, never reconstructed from this
  // extracted key.
  return SAP_CF_API_HOSTNAME_PATTERN.exec(normalized)?.[1];
}

/**
 * Temporary CF_HOME directories that must not outlive this process.
 *
 * A `try/finally` alone is not enough: Node's default disposition for an
 * *unhandled* SIGINT/SIGTERM is to terminate immediately, so pressing Ctrl-C
 * during credential discovery skipped the cleanup entirely and left the
 * directory behind — with `.cf/config.json` inside it, holding the CF access
 * token and a long-lived opaque refresh token. Registering a listener both
 * suppresses that immediate termination and gives us a chance to remove the
 * directory before going down.
 */
const trackedCfHomes = new Set<string>();
let terminationHandlersInstalled = false;

function removeTrackedCfHomesSync(): void {
  for (const dir of trackedCfHomes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort while the process is on its way out: one directory that
      // refuses to go must not strand the others.
    }
  }
  trackedCfHomes.clear();
}

/**
 * Clean up, then re-raise with the default disposition restored, so the shell
 * still sees the conventional 128+signal status instead of a fabricated exit
 * code. Safe to do here because a CF session only ever spans credential
 * discovery, which finishes before `watch` installs its own graceful-shutdown
 * handler — the two never overlap.
 */
function onTerminationSignal(signal: NodeJS.Signals): void {
  removeTrackedCfHomesSync();
  uninstallTerminationHandlers();
  process.kill(process.pid, signal);
}

function installTerminationHandlers(): void {
  if (terminationHandlersInstalled) {
    return;
  }
  process.on("SIGINT", onTerminationSignal);
  process.on("SIGTERM", onTerminationSignal);
  terminationHandlersInstalled = true;
}

function uninstallTerminationHandlers(): void {
  if (!terminationHandlersInstalled) {
    return;
  }
  process.off("SIGINT", onTerminationSignal);
  process.off("SIGTERM", onTerminationSignal);
  terminationHandlersInstalled = false;
}

/** Track a temporary directory for signal-time cleanup; `saml-toggle` reuses this for its own. */
export function trackTempDir(dir: string): void {
  trackedCfHomes.add(dir);
  installTerminationHandlers();
}

/** Stop tracking a directory the normal path has already removed. */
export function untrackTempDir(dir: string): void {
  trackedCfHomes.delete(dir);
  if (trackedCfHomes.size === 0) {
    uninstallTerminationHandlers();
  }
}

/** Run work inside a fresh temporary CF_HOME. Directory is always cleaned, including on Ctrl-C. */
export async function withCfSession<T>(work: (ctx: CfExecContext) => Promise<T>): Promise<T> {
  const cfHome = await mkdtemp(join(tmpdir(), "saptools-cf-metrics-"));
  trackTempDir(cfHome);
  const ctx: CfExecContext = { cfHome };
  try {
    return await work(ctx);
  } finally {
    untrackTempDir(cfHome);
    await rm(cfHome, { recursive: true, force: true });
  }
}

export function resolveCfBin(): { bin: string; argsPrefix: readonly string[] } {
  const raw = process.env["CF_METRICS_CF_BIN"] ?? "cf";
  if (/\.(?:c|m)?js$/i.test(raw)) {
    return { bin: process.execPath, argsPrefix: [raw] };
  }
  return { bin: raw, argsPrefix: [] };
}

function buildEnv(ctx: CfExecContext, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env["SAP_EMAIL"];
  delete env["SAP_PASSWORD"];
  // An inherited `CF_COLOR=true` makes the CLI emit ANSI escapes even when its
  // output is piped, and every parser here keys off literal text — `status:`
  // in particular, whose reader feeds the SAML restore check. A styled label
  // never matches, so a successful restore would be reported as
  // `SamlRestoreFailedError`: "SSO broken for ALL users". Forcing it off costs
  // nothing and removes the whole class.
  env["CF_COLOR"] = "false";
  if (ctx.cfHome !== undefined) {
    env["CF_HOME"] = ctx.cfHome;
  }
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

/**
 * The three commands that rewrite a session's state must only ever touch a
 * temporary CF_HOME. A programming error that routed one of them at the
 * ambient context would silently re-point the user's own `cf target`, so it
 * fails loudly here instead.
 */
function assertIsolated(ctx: CfExecContext, command: string): void {
  if (isAmbientContext(ctx)) {
    throw new Error(`refusing to run \`cf ${command}\` in the user's own cf session; it would change their target`);
  }
}

export async function cfApi(apiEndpoint: string, ctx: CfExecContext): Promise<void> {
  assertIsolated(ctx, "api");
  await runCf(["api", apiEndpoint], ctx);
}

export async function cfAuth(email: string, password: string, ctx: CfExecContext): Promise<void> {
  assertIsolated(ctx, "auth");
  await runCf(["auth"], ctx, { CF_USERNAME: email, CF_PASSWORD: password });
}

export async function cfTargetSpace(orgName: string, spaceName: string, ctx: CfExecContext): Promise<void> {
  assertIsolated(ctx, "target");
  await runCf(["target", "-o", orgName, "-s", spaceName], ctx);
}

/** Read one service key's payload, raw `cf service-key` stdout (contains embedded JSON). */
export async function cfServiceKey(instance: string, keyName: string, ctx: CfExecContext): Promise<string> {
  return await runCf(["service-key", instance, keyName], ctx);
}

/**
 * Raw `cf curl <path>` stdout — the Cloud Controller v3 API reached through the
 * session's own credentials, so no token handling lives in this package.
 *
 * Used instead of scraping human-readable `cf` output where v3 answers the
 * question directly: enumerating an instance's credential bindings is one
 * request, versus one `cf env` per bound app (each dumping that app's entire
 * environment) just to find which of them carries the instance.
 */
export async function cfCurl(path: string, ctx: CfExecContext): Promise<string> {
  return await runCf(["curl", path], ctx);
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One service instance's GUID, needed to address it in v3 API paths.
 *
 * The shape is verified rather than trusted: anything else pasted into a URL
 * would produce a confusing request-level failure far from the real cause,
 * instead of naming the command that misbehaved.
 */
export async function cfServiceGuid(instance: string, ctx: CfExecContext): Promise<string> {
  const guid = (await runCf(["service", instance, "--guid"], ctx)).trim();
  if (!GUID_PATTERN.test(guid)) {
    throw new Error(`cf service ${instance} --guid did not return a GUID`);
  }
  return guid;
}

/** The targeted org's space GUID, needed to scope the v3 service-instances listing. Verified like {@link cfServiceGuid}. */
export async function cfSpaceGuid(spaceName: string, ctx: CfExecContext): Promise<string> {
  const guid = (await runCf(["space", spaceName, "--guid"], ctx)).trim();
  if (!GUID_PATTERN.test(guid)) {
    throw new Error(`cf space ${spaceName} --guid did not return a GUID`);
  }
  return guid;
}

const CF_AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /not logged in/i,
  /authentication has expired/i,
  /token (?:has )?expired/i,
  /expired.{0,40}token/i,
  /invalid[_ ]token/i,
  /credentials were rejected/i,
  /re-?authenticate/i,
  /\bunauthorized\b/i,
  /\b401\b/,
];

/**
 * Whether a failed `cf` command failed because the session itself is not
 * usable — not logged in, token expired or revoked, credentials rejected —
 * as opposed to a bad argument, a missing instance, or a network blip.
 *
 * Matched against the message `runCf` builds, which already embeds the
 * command's stderr. Deliberately narrower than matching "token" or "session"
 * anywhere: this package's own error messages use both words.
 */
export function isCfAuthFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return CF_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
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
 * Delete a service key. Never retried, like every other mutation here.
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
  // Same reason as `buildEnv`: `parseTargetFields` splits on a literal `:` and
  // lowercases the key, which a styled label never matches.
  env["CF_COLOR"] = "false";
  try {
    const stdout = await execWithRetries(bin, [...argsPrefix, "target"], env);
    return parseCfTargetOutput(stdout);
  } catch {
    return undefined;
  }
}

function parseTargetFields(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
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

/** Best-effort extraction of a `status:` field from `cf service` output. */
export function parseServiceStatus(stdout: string): string | undefined {
  return parseTargetFields(stdout).get("status");
}
