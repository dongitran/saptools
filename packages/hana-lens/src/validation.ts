import type { HanaLensCsn, HanaLensDefinition, HanaLensElement } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asElement(value: unknown): HanaLensElement | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value as HanaLensElement;
}

function asDefinition(value: unknown): HanaLensDefinition | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const elements = value["elements"];
  if (elements !== undefined && !isRecord(elements)) {
    return undefined;
  }
  if (isRecord(elements)) {
    for (const element of Object.values(elements)) {
      if (asElement(element) === undefined) {
        return undefined;
      }
    }
  }
  return value as HanaLensDefinition;
}

export function parseCsn(value: unknown): HanaLensCsn {
  if (!isRecord(value) || !isRecord(value["definitions"])) {
    throw new Error("Cache does not contain a CSN definitions object");
  }
  for (const definition of Object.values(value["definitions"])) {
    if (asDefinition(definition) === undefined) {
      throw new Error("Cache contains an invalid CSN definition");
    }
  }
  return { definitions: value["definitions"] as Readonly<Record<string, HanaLensDefinition>> };
}
