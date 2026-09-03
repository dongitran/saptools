export { getFlatAttribute, listFlatAttributeKeys, pickIdentifyingAttribute } from "./attributes.js";
export { parseAttrFilter } from "./attr-filter.js";
export { discoverDashboardsCredential } from "./dashboards-credentials.js";
export type { CredentialDiscoveryOptions } from "./dashboards-credentials.js";
export { findDetachedCandidates, parseDetachedCandidates, sortDetachedCandidates } from "./detached.js";
export type { DetachedOptions } from "./detached.js";
export { computeDiff } from "./diff.js";
export {
  CfOtelError,
  CredentialsNotFoundError,
  errorMessage,
  SamlRestoreFailedError,
} from "./errors.js";
export type { CfOtelErrorCode } from "./errors.js";
export { formatCsv, formatJson, formatJsonCompact, formatResult, formatTable } from "./format.js";
export type { OutputRow } from "./format.js";
export { computeGaps } from "./gaps.js";
export type { ComputeGapsOptions } from "./gaps.js";
export { findFieldInMapping, getFieldMapping, resolveAggregatableField } from "./mapping.js";
export type { FieldMapping } from "./mapping.js";
export {
  createOpenSearchClient,
  encodeConsoleProxyPath,
  searchAfterAll,
} from "./opensearch-client.js";
export type { OpenSearchClient, OpenSearchClientOptions, PagedSearchResult, SearchHit, SearchResponse } from "./opensearch-client.js";
export { assertTimeBoundsValid, buildSpanBoolQuery, resolveTimeBound } from "./query-builder.js";
export {
  assertResultStoreWritable,
  clearResultSessions,
  createResultSession,
  listResultSessions,
  pruneResultSessions,
  readResultSession,
} from "./result-store.js";
export type { CreateResultSessionInput, PruneOutcome, ResultSession, ResultSessionSummary } from "./result-store.js";
export { mintDashboardsCredential, redactForLog } from "./saml-toggle.js";
export { computeSelftime } from "./selftime.js";
export { discoverServiceInstance, findBoundApps, listCloudLoggingInstances } from "./service-discovery.js";
export { hitToSpan } from "./span-mapper.js";
export { printResolvedTarget, resolveTarget } from "./target.js";
export type { TargetOptions } from "./target.js";
export { parseNanoTimestamp, toEpochNanos } from "./timestamps.js";
export type {
  AttrFilter,
  AttrOperator,
  DashboardsCredential,
  DetachedCandidate,
  DetachedResult,
  DiffResult,
  DiffRow,
  GapEntry,
  GapRegression,
  GapsResult,
  GapStats,
  OutputFormat,
  ResolvedTarget,
  SelectorSource,
  SelftimeAggregateRow,
  SelftimeResult,
  Span,
  SpanFilterOptions,
} from "./types.js";
