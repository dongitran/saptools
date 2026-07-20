import {
  connectInspector,
  openOwnedCfTunnel,
  type InspectorSession,
} from "@saptools/cf-inspector";

import { getSharedProcessGuard } from "./process-guard.js";
import { withTraceSession, type TraceSessionDependencies, type TraceTarget } from "./session.js";

const defaultDependencies: TraceSessionDependencies<InspectorSession> = {
  connectInspector,
  openCfTunnel: openOwnedCfTunnel,
};

export async function withDefaultTraceSession<TResult>(
  target: TraceTarget,
  callback: (session: InspectorSession) => Promise<TResult>,
  signal?: AbortSignal,
): Promise<TResult> {
  return await withTraceSession(target, callback, defaultDependencies, signal, getSharedProcessGuard());
}
