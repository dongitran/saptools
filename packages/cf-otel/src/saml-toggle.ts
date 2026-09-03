import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CfExecContext } from "./cf.js";
import {
  cfCreateServiceKey,
  cfDeleteServiceKey,
  cfServiceKey,
  cfServiceParams,
  cfServiceShow,
  cfUpdateService,
  parseServiceStatus,
} from "./cf.js";
import { SAML_POLL_INTERVAL_MS, SAML_POLL_TIMEOUT_MS } from "./config.js";
import { extractDashboardsCredential, parseCredentialJson } from "./dashboards-payload.js";
import { CfOtelError, SamlRestoreFailedError, errorMessage } from "./errors.js";
import type { DashboardsCredential } from "./types.js";

export type StepReporter = (message: string) => void;

const REDACT_KEY_SUBSTRINGS = ["private", "password", "signature"];

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
    throw new CfOtelError(
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
  const dir = await mkdtemp(join(tmpdir(), "cf-otel-saml-"));
  try {
    const filePath = join(dir, "params.json");
    await writeFile(filePath, JSON.stringify(params), { mode: 0o600 });
    return filePath;
  } catch (error) {
    // mkdtemp already succeeded by this point, so the directory must be
    // cleaned up here — the caller's own finally block only ever runs once
    // this function has already returned a path.
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

interface MintAttempt {
  readonly outcome: Outcome<DashboardsCredential>;
  /**
   * The generated key name, recorded as soon as `cf create-service-key` is
   * ATTEMPTED rather than after it returns: a create that times out may still
   * have been applied by the broker, and that orphan would otherwise never be
   * cleaned up. The name is unique to this run, so acting on it can never
   * touch a key anyone else created.
   */
  readonly createdKeyName?: string;
}

async function confirmThenMint(
  instance: string,
  ctx: CfExecContext,
  report: StepReporter,
): Promise<MintAttempt> {
  let createdKeyName: string | undefined;
  try {
    await confirmSamlUpdate(instance, ctx, report);
    const keyName = `cf-otel-${randomBytes(4).toString("hex")}`;
    createdKeyName = keyName;
    report(`cf create-service-key ${instance} ${keyName}`);
    await cfCreateServiceKey(instance, keyName, ctx);
    const payload = parseCredentialJson(await cfServiceKey(instance, keyName, ctx), `service key payload for "${keyName}"`);
    const credential = extractDashboardsCredential(payload, `minted:${keyName}`);
    if (credential === undefined) {
      throw new CfOtelError(
        "CREDENTIALS_NOT_FOUND",
        `Minted key "${keyName}" on "${instance}" did not contain dashboards-username/dashboards-password.`,
      );
    }
    return { outcome: { ok: true, value: credential }, createdKeyName: keyName };
  } catch (error) {
    return { outcome: { ok: false, error }, ...(createdKeyName === undefined ? {} : { createdKeyName }) };
  }
}

/**
 * Remove the key this run created but could not use, and describe the orphan
 * if even that fails.
 *
 * Best effort by design: the minting failure the caller is about to report is
 * the useful error, so a cleanup problem must never replace it. Returns a
 * sentence to append to that error when the key is still there, because an
 * orphaned key on a shared instance is worth saying without `--verbose` — and
 * every retry of this path would otherwise leave another one behind.
 */
async function cleanUpUnusableKey(
  instance: string,
  attempt: MintAttempt,
  ctx: CfExecContext,
  report: StepReporter,
): Promise<string | undefined> {
  const keyName = attempt.createdKeyName;
  // A successful mint's key IS the credential being returned, and a failure
  // that happened before any name was generated left nothing behind.
  if (attempt.outcome.ok || keyName === undefined) {
    return undefined;
  }
  report(`cf delete-service-key ${instance} ${keyName} -f (removing the key this run could not use)`);
  try {
    await cfDeleteServiceKey(instance, keyName, ctx);
    return undefined;
  } catch (error) {
    report(`could not delete the minted key "${keyName}": ${errorMessage(error)}`);
    return (
      ` The service key "${keyName}" created during this attempt could not be deleted ` +
      `(${errorMessage(error)}), so it is still on the instance; remove it with: ` +
      `cf delete-service-key ${instance} ${keyName} -f`
    );
  }
}

/**
 * Re-raise a minting failure with the orphaned-key sentence appended, keeping
 * the original error's code so callers can still branch on it.
 */
function withKeyNote(error: unknown, note: string | undefined): unknown {
  if (note === undefined) {
    return error;
  }
  if (error instanceof CfOtelError) {
    return new CfOtelError(error.code, `${error.message}${note}`, { cause: error });
  }
  return new Error(`${errorMessage(error)}${note}`, { cause: error });
}

/**
 * A mint that succeeded while the restore failed is the one failure branch
 * where the key is deliberately NOT deleted: it holds a working dashboards
 * credential that this run is about to throw away by raising, so removing it
 * too would destroy the only thing the attempt actually achieved. Name it
 * instead, so it is not left behind silently.
 */
function retainedKeyNote(instance: string, attempt: MintAttempt): string {
  const keyName = attempt.createdKeyName;
  if (!attempt.outcome.ok || keyName === undefined) {
    return "";
  }
  return (
    ` The key "${keyName}" minted during this run was kept rather than deleted, because it holds a ` +
    `working dashboards credential; remove it with cf delete-service-key ${instance} ${keyName} -f ` +
    "once it is no longer needed."
  );
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
    throw new CfOtelError(
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
  // Deliberately after the restore, never before it: a cleanup call that hangs
  // would extend the window in which SSO is disabled for every user of this
  // instance, and waiting for the restore's own confirmation also guarantees
  // no broker operation is still in flight when the delete is issued.
  const orphanNote = await cleanUpUnusableKey(instance, mintResult, ctx, report);

  if (!restoreResult.ok) {
    const context = mintResult.outcome.ok
      ? ""
      : ` The credential-minting step had also failed: ${errorMessage(mintResult.outcome.error)}.`;
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
    throw new SamlRestoreFailedError(`${message}${orphanNote ?? ""}${retainedKeyNote(instance, mintResult)}`, {
      cause: restoreResult.error,
    });
  }
  if (!mintResult.outcome.ok) {
    throw withKeyNote(mintResult.outcome.error, orphanNote);
  }
  return mintResult.outcome.value;
}
