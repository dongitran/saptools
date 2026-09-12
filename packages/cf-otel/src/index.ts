export {
  assertResultStoreWritable,
  clearCredentialCache,
  clearResultSessions,
  createOpenSearchClient,
  createResultSession,
  deleteCachedCredential,
  discoverDashboardsCredential,
  discoverServiceInstance,
  encodeConsoleProxyPath,
  listCachedCredentials,
  listCloudLoggingInstances,
  listResultSessions,
  printResolvedTarget,
  pruneResultSessions,
  readResultSession,
  resolveTarget,
  searchAfterAll,
} from "@saptools/core";
export type {
  CachedCredentialSummary,
  CreateResultSessionInput,
  CredentialCacheKey,
  CredentialCacheOptions,
  CredentialDiscoveryOptions,
  DashboardsCredential,
  DashboardsCredentialPayload,
  OpenSearchClient,
  OpenSearchClientOptions,
  PagedSearchResult,
  PruneOutcome,
  ResolvedTarget,
  ResultSession,
  ResultSessionSummary,
  SearchHit,
  SearchResponse,
  SelectorSource,
  TargetOptions,
} from "@saptools/core";
export { getFlatAttribute, listFlatAttributeKeys, pickIdentifyingAttribute } from "./attributes.js";
export { parseAttrFilter, resolveAndValidateAttrFilters } from "./attr-filter.js";
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
export { findFieldInMapping, getFieldMapping, listAllFieldNames, lookUpField, resolveAggregatableField } from "./mapping.js";
export type { FieldLookup, FieldMapping } from "./mapping.js";
export {
  assertTimeBoundsValid,
  buildSpanBoolQuery,
  resolveTimeBound,
  VCAP_REQUEST_ID_FIELD,
} from "./query-builder.js";
export { mintDashboardsCredential, redactForLog } from "./saml-toggle.js";
export { computeSelftime } from "./selftime.js";
export { hitToSpan } from "./span-mapper.js";
export { parseNanoTimestamp, toEpochNanos } from "./timestamps.js";
export type {
  AttrFilter,
  AttrOperator,
  DetachedCandidate,
  DetachedResult,
  DiffResult,
  DiffRow,
  GapEntry,
  GapRegression,
  GapsResult,
  GapStats,
  OutputFormat,
  SelftimeAggregateRow,
  SelftimeResult,
  Span,
  SpanFilterOptions,
} from "./types.js";
