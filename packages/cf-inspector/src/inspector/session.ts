import { performance } from "node:perf_hooks";

import { CdpClient } from "../cdp/client.js";
import { CfInspectorError } from "../types.js";
import type { InspectorConnectOptions, PauseEvent, ScriptInfo } from "../types.js";

import { asString, toPauseEvent } from "./conversions.js";
import { discoverInspectorTargets } from "./discovery.js";
import type { CdpPauseParams, DebuggerState, InspectorSession, ScriptParsedParams } from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_HOST = "127.0.0.1";
const PAUSE_BUFFER_LIMIT = 32;

export async function connectInspector(options: InspectorConnectOptions): Promise<InspectorSession> {
  const host = options.host ?? DEFAULT_HOST;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const targets = await discoverInspectorTargets(host, options.port, connectTimeoutMs);
  const target = targets[0];
  if (!target) {
    throw new CfInspectorError(
      "INSPECTOR_DISCOVERY_FAILED",
      `No inspector targets available on ${host}:${options.port.toString()}`,
    );
  }
  const client = await CdpClient.connect({
    url: target.webSocketDebuggerUrl,
    connectTimeoutMs,
  });
  try {
    return await initSession(client, target);
  } catch (err: unknown) {
    // The CdpClient is alive (its WS is open) but the inspector handshake
    // failed before we could hand the session to the caller. Dispose so the
    // underlying WS does not leak.
    client.dispose();
    throw err;
  }
}

async function initSession(
  client: CdpClient,
  target: InspectorSession["target"],
): Promise<InspectorSession> {
  const scripts = new Map<string, ScriptInfo>();
  client.on("Debugger.scriptParsed", (raw) => {
    const params = raw as ScriptParsedParams;
    const scriptId = asString(params.scriptId);
    const url = asString(params.url);
    if (scriptId.length === 0) {
      return;
    }
    scripts.set(scriptId, { scriptId, url });
  });
  const pauseBuffer: PauseEvent[] = [];
  const pauseWaitGate = { active: false };
  const debuggerState: DebuggerState = {};
  client.on("Debugger.paused", (raw) => {
    if (pauseWaitGate.active) {
      return;
    }
    const params = raw as CdpPauseParams;
    const event = toPauseEvent(params, performance.now(), scripts);
    if (pauseBuffer.length >= PAUSE_BUFFER_LIMIT) {
      pauseBuffer.shift();
    }
    pauseBuffer.push(event);
  });
  client.on("Debugger.resumed", () => {
    debuggerState.lastResumedAtMs = performance.now();
  });
  await client.send("Runtime.enable");
  await client.send("Debugger.enable");
  return {
    client,
    target,
    scripts,
    pauseBuffer,
    pauseWaitGate,
    debuggerState,
    dispose: async (): Promise<void> => {
      try {
        await client.send("Debugger.disable");
      } catch {
        // best-effort
      }
      client.dispose();
    },
  };
}
