export const CLI_NAME = "cf-hana";
export const CLI_VERSION = "0.3.4";
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
export const MAX_RESULT_STORE_BYTES = 256 * 1024 * 1024;
export const HANA_CLOUD_DEFAULT_PORT = 443;

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
