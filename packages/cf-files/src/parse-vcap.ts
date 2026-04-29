import type { DefaultEnv } from "./types.js";

const SYSTEM_PROVIDED_MARKER = "System-Provided:";
const USER_PROVIDED_MARKER = "User-Provided:";
const VCAP_APPLICATION_MARKER = "VCAP_APPLICATION:";
const VCAP_SERVICES_MARKER = "VCAP_SERVICES:";
const EMPTY_USER_PROVIDED = new Set(["(empty)", "No user-defined env variables have been set"]);
const STOP_MARKERS = new Set([
  "Running Environment Variable Groups:",
  "Staging Environment Variable Groups:",
  "Application Environment Variable Groups:",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findJsonObjectEnd(source: string, startIdx: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === undefined) {
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function parseJsonObject(rawJson: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`${label} payload is not a JSON object`);
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${label} JSON: ${msg}`, { cause: err });
  }
}

function extractNamedJsonObject(source: string, marker: string, label: string): Record<string, unknown> {
  const markerIdx = source.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error(`${label} block not found in cf env output`);
  }

  const afterMarker = source.slice(markerIdx + marker.length);
  const openIdx = afterMarker.indexOf("{");
  if (openIdx === -1) {
    throw new Error(`${label} JSON payload not found`);
  }

  const closeIdx = findJsonObjectEnd(afterMarker, openIdx);
  if (closeIdx === -1) {
    throw new Error(`Malformed ${label} JSON in cf env output`);
  }

  return parseJsonObject(afterMarker.slice(openIdx, closeIdx + 1), label);
}

function parseSystemProvidedFromBlock(cfEnvOutput: string): Record<string, unknown> | null {
  const markerIdx = cfEnvOutput.indexOf(SYSTEM_PROVIDED_MARKER);
  if (markerIdx === -1) {
    return null;
  }

  const afterMarker = cfEnvOutput.slice(markerIdx + SYSTEM_PROVIDED_MARKER.length).trimStart();
  if (!afterMarker.startsWith("{")) {
    return null;
  }

  const closeIdx = findJsonObjectEnd(afterMarker, 0);
  if (closeIdx === -1) {
    throw new Error("Malformed System-Provided JSON in cf env output");
  }

  return parseJsonObject(afterMarker.slice(0, closeIdx + 1), "System-Provided");
}

function parseSystemProvidedFromNamedBlocks(cfEnvOutput: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  try {
    payload["VCAP_SERVICES"] = extractNamedJsonObject(
      cfEnvOutput,
      VCAP_SERVICES_MARKER,
      "VCAP_SERVICES",
    );
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("block not found")) {
      throw err;
    }
  }

  try {
    payload["VCAP_APPLICATION"] = extractNamedJsonObject(
      cfEnvOutput,
      VCAP_APPLICATION_MARKER,
      "VCAP_APPLICATION",
    );
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("block not found")) {
      throw err;
    }
  }

  if (Object.keys(payload).length === 0) {
    throw new Error("No supported env variables found in cf env output");
  }

  return payload;
}

function parseEnvValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function isUserProvidedEntryStart(line: string): boolean {
  return /^[A-Za-z0-9_]+:/.test(line);
}

function parseUserProvided(cfEnvOutput: string): Record<string, unknown> {
  const markerIdx = cfEnvOutput.indexOf(USER_PROVIDED_MARKER);
  if (markerIdx === -1) {
    return {};
  }

  const lines = cfEnvOutput.slice(markerIdx + USER_PROVIDED_MARKER.length).split("\n");
  const payload: Record<string, unknown> = {};

  for (let i = 0; i < lines.length; ) {
    const line = lines[i]?.trim();
    if (line === undefined || line.length === 0) {
      i++;
      continue;
    }
    if (EMPTY_USER_PROVIDED.has(line) || STOP_MARKERS.has(line)) {
      break;
    }

    const current = lines[i] ?? "";
    const match = /^([A-Za-z0-9_]+):(.*)$/.exec(current);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    if (key === undefined) {
      i++;
      continue;
    }

    const firstValuePart = match[2] ?? "";
    const valueLines = [firstValuePart.trimStart()];
    i++;

    for (; i < lines.length; i++) {
      const next = lines[i] ?? "";
      const trimmed = next.trim();
      if (STOP_MARKERS.has(trimmed)) {
        break;
      }
      if (isUserProvidedEntryStart(next)) {
        break;
      }
      valueLines.push(next);
    }

    payload[key] = parseEnvValue(valueLines.join("\n"));
  }

  return payload;
}

export function parseDefaultEnv(cfEnvOutput: string): DefaultEnv {
  const systemProvided =
    parseSystemProvidedFromBlock(cfEnvOutput) ?? parseSystemProvidedFromNamedBlocks(cfEnvOutput);
  return {
    ...systemProvided,
    ...parseUserProvided(cfEnvOutput),
  };
}

export function parseVcapServices(cfEnvOutput: string): Record<string, unknown> {
  let payload: DefaultEnv;
  try {
    payload = parseDefaultEnv(cfEnvOutput);
  } catch (err) {
    if (err instanceof Error && err.message === "No supported env variables found in cf env output") {
      throw new Error("VCAP_SERVICES block not found in cf env output", { cause: err });
    }
    throw err;
  }

  const vcapServices = payload["VCAP_SERVICES"];
  if (!isRecord(vcapServices)) {
    throw new Error("VCAP_SERVICES block not found in cf env output");
  }
  return vcapServices;
}
