export const CLI_NAME = "cf-hana";
export const CLI_VERSION = "0.5.0";
export const ENV_PREFIX = "CF_HANA";

export const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
export const DEFAULT_POOL_MAX = 4;
export const DEFAULT_POOL_IDLE_MS = 60_000;
export const DEFAULT_AUTO_LIMIT = 100;
export const DEFAULT_CELL_LIMIT = 128;
export const MAX_CELL_LIMIT = 10_000;
export const DEFAULT_RESULT_TTL_MINUTES = 10_080;
export const DEFAULT_RESULT_SEARCH_LIMIT = 20;
const DEFAULT_MAX_RESULT_STORE_BYTES = 256 * 1024 * 1024;
export const MAX_RESULT_STORE_BYTES = resolveMaxResultStoreBytes();
export const HANA_CLOUD_DEFAULT_PORT = 443;

function resolvePositiveIntEnv(suffix: string, defaultValue: number): number {
  const raw = readEnv(envName(suffix));
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

/** Total wall-clock budget for the whole tunnel-fallback attempt, across every candidate. */
export const DEFAULT_TUNNEL_FALLBACK_BUDGET_MS = resolvePositiveIntEnv(
  "TUNNEL_FALLBACK_BUDGET_MS",
  25_000,
);
/** Secondary per-candidate ceiling; the shared budget above still wins if smaller. */
export const DEFAULT_TUNNEL_CANDIDATE_TIMEOUT_MS = resolvePositiveIntEnv(
  "TUNNEL_CANDIDATE_TIMEOUT_MS",
  15_000,
);
/** Additional jump-host apps tried beyond the target app itself. */
export const DEFAULT_TUNNEL_MAX_CANDIDATES = resolvePositiveIntEnv("TUNNEL_MAX_CANDIDATES", 3);
/** How long a spawned `cf ssh` forward is asked to stay open before it self-terminates. */
export const DEFAULT_TUNNEL_KEEPALIVE_SECONDS = resolvePositiveIntEnv(
  "TUNNEL_KEEPALIVE_SECONDS",
  1200,
);

function resolveMaxResultStoreBytes(): number {
  // The fake driver can lower the cap so E2E tests exercise refusal without
  // allocating hundreds of MiB. Real HANA connections always use the hard cap.
  if (readEnv(envName("DRIVER")) !== "fake") {
    return DEFAULT_MAX_RESULT_STORE_BYTES;
  }
  const raw = readEnv(envName("FAKE_MAX_STORE_BYTES"));
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_RESULT_STORE_BYTES;
}

/** Build a `CF_HANA_*` environment variable name from a suffix. */
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
