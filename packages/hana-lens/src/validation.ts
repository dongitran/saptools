import type { HanaLensCsn, HanaLensDefinition, HanaLensElement } from "./types.js";
import { PACKAGE_ANNOTATION } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asElement(value: unknown): HanaLensElement | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value["type"] !== undefined && typeof value["type"] !== "string") {
    return undefined;
  }
  if (value["length"] !== undefined && typeof value["length"] !== "number") {
    return undefined;
  }
  if (value["key"] !== undefined && typeof value["key"] !== "boolean") {
    return undefined;
  }
  if (value["target"] !== undefined && typeof value["target"] !== "string") {
    return undefined;
  }
  if (value["@Core.Computed"] !== undefined && typeof value["@Core.Computed"] !== "boolean") {
    return undefined;
  }
  if (value["on"] !== undefined && !Array.isArray(value["on"])) {
    return undefined;
  }
  return value as HanaLensElement;
}

function asDefinition(value: unknown): HanaLensDefinition | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value["kind"] !== undefined && typeof value["kind"] !== "string") {
    return undefined;
  }
  if (value[PACKAGE_ANNOTATION] !== undefined && typeof value[PACKAGE_ANNOTATION] !== "string") {
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
