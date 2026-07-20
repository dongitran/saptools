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
  // How many top-level roots (locals/block variables/this/return) a frame may
  // show at all. Kept separate from graphLimits.maxProperties, which bounds
  // only the property fan-out of an individual captured object.
  readonly maxRootVars: number;
}

interface CollectedFrameRoots {
  readonly roots: Readonly<Record<string, RemoteObject>>;
  readonly truncated: boolean;
}

function isCapturedScope(type: string): boolean {
  return type === "local" || type === "block" || type === "catch";
}

// V8 reports exactly one "local"-type scope per frame: the function's own
// parameter/top-level-local activation record. Any "block"/"catch" scopes are
// nested if/for/try locals the function declared inside its own body.
function isLocalScope(type: string): boolean {
  return type === "local";
}

interface EligibleScope {
  readonly scopeIndex: number;
  readonly type: string;
  readonly objectId: string;
}

function toEligibleScope(entry: readonly [number, PausedScope]): EligibleScope | undefined {
  const [scopeIndex, scope] = entry;
  if (!isCapturedScope(scope.type) || scope.objectId === undefined) {
    return undefined;
  }
  return { scopeIndex, type: scope.type, objectId: scope.objectId };
}

// Tiers the frame's scope chain by declaration kind instead of trusting V8's
// live scope-chain index: nested block/try/catch scopes the code happens to
// have entered enroll at LOWER indices than the function's own parameter
// scope, so a plain index- or name-based order would let inner-block locals
// (loggers, framework singletons declared with a nested `const`) outrank the
// function's own parameters. Relative order within each tier is preserved.
function partitionScopes(frame: PausedFrame): {
  readonly localScopes: readonly EligibleScope[];
  readonly blockScopes: readonly EligibleScope[];
} {
  const scopes = [...frame.scopeChain.entries()]
    .map(toEligibleScope)
    .filter((scope): scope is EligibleScope => scope !== undefined);
  return {
    localScopes: scopes.filter((scope) => isLocalScope(scope.type)),
    blockScopes: scopes.filter((scope) => !isLocalScope(scope.type)),
  };
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

async function addScopeChainRoots(
  roots: Record<string, RemoteObject>,
  scopes: readonly EligibleScope[],
  client: RemoteObjectClient,
  maxRoots: number,
): Promise<boolean> {
  let truncated = false;
  for (const scope of scopes) {
    try {
      const descriptors = await client.getProperties(scope.objectId);
      truncated = addScopeProperties(roots, scope.type, scope.scopeIndex, descriptors, maxRoots) || truncated;
    } finally {
      await client.releaseObject(scope.objectId);
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

// Root insertion order IS capture priority order (remote-object.ts now walks
// roots in the order it receives them, not alphabetically): the function's
// own computed return value and its own parameters/locals are captured
// first, then its own nested-block locals, and only then `this` — the
// framework/service-graph object most likely to be large and least likely to
// be what a debugging agent needs first.
async function collectFrameRoots(
  frame: PausedFrame,
  client: RemoteObjectClient,
  maxRoots: number,
): Promise<CollectedFrameRoots> {
  const roots: Record<string, RemoteObject> = {};
  const { localScopes, blockScopes } = partitionScopes(frame);
  let truncated = addSpecialRoot(roots, "return", frame.returnValue, maxRoots);
  truncated = (await addScopeChainRoots(roots, localScopes, client, maxRoots)) || truncated;
  truncated = (await addScopeChainRoots(roots, blockScopes, client, maxRoots)) || truncated;
  truncated = addSpecialRoot(roots, "this", frame.thisValue, maxRoots) || truncated;
  return { roots, truncated };
}

async function captureFrame(
  frame: PausedFrame,
  client: RemoteObjectClient,
  limits: GraphCaptureLimits,
  maxRootVars: number,
): Promise<CapturedFrameState> {
  const collected = await collectFrameRoots(frame, client, maxRootVars);
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
    frames.push(await captureFrame(frame, client, { ...input.graphLimits, maxBytes: perFrameBytes }, input.maxRootVars));
  }
  const appFrameCount = input.frames.filter((frame) => isAppOwnedScript(frame.url, input.appRoots)).length;
  return fitCapturedState(frames, appFrameCount > selected.length, input.graphLimits.maxBytes);
}
