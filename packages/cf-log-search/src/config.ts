import { readPackageMetadata } from "@saptools/core";

export const CLI_NAME = "cf-log-search";
export const PACKAGE_NAME = "@saptools/cf-log-search";
export const CLI_VERSION = readPackageMetadata(import.meta.url, PACKAGE_NAME).version;
export const ENV_PREFIX = "CF_LOG_SEARCH";

/** Verified live 2026-09-12: 41.1M docs, ~52 days retention at the time of writing — retention is volume/ILM-governed, not a fixed guarantee. See the design doc. */
export const DEFAULT_INDEX_PATTERN = "logs-cfsyslog-*";

/** `cf-otel`'s span index, in the same OpenSearch cluster and reachable with the same dashboards credential — verified live 2026-09-12, no new credential-discovery mechanism needed. */
export const OTEL_SPANS_INDEX_PATTERN = "otel-v1-apm-span-*";

/** OpenSearch's default `index.max_result_window`; confirmed unmodified on this index (checked its real `_settings`). */
export const MAX_RESULT_WINDOW = 10_000;

export const DEFAULT_SINCE = "1h";
export const DEFAULT_SEARCH_LIMIT = 100;
/** Hard cap independent of any time bound — 41M docs and climbing (~2.8M/24h measured), the same class of risk as cf-otel's already-fixed unbounded-`top` issue. */
export const MAX_ROWS_FETCHED = 5_000;
export const DEFAULT_PIT_KEEP_ALIVE = "1m";
/** Per-page size for `pitSearchAll` calls — not user-configurable, just an internal fetch-batching tuning knob. */
export const SEARCH_PAGE_SIZE = 500;

export const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

export const DEFAULT_RESULT_TTL_MINUTES = 10_080;
export const MAX_RESULT_STORE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_CREDENTIAL_TTL_MINUTES = 10_080;

export function envName(suffix: string): string {
  return `${ENV_PREFIX}_${suffix}`;
}

export function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function saptoolsRootFromEnv(): string | undefined {
  return readEnv(envName("SAPTOOLS_ROOT"));
}

export function credentialCacheEnabled(): boolean {
  const raw = readEnv(envName("CREDENTIAL_CACHE"));
  return raw === undefined || !/^(?:0|false|off|no)$/i.test(raw);
}

export interface SapCredentials {
  readonly email: string;
  readonly password: string;
}

export interface SapCredentialOverrides {
  readonly email?: string | undefined;
  readonly password?: string | undefined;
}

export function readSapCredentials(overrides?: SapCredentialOverrides): SapCredentials | undefined {
  const email = overrides?.email ?? readEnv("SAP_EMAIL");
  const password = overrides?.password ?? readEnv("SAP_PASSWORD");
  if (email === undefined || password === undefined) {
    return undefined;
  }
  return { email, password };
}
