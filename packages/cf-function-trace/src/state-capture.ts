import type { CapturedFrameState, CapturedState } from "./contracts.js";
import { TraceDataError } from "./errors.js";
import {
  captureRemoteValues,
  type GraphCaptureLimits,
  type RemoteObject,
  type RemoteObjectClient,
  type RemotePropertyDescriptor,
} from "./remote-object.js";
import { defineOwnValue } from "./safe-record.js";
import { isAppOwnedScript } from "./script-resolver.js";

const MIN_CAPTURED_STATE_BYTES = Buffer.byteLength('{"version":1,"frames":[],"completeness":"truncated"}');

export interface PausedScope {
  readonly type: string;
  readonly objectId?: string;
}

export interface PausedFrame {
  readonly functionName: string;
  readonly scriptId: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
  readonly scopeChain: readonly PausedScope[];
  readonly thisValue?: RemoteObject;
  readonly returnValue?: RemoteObject;
}

export interface CapturePausedStateInput {
  readonly frames: readonly PausedFrame[];
  readonly appRoots: readonly string[];
  readonly maxFrames: number;
  readonly graphLimits: GraphCaptureLimits;
}

interface CollectedFrameRoots {
  readonly roots: Readonly<Record<string, RemoteObject>>;
  readonly truncated: boolean;
}

function isCapturedScope(type: string): boolean {
  return type === "local" || type === "block" || type === "catch";
}

function addScopeProperties(
  roots: Record<string, RemoteObject>,
  scopeType: string,
  scopeIndex: number,
  descriptors: readonly RemotePropertyDescriptor[],
  maxRoots: number,
): boolean {
  let truncated = false;
  const sorted = [...descriptors].sort((left, right) => left.name.localeCompare(right.name));
  for (const descriptor of sorted) {
    if (descriptor.value !== undefined && descriptor.get === undefined && descriptor.set === undefined) {
      if (Object.keys(roots).length >= maxRoots) {
        truncated = true;
        continue;
      }
      defineOwnValue(roots, `scope.${scopeIndex.toString()}.${scopeType}.${descriptor.name}`, descriptor.value);
    }
  }
  return truncated;
}

function addSpecialRoot(roots: Record<string, RemoteObject>, name: string, value: RemoteObject | undefined, maxRoots: number): boolean {
  if (value === undefined) {
    return false;
  }
  if (Object.keys(roots).length >= maxRoots) {
    return true;
  }
  defineOwnValue(roots, name, value);
  return false;
}

async function collectFrameRoots(
  frame: PausedFrame,
  client: RemoteObjectClient,
  maxRoots: number,
): Promise<CollectedFrameRoots> {
  const roots: Record<string, RemoteObject> = {};
  let truncated = addSpecialRoot(roots, "this", frame.thisValue, maxRoots);
  truncated = addSpecialRoot(roots, "return", frame.returnValue, maxRoots) || truncated;
  for (const [scopeIndex, scope] of frame.scopeChain.entries()) {
    if (!isCapturedScope(scope.type) || scope.objectId === undefined) {
      continue;
    }
    try {
      const descriptors = await client.getProperties(scope.objectId);
      truncated = addScopeProperties(roots, scope.type, scopeIndex, descriptors, maxRoots) || truncated;
    } finally {
      await client.releaseObject(scope.objectId);
    }
  }
  return { roots, truncated };
}

async function captureFrame(
  frame: PausedFrame,
  client: RemoteObjectClient,
  limits: GraphCaptureLimits,
): Promise<CapturedFrameState> {
  const collected = await collectFrameRoots(frame, client, limits.maxProperties);
  const graph = await captureRemoteValues(client, collected.roots, limits);
  return {
    functionName: frame.functionName,
    scriptId: frame.scriptId,
    url: frame.url,
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
    ...graph,
    completeness: collected.truncated ? "truncated" : graph.completeness,
  };
}

function fitCapturedState(frames: readonly CapturedFrameState[], truncated: boolean, maxBytes: number): CapturedState {
  const bounded = [...frames];
  while (bounded.length > 0) {
    const candidate: CapturedState = {
      version: 1,
      frames: bounded,
      completeness: truncated || bounded.some((frame) => frame.completeness !== "complete") ? "truncated" : "complete",
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) {
      return candidate;
    }
    bounded.pop();
    truncated = true;
  }
  return { version: 1, frames: [], completeness: "truncated" };
}

export async function capturePausedState(
  input: CapturePausedStateInput,
  client: RemoteObjectClient,
): Promise<CapturedState> {
  if (input.graphLimits.maxBytes < MIN_CAPTURED_STATE_BYTES) {
    throw new TraceDataError("INVALID_ARGUMENT", "The state byte limit is too small for a valid capture envelope.");
  }
  const selected = input.frames
    .filter((frame) => isAppOwnedScript(frame.url, input.appRoots))
    .slice(0, input.maxFrames);
  const frames: CapturedFrameState[] = [];
  const perFrameBytes = Math.max(128, Math.floor(input.graphLimits.maxBytes / Math.max(selected.length, 1)));
  for (const frame of selected) {
    frames.push(await captureFrame(frame, client, { ...input.graphLimits, maxBytes: perFrameBytes }));
  }
  const appFrameCount = input.frames.filter((frame) => isAppOwnedScript(frame.url, input.appRoots)).length;
  return fitCapturedState(frames, appFrameCount > selected.length, input.graphLimits.maxBytes);
}
