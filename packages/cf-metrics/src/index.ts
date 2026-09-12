import { createResultSession } from "@saptools/core";
import type { CreateResultSessionInput, ResultSession, ResultStoreOptions } from "@saptools/core";

export { clearCredentialCache, deleteCachedCredential, discoverServiceInstance, listCachedCredentials, listCloudLoggingInstances, readCachedCredential, writeCachedCredential } from "@saptools/core";
export type { CachedCredentialSummary, CloudLoggingInstance, CredentialCacheKey, CredentialCacheOptions } from "@saptools/core";
export { discoverDashboardsCredential } from "@saptools/core";
export type { CredentialDiscoveryOptions } from "@saptools/core";
export { credentialCacheOptionsFromEnv, resultStoreOptionsFromEnv } from "./config.js";
export {
  CfMetricsError,
  CredentialsNotFoundError,
  errorMessage,
  isAuthRejection,
  SamlRestoreFailedError,
} from "./errors.js";
export type { CfMetricsErrorCode } from "./errors.js";
export { formatCsv, formatJson, formatJsonCompact, formatResult, formatTable } from "./format.js";
export type { OutputRow } from "./format.js";
export { queryHistory, resolveMetricKind } from "./history.js";
export type { HistoryQueryOptions, HistoryResult, KindLookupWindow, KindResolution } from "./history.js";
export { buildKindSubAggs, isCumulativeTemporality, parseMetricKind, shapeHistoryBucket } from "./kind.js";
export type { MetricKind } from "./kind.js";
export { listAllFieldNames, lookUpField } from "./mapping.js";
export type { FieldLookup, FieldMapping } from "./mapping.js";
export { queryNames } from "./names.js";
export type { NamesQueryOptions } from "./names.js";
export { createOpenSearchClient, encodeConsoleProxyPath, searchAfterAll } from "@saptools/core";
export type { OpenSearchClient, OpenSearchClientOptions, PagedSearchResult, SearchHit, SearchResponse } from "@saptools/core";
// The validators ship alongside the builder deliberately: `buildMetricBoolQuery`
// forwards an absolute bound verbatim, so without them a library consumer has no
// way to reject one the backend will refuse — a gap `@saptools/cf-otel` did not
// have, since its own `resolveTimeBound` validates as it resolves.
export { assertValidTimeBoundShape, assertValidTimeRange, buildMetricBoolQuery, isAbsoluteInstant, resolveTimeBound } from "./query-builder.js";
export { clearResultSessions, listResultSessions, pruneResultSessions, readResultSession } from "@saptools/core";
export type { CreateResultSessionInput, PruneOutcome, ResultSession, ResultSessionSummary } from "@saptools/core";
export { mintDashboardsCredential, redactForLog } from "./saml-toggle.js";
export { querySnapshot } from "./snapshot.js";
export type { SnapshotQueryOptions, SnapshotResult } from "./snapshot.js";
export { printResolvedTarget, resolveTarget } from "@saptools/core";
export type { TargetOptions } from "@saptools/core";
export { queryTop } from "./top.js";
export type { TopQueryOptions, TopResult } from "./top.js";
export type {
  DashboardsCredential,
  DashboardsCredentialPayload,
  OutputFormat,
  ResolvedTarget,
  SelectorSource,
} from "./types.js";
export { watchMetrics } from "./watch.js";
export type { WatchPollOptions } from "./watch.js";

/**
 * Preserves cf-metrics's pre-migration `tryCreateResultSession` re-export:
 * `@saptools/core`'s shared result-store deliberately has no equivalent (it
 * is CLI-agnostic and does not decide whether a failed save should be
 * swallowed — see `assertResultStoreWritable` for the pattern it offers
 * instead), so this small wrapper is the one piece of the old local
 * `result-store.ts` kept alive rather than deleted outright.
 */
export async function tryCreateResultSession<TRow>(
  input: CreateResultSessionInput<TRow>,
  options: Omit<ResultStoreOptions, "cliName"> = {},
): Promise<ResultSession<TRow> | undefined> {
  try {
    return await createResultSession(input, options);
  } catch {
    return undefined;
  }
}
