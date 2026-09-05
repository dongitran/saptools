import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CfExecContext } from "./cf.js";
import {
  cfCreateServiceKey,
  cfServiceKey,
  cfServiceParams,
  cfServiceShow,
  cfUpdateService,
  parseServiceStatus,
  trackTempDir,
  untrackTempDir,
} from "./cf.js";
import { SAML_POLL_INTERVAL_MS, SAML_POLL_TIMEOUT_MS } from "./config.js";
import { extractDashboardsCredential, parseCredentialJson } from "./dashboards-payload.js";
import { CfMetricsError, SamlRestoreFailedError, errorMessage } from "./errors.js";
import type { DashboardsCredential } from "./types.js";

export type StepReporter = (message: string) => void;

/**
 * Substrings that mark a key as secret-bearing. This dumps a service
 * instance's entire params blob to stderr under `--verbose`, so the list has
 * to cover what a Cloud Logging instance actually carries, not just the SAML
 * fields this file was written for: `clientSecret` and `apiToken` on the
 * ingest block were both printed in full before `secret`/`token` were added.
 * Kept in step with `cf.ts`'s `SENSITIVE_JSON_VALUE_PATTERN`, which redacts
 * the same classes on the exec layer's own output — two lists that disagree
 * mean whichever path a secret takes decides whether it leaks.
 */
const REDACT_KEY_SUBSTRINGS = ["private", "password", "signature", "secret", "token", "credential", "key"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

/**
 * Redact by substring match on the key name (not an exact allowlist): the
 * real SAML fields seen against a live Cloud Logging instance are nested
 * names like `saml.sp.signature_private_key` / `..._password`, which a naive
 * `key`/`password`/`cert` allowlist would miss.
 */
export function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = shouldRedactKey(key) ? "[REDACTED]" : redactForLog(item);
    }
    return out;
  }
  return value;
}

/** Flip `saml.enabled` while preserving every other key, including nested `saml.*` fields. */
function withSamlEnabled(params: unknown, enabled: boolean): Record<string, unknown> {
  if (!isRecord(params)) {
    throw new CfMetricsError(
      "SAML_TOGGLE_FAILED",
      "Cloud Logging instance params were not a JSON object; refusing to guess a merge.",
    );
  }
  const saml = isRecord(params["saml"]) ? params["saml"] : {};
  return { ...params, saml: { ...saml, enabled } };
}

/** Read the instance's current `saml.enabled`, defaulting to `false` for an absent/malformed `saml` block. */
function readSamlEnabled(params: unknown): boolean {
  return isRecord(params) && isRecord(params["saml"]) && params["saml"]["enabled"] === true;
}

async function writeSecureTempParamsFile(params: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cf-metrics-saml-"));
  // Same reasoning as the CF_HOME dirs: this one holds the instance's full
  // params blob, secrets included, so a Ctrl-C must not strand it on disk.
  trackTempDir(dir);
  try {
    const filePath = join(dir, "params.json");
    await writeFile(filePath, JSON.stringify(params), { mode: 0o600 });
    return filePath;
  } catch (error) {
    // mkdtemp already succeeded by this point, so the directory must be
    // cleaned up here — the caller's own finally block only ever runs once
    // this function has already returned a path.
    untrackTempDir(dir);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Write an exact params blob via `cf update-service`. Single-attempt/never
 * retried (see {@link cfUpdateService}): retrying a mutation whose completion
 * is unknown risks double-applying it or racing an update already in flight.
 * Deliberately does NOT wait for confirmation — callers decide separately
 * what a confirmation failure should mean for this specific call site (see
 * the split between the disable and restore paths in
 * {@link mintDashboardsCredential} below).
 *
 * Takes the fully-prepared params object rather than a boolean to flip: the
 * restore path must write back exactly what {@link mintDashboardsCredential}
 * read at the start, byte for byte, not a value reconstructed from a single
 * boolean — an original `saml.enabled` that was absent, or present in some
 * shape other than a literal `true`, would otherwise get silently rewritten
 * into a `saml.enabled: false` block that didn't exist before.
 */
async function issueSamlUpdate(
  instance: string,
  nextParams: unknown,
  logLabel: string,
  ctx: CfExecContext,
  report: StepReporter,
): Promise<void> {
  const tempFilePath = await writeSecureTempParamsFile(nextParams);
  try {
    report(`cf update-service ${instance} -c <redacted params> (${logLabel})`);
    await cfUpdateService(instance, tempFilePath, ctx);
  } finally {
    untrackTempDir(dirname(tempFilePath));
    await rm(dirname(tempFilePath), { recursive: true, force: true });
  }
}

async function confirmSamlUpdate(instance: string, ctx: CfExecContext, report: StepReporter): Promise<void> {
  const deadline = Date.now() + SAML_POLL_TIMEOUT_MS;
  for (;;) {
    const status = parseServiceStatus(await cfServiceShow(instance, ctx));
    report(`cf service ${instance} status: ${status ?? "(unknown)"}`);
    if (status !== undefined && /succeeded/i.test(status)) {
      return;
    }
    if (status !== undefined && /failed/i.test(status)) {
      throw new Error(`"${instance}" reported a failed update status: ${status}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for "${instance}" to reach a succeeded status (last seen: ${status ?? "unknown"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SAML_POLL_INTERVAL_MS));
  }
}

/**
 * The last-resort credential path (behind `--allow-mint-credential`): flip
 * `saml.enabled` off just long enough to mint a fresh service key with real
 * dashboards basic-auth creds, then restore it. Disabling SAML, even briefly,
 * breaks every human's SSO login to this instance's dashboards for the whole
 * window, so both the disable and the restore are single-attempt mutations,
 * and a failed restore is raised as a distinct, loud error that must never be
 * swallowed by a caller — the instance is left broken for everyone until it
 * is fixed.
 */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

async function confirmThenMint(
  instance: string,
  ctx: CfExecContext,
  report: StepReporter,
): Promise<Outcome<DashboardsCredential>> {
  try {
    await confirmSamlUpdate(instance, ctx, report);
    const keyName = `cf-metrics-${randomBytes(4).toString("hex")}`;
    report(`cf create-service-key ${instance} ${keyName}`);
    await cfCreateServiceKey(instance, keyName, ctx);
    const payload = parseCredentialJson(await cfServiceKey(instance, keyName, ctx), `service key payload for "${keyName}"`);
    const credential = extractDashboardsCredential(payload, `minted:${keyName}`);
    if (credential === undefined) {
      throw new CfMetricsError(
        "CREDENTIALS_NOT_FOUND",
        `Minted key "${keyName}" on "${instance}" did not contain dashboards-username/dashboards-password.`,
      );
    }
    return { ok: true, value: { ...credential, instance } };
  } catch (error) {
    return { ok: false, error };
  }
}

async function restoreCatchingError(
  instance: string,
  originalParams: unknown,
  originalSamlEnabled: boolean,
  ctx: CfExecContext,
  report: StepReporter,
): Promise<Outcome<undefined>> {
  try {
    await issueSamlUpdate(instance, originalParams, `saml.enabled=${String(originalSamlEnabled)} (restored)`, ctx, report);
    await confirmSamlUpdate(instance, ctx, report);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error };
  }
}

export interface MintDashboardsCredentialOptions {
  /**
   * A literal `true` type, not `boolean`: this forces every call site —
   * including future programmatic ones outside the CLI's own
   * `--allow-mint-credential` gate — to explicitly opt into a disruptive
   * operation rather than reach this function by accident or by a default.
   */
  readonly confirmDisruptive: true;
  readonly report?: StepReporter;
}

export async function mintDashboardsCredential(
  instance: string,
  ctx: CfExecContext,
  options: MintDashboardsCredentialOptions,
): Promise<DashboardsCredential> {
  const report = options.report ?? ((message) => void message);
  const originalParams = parseCredentialJson(await cfServiceParams(instance, ctx), `params blob for "${instance}"`);
  report(`read params for "${instance}": ${JSON.stringify(redactForLog(originalParams))}`);
  const originalSamlEnabled = readSamlEnabled(originalParams);

  try {
    await issueSamlUpdate(instance, withSamlEnabled(originalParams, false), "saml.enabled=false", ctx, report);
  } catch (disableError) {
    // The update-service CALL ITSELF never succeeded (as opposed to a later
    // confirmation-polling failure, handled below) — SAML was never actually
    // mutated server-side, so it's safe to skip the restore here.
    throw new CfMetricsError(
      "SAML_TOGGLE_FAILED",
      `Failed to disable SAML on "${instance}": ${errorMessage(disableError)}. ` +
        "The update-service call itself did not succeed, so no restore is attempted.",
      { cause: disableError },
    );
  }

  // From this point on, the disable update-service call has SUCCEEDED, so
  // SAML may now be disabled server-side even if a later step fails
  // (confirmation polling, key creation/reading) — the restore below always
  // runs regardless of what happens in confirmThenMint.
  const mintResult = await confirmThenMint(instance, ctx, report);
  const restoreResult = await restoreCatchingError(instance, originalParams, originalSamlEnabled, ctx, report);

  if (!restoreResult.ok) {
    const context = mintResult.ok
      ? ""
      : ` The credential-minting step had also failed: ${errorMessage(mintResult.error)}.`;
    // The disable step already succeeded by this point, so the instance's
    // live saml.enabled is currently `false`. When the true original was
    // also `false`, a failed restore leaves it exactly where it already
    // was — there is no SSO capability to lose, unlike the true-original
    // case where a failed restore leaves it stuck wrong.
    const message = originalSamlEnabled
      ? `CRITICAL: failed to restore saml.enabled=true on Cloud Logging instance "${instance}".${context} ` +
        "SSO dashboards login for this instance is broken for ALL users until this is fixed manually. " +
        `Recover with: cf service ${instance} --params (get the full params blob), set saml.enabled to ` +
        `true while keeping every other field unchanged, then cf update-service ${instance} -c <file>, ` +
        `and verify with cf service ${instance}.`
      : `Failed to re-confirm saml.enabled=false on Cloud Logging instance "${instance}" after a credential ` +
        `mint attempt.${context} SAML was already disabled before this run, so no SSO capability was lost, ` +
        `but verify the instance's params still match what they were before: cf service ${instance} --params.`;
    throw new SamlRestoreFailedError(message, { cause: restoreResult.error });
  }
  if (!mintResult.ok) {
    throw mintResult.error;
  }
  return mintResult.value;
}
