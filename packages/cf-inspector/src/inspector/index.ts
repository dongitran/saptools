export { setBreakpoint, removeBreakpoint } from "./breakpoints.js";
export { discoverInspectorTargets, fetchInspectorVersion } from "./discovery.js";
export { waitForPause } from "./pause.js";
export {
  evaluateGlobal,
  evaluateOnFrame,
  getProperties,
  listScripts,
  resume,
  validateExpression,
} from "./runtime.js";
export { connectInspector } from "./session.js";
export type {
  CdpEvalResult,
  CdpProperty,
  DebuggerState,
  InspectorSession,
  InspectorTarget,
  PauseWaitGate,
  SetBreakpointInput,
  WaitForPauseOptions,
} from "./types.js";
