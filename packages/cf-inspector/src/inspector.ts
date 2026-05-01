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
} from "./inspector/index.js";
export type {
  CdpEvalResult,
  CdpProperty,
  DebuggerState,
  InspectorSession,
  InspectorTarget,
  PauseWaitGate,
  SetBreakpointInput,
  WaitForPauseOptions,
} from "./inspector/index.js";
