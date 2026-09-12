export { findPackageMetadata, readPackageManifest, readPackageMetadata } from "./package-metadata.js";
export type { PackageMetadata } from "./package-metadata.js";
export { errorMessage, isRecord, readString } from "./records.js";
export {
  ensurePrivateDirectorySync,
  readJsonFileSync,
  resolveSaptoolsRoot,
  SAPTOOLS_DIR_NAME,
  SAPTOOLS_ROOT_ENV,
  writeFileAtomicSync,
} from "./saptools-paths.js";
export {
  attachSelfUpdate,
  commandPathOf,
  describeOutcome,
  formatSelfUpdateStatus,
  registerSelfUpdateCommand,
} from "./self-update/commander.js";
export type { AttachSelfUpdateOptions, SelfUpdateCommandOptions } from "./self-update/commander.js";
export { detectInstallLocation, isUpgradableKind } from "./self-update/install-location.js";
export type { DetectInstallLocationOptions, InstallKind, InstallLocation } from "./self-update/install-location.js";
export { buildInstallCommand, DEFAULT_INSTALL_TIMEOUT_MS, manualInstallCommand, runInstall } from "./self-update/installer.js";
export type { BuildInstallCommandOptions, InstallCommand, InstallResult, RunInstallOptions } from "./self-update/installer.js";
export {
  DEBUG_ENV,
  DEFAULT_CHECK_INTERVAL_MINUTES,
  INTERVAL_ENV,
  isTruthyFlag,
  parsePolicy,
  POLICY_ENV,
  resolveCheckIntervalMs,
  resolveUpdatePolicy,
  SELF_UPDATE_COMMAND,
} from "./self-update/policy.js";
export type { PolicyDecision, ResolvePolicyInput, UpdatePolicy } from "./self-update/policy.js";
export type { SpawnLike } from "./self-update/process-types.js";
export { buildReexecArgv, reexecEnvironment, REEXEC_MARKER_ENV, reexecProcess } from "./self-update/reexec.js";
export type { ReexecImpl, ReexecRequest, ReexecRuntime } from "./self-update/reexec.js";
export {
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_NPM_REGISTRY,
  fetchLatestVersion,
  normalizeRegistryUrl,
  readUserNpmrc,
  REGISTRY_ENV,
  resolveRegistryUrl,
} from "./self-update/registry.js";
export type { FetchLatestOptions, LatestVersionResult } from "./self-update/registry.js";
export { inspectSelfUpdate, runSelfUpdate } from "./self-update/run.js";
export type { SelfUpdateOptions, SelfUpdateOutcome, SelfUpdateRuntime, SelfUpdateStatus } from "./self-update/run.js";
export { compareSemver, isNewerRelease, parseSemver } from "./self-update/semver.js";
export type { SemanticVersion } from "./self-update/semver.js";
export {
  acquireUpdateLock,
  DEFAULT_LOCK_STALE_MS,
  EMPTY_UPDATE_STATE,
  readUpdateState,
  updateLockPath,
  updateStateFileName,
  updateStatePath,
  UPDATES_DIRECTORY_NAME,
  writeUpdateState,
} from "./self-update/state.js";
export type { InstallAttempt, UpdateLock, UpdateState } from "./self-update/state.js";
export {
  createOpenSearchClient,
  encodeConsoleProxyPath,
  isAuthRejection,
  OpenSearchRequestError,
  searchAfterAll,
} from "./cloud-logging/opensearch-client.js";
export type { OpenSearchClient, OpenSearchClientOptions, PagedSearchResult, SearchHit, SearchResponse } from "./cloud-logging/opensearch-client.js";
export { discoverDashboardsCredential } from "./cloud-logging/dashboards-credentials.js";
export type { CredentialDiscoveryOptions, SapCredentials } from "./cloud-logging/dashboards-credentials.js";
export { discoverServiceInstance, listCloudLoggingInstances } from "./cloud-logging/instance-discovery.js";
export { extractDashboardsCredential, parseCredentialJson } from "./cloud-logging/dashboards-payload.js";
export { clearCredentialCache, deleteCachedCredential, listCachedCredentials, readCachedCredential, writeCachedCredential } from "./cloud-logging/credential-cache.js";
export type { CachedCredentialSummary, CredentialCacheKey, CredentialCacheOptions } from "./cloud-logging/credential-cache.js";
export { printResolvedTarget, resolveTarget } from "./cloud-logging/target.js";
export type { TargetOptions } from "./cloud-logging/target.js";
export {
  assertResultStoreWritable,
  clearResultSessions,
  createResultSession,
  listResultSessions,
  pruneResultSessions,
  readResultSession,
} from "./cloud-logging/result-store.js";
export type { CreateResultSessionInput, PruneOutcome, ResultSession, ResultSessionSummary, ResultStoreOptions } from "./cloud-logging/result-store.js";
export type {
  CfExecContext,
  CloudLoggingCfExecutor,
  CloudLoggingInstance,
  CurrentCfTarget,
  DashboardsCredential,
  DashboardsCredentialPayload,
  ResolvedTarget,
  SelectorSource,
} from "./cloud-logging/types.js";
export { trackTempDir, untrackTempDir } from "./temp-dir-tracking.js";
