import { readPackageMetadata } from "@saptools/core";

export const CLI_NAME = "cf-otel";
export const PACKAGE_NAME = "@saptools/cf-otel";
/** Read from package.json at runtime, so `--version` and the self-updater can never drift from the manifest. */
export const CLI_VERSION = readPackageMetadata(import.meta.url, PACKAGE_NAME).version;
export const ENV_PREFIX = "CF_OTEL";

export const DEFAULT_INDEX_PATTERN = "otel-v1-apm-span-*";

export const DEFAULT_SAMPLE_LIMIT = 3;
export const DEFAULT_FIND_LIMIT = 5;
export const DEFAULT_TOP_LIMIT = 10;
export const DEFAULT_SELFTIME_TOP = 20;
export const DEFAULT_DETACHED_LIMIT = 20;
export const DEFAULT_DETACHED_PADDING_SECONDS = 2;
export const DEFAULT_DIFF_TOP = 20;
export const DEFAULT_GAPS_TOP = 3;

/** OpenSearch's default `index.max_result_window` — a single `_search` page must stay under this. */
export const MAX_RESULT_WINDOW = 10_000;
export const SPANS_PAGE_SIZE = 1_000;
/** Hard ceiling on total spans fetched for one trace, regardless of how many actually exist. */
export const MAX_SPANS_FETCHED = 50_000;

export const DEFAULT_RESULT_TTL_MINUTES = 10_080;
export const DEFAULT_RESULT_SEARCH_LIMIT = 20;
export const MAX_RESULT_STORE_BYTES = 256 * 1024 * 1024;

export const SAML_POLL_INTERVAL_MS = 3_000;
export const SAML_POLL_TIMEOUT_MS = 180_000;

/** Build a `CF_OTEL_*` environment variable name from a suffix. */
export function envName(suffix: string): string {
  return `${ENV_PREFIX}_${suffix}`;
}

/** Read an environment variable, treating blank values as absent. */
export function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export interface SapCredentials {
  readonly email: string;
  readonly password: string;
}

export interface SapCredentialOverrides {
  readonly email?: string | undefined;
  readonly password?: string | undefined;
}

/**
 * Resolve SAP BTP credentials from explicit overrides, falling back to the
 * repo-wide `SAP_EMAIL` / `SAP_PASSWORD` environment variables. Returns
 * `undefined` when either half is missing.
 */
export function readSapCredentials(
  overrides?: SapCredentialOverrides,
): SapCredentials | undefined {
  const email = overrides?.email ?? readEnv("SAP_EMAIL");
  const password = overrides?.password ?? readEnv("SAP_PASSWORD");
  if (email === undefined || password === undefined) {
    return undefined;
  }
  return { email, password };
}
