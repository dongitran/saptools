// cspell:words trustedtype wasmvalue webassemblymemory
import type {
  BreakLocation,
  CallFrameInfo,
  PauseEvent,
  RemoteObjectInfo,
  ResolvedLocation,
  ScriptInfo,
  ScriptLocation,
  ScopeInfo,
  StackTraceFrameInfo,
  StackTraceIdInfo,
  StackTraceInfo,
} from "../types.js";

const INTERNAL_SLOT_SUBTYPES = new Set([
  "regexp",
  "date",
  "map",
  "set",
  "weakmap",
  "weakset",
  "iterator",
  "generator",
  "promise",
  "typedarray",
  "arraybuffer",
  "dataview",
  "webassemblymemory",
  "wasmvalue",
  "trustedtype",
]);

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalCoordinate(value: unknown): number | undefined {
  const number = optionalNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function toScriptLocation(value: unknown): ScriptLocation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const scriptId = nonEmptyString(value["scriptId"]);
  const lineNumber = optionalCoordinate(value["lineNumber"]);
  if (scriptId === undefined || lineNumber === undefined) {
    return undefined;
  }
  const rawColumnNumber = value["columnNumber"];
  const columnNumber = optionalCoordinate(rawColumnNumber);
  if (rawColumnNumber !== undefined && columnNumber === undefined) {
    return undefined;
  }
  return columnNumber === undefined
    ? { scriptId, lineNumber }
    : { scriptId, lineNumber, columnNumber };
}

export function toResolvedLocations(value: unknown): readonly ResolvedLocation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): ResolvedLocation[] => {
    const location = toScriptLocation(entry);
    if (location === undefined || !isRecord(entry)) {
      return [];
    }
    const url = typeof entry["url"] === "string" ? entry["url"] : undefined;
    return [url === undefined ? location : { ...location, url }];
  });
}

export function toBreakLocations(value: unknown): readonly BreakLocation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): BreakLocation[] => {
    const location = toScriptLocation(entry);
    if (location === undefined || !isRecord(entry)) {
      return [];
    }
    const type = nonEmptyString(entry["type"]);
    return [type === undefined ? location : { ...location, type }];
  });
}

function remoteCompleteness(subtype: string | undefined): RemoteObjectInfo["completeness"] {
  if (subtype === "proxy") {
    return "unavailable";
  }
  return subtype !== undefined && INTERNAL_SLOT_SUBTYPES.has(subtype)
    ? "truncated"
    : undefined;
}

function optionalOwnField(
  key: string,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.hasOwn(value, key) ? { [key]: value[key] } : {};
}

export function toRemoteObject(value: unknown): RemoteObjectInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = nonEmptyString(value["type"]);
  if (type === undefined) {
    return undefined;
  }
  const subtype = nonEmptyString(value["subtype"]);
  const completeness = remoteCompleteness(subtype);
  return {
    type,
    ...(subtype === undefined ? {} : { subtype }),
    ...optionalTextField("className", value["className"]),
    ...(completeness === undefined ? {} : { completeness }),
    ...optionalOwnField("value", value),
    ...optionalTextField("unserializableValue", value["unserializableValue"]),
    ...optionalTextField("description", value["description"]),
    ...optionalOwnField("deepSerializedValue", value),
    ...optionalTextField("objectId", value["objectId"]),
    ...optionalOwnField("preview", value),
    ...optionalOwnField("customPreview", value),
  };
}

function optionalTextField(
  key: string,
  value: unknown,
): Readonly<Record<string, string>> {
  return typeof value === "string" ? { [key]: value } : {};
}

function toScope(value: unknown): ScopeInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = nonEmptyString(value["type"]);
  if (type === undefined) {
    return undefined;
  }
  const object = toRemoteObject(value["object"]);
  const name = nonEmptyString(value["name"]);
  const startLocation = toScriptLocation(value["startLocation"]);
  const endLocation = toScriptLocation(value["endLocation"]);
  return {
    type,
    ...(name === undefined ? {} : { name }),
    ...(object === undefined ? {} : { object }),
    ...(object?.objectId === undefined ? {} : { objectId: object.objectId }),
    ...(startLocation === undefined ? {} : { startLocation }),
    ...(endLocation === undefined ? {} : { endLocation }),
  };
}

function toScopeChain(value: unknown): readonly ScopeInfo[] {
  return Array.isArray(value)
    ? value.flatMap((entry): ScopeInfo[] => {
        const scope = toScope(entry);
        return scope === undefined ? [] : [scope];
      })
    : [];
}

function resolveCallFrameUrl(
  frame: Readonly<Record<string, unknown>>,
  scripts: ReadonlyMap<string, ScriptInfo> | undefined,
): string | undefined {
  const direct = nonEmptyString(frame["url"]);
  if (direct !== undefined) {
    return direct;
  }
  const scriptId = toScriptLocation(frame["location"])?.scriptId;
  return scriptId === undefined ? undefined : nonEmptyString(scripts?.get(scriptId)?.url);
}

function toCallFrameMetadata(
  candidate: Readonly<Record<string, unknown>>,
  location: ScriptLocation | undefined,
  scripts: ReadonlyMap<string, ScriptInfo> | undefined,
): Partial<CallFrameInfo> {
  const functionLocation = toScriptLocation(candidate["functionLocation"]);
  const thisObject = toRemoteObject(candidate["this"]);
  const returnValue = toRemoteObject(candidate["returnValue"]);
  const url = resolveCallFrameUrl(candidate, scripts);
  return {
    ...(location === undefined ? {} : { scriptId: location.scriptId }),
    ...(functionLocation === undefined ? {} : { functionLocation }),
    ...(url === undefined ? {} : { url }),
    ...(thisObject === undefined ? {} : { thisObject }),
    ...(returnValue === undefined ? {} : { returnValue }),
  };
}

function toCallFrame(
  value: unknown,
  scripts: ReadonlyMap<string, ScriptInfo> | undefined,
): CallFrameInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const callFrameId = nonEmptyString(value["callFrameId"]);
  if (callFrameId === undefined) {
    return undefined;
  }
  const location = toScriptLocation(value["location"]);
  return {
    callFrameId,
    functionName: asString(value["functionName"]),
    ...toCallFrameMetadata(value, location, scripts),
    lineNumber: location?.lineNumber ?? 0,
    columnNumber: location?.columnNumber ?? 0,
    scopeChain: toScopeChain(value["scopeChain"]),
  };
}

function toCallFrames(
  value: unknown,
  scripts: ReadonlyMap<string, ScriptInfo> | undefined,
): readonly CallFrameInfo[] {
  return Array.isArray(value)
    ? value.flatMap((entry): CallFrameInfo[] => {
        const frame = toCallFrame(entry, scripts);
        return frame === undefined ? [] : [frame];
      })
    : [];
}

function toStackTraceId(value: unknown): StackTraceIdInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = nonEmptyString(value["id"]);
  if (id === undefined) {
    return undefined;
  }
  const debuggerId = nonEmptyString(value["debuggerId"]);
  return debuggerId === undefined ? { id } : { id, debuggerId };
}

function toStackTraceFrame(value: unknown): StackTraceFrameInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const scriptId = nonEmptyString(value["scriptId"]);
  if (scriptId === undefined) {
    return undefined;
  }
  return {
    functionName: asString(value["functionName"]),
    scriptId,
    url: asString(value["url"]),
    lineNumber: asNumber(value["lineNumber"]),
    columnNumber: asNumber(value["columnNumber"]),
  };
}

function toStackTrace(value: unknown): StackTraceInfo | undefined {
  if (!isRecord(value) || !Array.isArray(value["callFrames"])) {
    return undefined;
  }
  const callFrames = value["callFrames"].flatMap((entry): StackTraceFrameInfo[] => {
    const frame = toStackTraceFrame(entry);
    return frame === undefined ? [] : [frame];
  });
  const description = nonEmptyString(value["description"]);
  const parent = toStackTrace(value["parent"]);
  const parentId = toStackTraceId(value["parentId"]);
  return {
    callFrames,
    ...(description === undefined ? {} : { description }),
    ...(parent === undefined ? {} : { parent }),
    ...(parentId === undefined ? {} : { parentId }),
  };
}

export function toPauseEvent(
  value: unknown,
  receivedAtMs: number,
  scripts?: ReadonlyMap<string, ScriptInfo>,
): PauseEvent {
  const params = isRecord(value) ? value : {};
  const asyncStackTrace = toStackTrace(params["asyncStackTrace"]);
  const asyncStackTraceId = toStackTraceId(params["asyncStackTraceId"]);
  const asyncCallStackTraceId = toStackTraceId(params["asyncCallStackTraceId"]);
  return {
    reason: asString(params["reason"]),
    hitBreakpoints: Array.isArray(params["hitBreakpoints"])
      ? params["hitBreakpoints"].filter((id): id is string => typeof id === "string")
      : [],
    callFrames: toCallFrames(params["callFrames"], scripts),
    receivedAtMs,
    ...(params["data"] === undefined ? {} : { data: params["data"] }),
    ...(asyncStackTrace === undefined ? {} : { asyncStackTrace }),
    ...(asyncStackTraceId === undefined ? {} : { asyncStackTraceId }),
    ...(asyncCallStackTraceId === undefined ? {} : { asyncCallStackTraceId }),
  };
}

export function toScriptInfo(value: unknown): ScriptInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const scriptId = nonEmptyString(value["scriptId"]);
  if (scriptId === undefined) {
    return undefined;
  }
  const stackTrace = toStackTrace(value["stackTrace"]);
  return {
    scriptId,
    url: asString(value["url"]),
    ...optionalNumericField("startLine", value["startLine"]),
    ...optionalNumericField("startColumn", value["startColumn"]),
    ...optionalNumericField("endLine", value["endLine"]),
    ...optionalNumericField("endColumn", value["endColumn"]),
    ...optionalNumericField("executionContextId", value["executionContextId"]),
    ...optionalTextField("hash", value["hash"]),
    ...optionalTextField("buildId", value["buildId"]),
    ...(value["executionContextAuxData"] === undefined
      ? {}
      : { executionContextAuxData: value["executionContextAuxData"] }),
    ...optionalTextField("sourceMapURL", value["sourceMapURL"]),
    ...optionalBooleanField("hasSourceURL", value["hasSourceURL"]),
    ...optionalBooleanField("isModule", value["isModule"]),
    ...optionalNumericField("length", value["length"]),
    ...(stackTrace === undefined ? {} : { stackTrace }),
  };
}

function optionalNumericField(
  key: string,
  value: unknown,
): Readonly<Record<string, number>> {
  const number = optionalNumber(value);
  return number === undefined ? {} : { [key]: number };
}

function optionalBooleanField(
  key: string,
  value: unknown,
): Readonly<Record<string, boolean>> {
  const boolean = optionalBoolean(value);
  return boolean === undefined ? {} : { [key]: boolean };
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
