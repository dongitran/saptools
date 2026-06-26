export type {
  CfTarget,
  ArtifactName,
  ExportArtifactsOptions,
  ExportArtifactsResult,
  CfExecContext,
} from "./types.js";

export { ARTIFACT_NAMES } from "./types.js";
export { getAllArtifactNames } from "./exporter.js";

export { exportArtifacts } from "./exporter.js";

export { formatExportCompletionMessage } from "./format.js";

export { fetchDefaultEnvJson } from "./default-env.js";

export {
  fetchRemoteTextFile,
  buildRemoteFilePaths,
  buildCatCommand,
  parseRemoteFileContent,
  REMOTE_CONTENT_SENTINEL,
} from "./remote-paths.js";

export { openCfSession } from "./session.js";
export type { OpenCfSession, SessionEnv } from "./session.js";
export { resolveApiEndpoint, resolveSessionEnv } from "./session.js";

// Note: cf* functions (cfApi etc) and low-level are provided by our local cf.ts
// (which extends the pattern from cf-files with cfCurl + test .mjs support).
// Consumers wanting pure cf-files primitives can import directly from @saptools/cf-files.

export {
  cfApi,
  cfAuth,
  cfTargetSpace,
  cfAppGuid,
  cfCurl,
  cfSsh,
  cfSshBuffer,
} from "./cf.js";
