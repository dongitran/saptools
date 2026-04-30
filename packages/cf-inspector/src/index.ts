export { CfInspectorError } from "./types.js";
export type {
  BreakpointHandle,
  BreakpointLocation,
  CallFrameInfo,
  CapturedExpression,
  CfInspectorErrorCode,
  FrameSnapshot,
  InspectorConnectOptions,
  PauseEvent,
  RemoteRootSetting,
  ResolvedLocation,
  ScopeInfo,
  ScopeSnapshot,
  SnapshotCaptureResult,
  ScriptInfo,
  SnapshotResult,
  VariableSnapshot,
} from "./types.js";

export {
  buildBreakpointUrlRegex,
  parseBreakpointSpec,
  parseRemoteRoot,
} from "./pathMapper.js";

export {
  connectInspector,
  discoverInspectorTargets,
  evaluateGlobal,
  evaluateOnFrame,
  fetchInspectorVersion,
  getProperties,
  listScripts,
  removeBreakpoint,
  resume,
  setBreakpoint,
  validateExpression,
  waitForPause,
} from "./inspector.js";
export type {
  InspectorSession,
  InspectorTarget,
  SetBreakpointInput,
  WaitForPauseOptions,
} from "./inspector.js";

export { captureSnapshot } from "./snapshot.js";
export type { CaptureSnapshotOptions } from "./snapshot.js";

export { buildLogpointCondition, streamLogpoint } from "./logpoint.js";
export type {
  LogpointEvent,
  LogpointStreamOptions,
  LogpointStreamResult,
} from "./logpoint.js";

export { openCfTunnel } from "./tunnel.js";
export type { OpenedTunnel, TunnelTarget } from "./tunnel.js";
