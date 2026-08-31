export const CLI_NAME = "cf-metrics";
/** Must equal `package.json`'s `version` — pinned by a unit test, since `--version` reports it. */
export const CLI_VERSION = "0.3.1";
export const ENV_PREFIX = "CF_METRICS";

export const DEFAULT_INDEX_PATTERN = "metrics-*";

/** OpenSearch's default `index.max_result_window` — a single `_search` page must stay under this. */
export const MAX_RESULT_WINDOW = 10_000;
/**
 * Sentinel `terms` aggregation bucket-size ceiling for a "`--limit 0` means
 * no limit" command (`names`, `top`) — high enough to capture effectively
 * every real-world bucket count without sending an unbounded size, which
 * risks tripping OpenSearch's own bucket-count circuit breaker.
 */
export const ALL_BUCKETS_TERMS_SIZE = 10_000;

/**
 * Bucket ceiling for the `units` terms aggregation `history`/`top` use to spot
 * a metric name publishing more than one series. Real names carry one unit;
 * `container.cpu.usage` carries two. Five leaves headroom without cost.
 */
export const MAX_UNITS_PER_METRIC = 5;

/** `per_page` for the v3 credential-bindings listing; CF caps this at 5000, 100 keeps one page for any realistic instance. */
export const BINDINGS_PAGE_SIZE = 100;
/** Hard stop on pagination, so a malformed `total_pages` can never loop forever. */
export const MAX_BINDING_PAGES = 20;
/** How many binding `/details` requests run at once — enough to hide latency without hammering the Cloud Controller. */
export const BINDING_PROBE_CONCURRENCY = 5;

export const DEFAULT_SAMPLE_LIMIT = 3;
export const DEFAULT_NAMES_LIMIT = 50;
export const DEFAULT_TOP_LIMIT = 20;
export const DEFAULT_SINCE = "2h";
export const DEFAULT_HISTORY_INTERVAL = "10m";
export const DEFAULT_WATCH_INTERVAL_MS = 15_000;
export const MIN_WATCH_INTERVAL_MS = 2_000;
export const DEFAULT_WATCH_LOOKBACK = "2m";

export const DEFAULT_RESULT_TTL_MINUTES = 10_080;
export const MAX_RESULT_STORE_BYTES = 256 * 1024 * 1024;

export const SAML_POLL_INTERVAL_MS = 3_000;
export const SAML_POLL_TIMEOUT_MS = 180_000;

/** Build a `CF_METRICS_*` environment variable name from a suffix. */
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
