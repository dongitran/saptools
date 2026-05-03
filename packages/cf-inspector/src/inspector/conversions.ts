import type {
  CallFrameInfo,
  PauseEvent,
  ResolvedLocation,
  ScriptInfo,
  ScopeInfo,
} from "../types.js";

import type {
  CdpCallFrame,
  CdpPauseParams,
  CdpResolvedLocation,
  CdpScope,
} from "./types.js";

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function toResolvedLocations(value: unknown): readonly ResolvedLocation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): ResolvedLocation[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const candidate = entry as CdpResolvedLocation;
    const scriptId = asString(candidate.scriptId);
    if (scriptId.length === 0) {
      return [];
    }
    const url = typeof candidate.url === "string" ? candidate.url : undefined;
    const lineNumber = asNumber(candidate.lineNumber);
    const result: ResolvedLocation = url === undefined
      ? { scriptId, lineNumber, columnNumber: asNumber(candidate.columnNumber) }
      : { scriptId, url, lineNumber, columnNumber: asNumber(candidate.columnNumber) };
    return [result];
  });
}

function toScopeChain(value: unknown): readonly ScopeInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): ScopeInfo[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const candidate = entry as CdpScope;
    const type = asString(candidate.type);
    if (type.length === 0) {
      return [];
    }
    const objectId = typeof candidate.object?.objectId === "string" ? candidate.object.objectId : undefined;
    const name = typeof candidate.name === "string" ? candidate.name : undefined;
    const base: ScopeInfo = name === undefined
      ? { type }
      : { type, name };
    return [objectId === undefined ? base : { ...base, objectId }];
  });
}

function resolveCallFrameUrl(
  frame: CdpCallFrame,
  scripts: ReadonlyMap<string, ScriptInfo> | undefined,
): string | undefined {
  const direct = nonEmptyString(frame.url);
  if (direct !== undefined) {
    return direct;
  }
  const scriptId = nonEmptyString(frame.location?.scriptId);
  if (scriptId === undefined) {
    return undefined;
  }
  return nonEmptyString(scripts?.get(scriptId)?.url);
}

function toCallFrames(
  value: unknown,
  scripts: ReadonlyMap<string, ScriptInfo> | undefined,
): readonly CallFrameInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): CallFrameInfo[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const candidate = entry as CdpCallFrame;
    const callFrameId = asString(candidate.callFrameId);
    if (callFrameId.length === 0) {
      return [];
    }
    const url = resolveCallFrameUrl(candidate, scripts);
    const base: CallFrameInfo = {
      callFrameId,
      functionName: asString(candidate.functionName),
      lineNumber: asNumber(candidate.location?.lineNumber),
      columnNumber: asNumber(candidate.location?.columnNumber),
      scopeChain: toScopeChain(candidate.scopeChain),
    };
    return [url === undefined ? base : { ...base, url }];
  });
}

export function toPauseEvent(
  params: CdpPauseParams,
  receivedAtMs: number,
  scripts?: ReadonlyMap<string, ScriptInfo>,
): PauseEvent {
  return {
    reason: asString(params.reason),
    hitBreakpoints: Array.isArray(params.hitBreakpoints)
      ? params.hitBreakpoints.filter((id): id is string => typeof id === "string")
      : [],
    callFrames: toCallFrames(params.callFrames, scripts),
    receivedAtMs,
  };
}

function topFrameLocation(pause: PauseEvent): string {
  const top = pause.callFrames[0];
  if (top === undefined) {
    return "(no call frame)";
  }
  const url = top.url !== undefined && top.url.length > 0 ? top.url : "(unknown)";
  return `${url}:${(top.lineNumber + 1).toString()}:${(top.columnNumber + 1).toString()}`;
}

export function pauseDetail(pause: PauseEvent): string {
  return JSON.stringify({
    reason: pause.reason,
    hitBreakpoints: pause.hitBreakpoints,
    topFrame: topFrameLocation(pause),
  });
}
