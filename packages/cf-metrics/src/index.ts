export { discoverDashboardsCredential } from "./dashboards-credentials.js";
export type { CredentialDiscoveryOptions } from "./dashboards-credentials.js";
export {
  CfMetricsError,
  CredentialsNotFoundError,
  errorMessage,
  SamlRestoreFailedError,
} from "./errors.js";
export type { CfMetricsErrorCode } from "./errors.js";
export { formatCsv, formatJson, formatJsonCompact, formatResult, formatTable } from "./format.js";
export type { OutputRow } from "./format.js";
export { queryHistory, resolveMetricKind } from "./history.js";
export type { HistoryQueryOptions, HistoryResult } from "./history.js";
export { buildKindSubAggs, isCumulativeTemporality, parseMetricKind, shapeHistoryBucket } from "./kind.js";
export type { MetricKind } from "./kind.js";
export { queryNames } from "./names.js";
export type { NamesQueryOptions } from "./names.js";
export {
  createOpenSearchClient,
  encodeConsoleProxyPath,
  searchAfterAll,
} from "./opensearch-client.js";
export type { OpenSearchClient, OpenSearchClientOptions, PagedSearchResult, SearchHit, SearchResponse } from "./opensearch-client.js";
export { buildMetricBoolQuery, resolveTimeBound } from "./query-builder.js";
export {
  clearResultSessions,
  createResultSession,
  listResultSessions,
  pruneResultSessions,
  readResultSession,
  tryCreateResultSession,
} from "./result-store.js";
export type { CreateResultSessionInput, ResultSession, ResultSessionSummary } from "./result-store.js";
export { mintDashboardsCredential, redactForLog } from "./saml-toggle.js";
export { discoverServiceInstance, findBoundApps, listCloudLoggingInstances } from "./service-discovery.js";
export { querySnapshot } from "./snapshot.js";
export type { SnapshotQueryOptions } from "./snapshot.js";
export { printResolvedTarget, resolveTarget } from "./target.js";
export type { TargetOptions } from "./target.js";
export { queryTop } from "./top.js";
export type { TopQueryOptions, TopResult } from "./top.js";
export type { DashboardsCredential, OutputFormat, ResolvedTarget, SelectorSource } from "./types.js";
export { watchMetrics } from "./watch.js";
export type { WatchPollOptions } from "./watch.js";
