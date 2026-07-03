import type { HanaLensCsn, HanaLensDefinition, HanaLensElement } from "./types.js";

const ASSOCIATION_TYPES = new Set(["cds.Association", "cds.Composition"]);
const MAX_EXPAND_DEPTH = 2;

function typeText(element: HanaLensElement): string {
  const base = element.type ?? "unknown";
  return element.length === undefined ? base : `${base}(${element.length.toString()})`;
}

function isPrimary(element: HanaLensElement): boolean {
  return element.key === true || element["@Core.Computed"] === true;
}

function formatElement(name: string, element: HanaLensElement, depth: number): string {
  const prefix = depth === 0 ? "" : `${"-".repeat(depth)} `;
  const marker = isPrimary(element) ? "[PK] " : "";
  return `${prefix}${marker}${name}: ${typeText(element)}`;
}

function describeDefinition(csn: HanaLensCsn, definition: HanaLensDefinition, expand: boolean, depth: number, seen: ReadonlySet<string>): readonly string[] {
  const elements = definition.elements;
  if (elements === undefined) {
    return ["(no elements)"];
  }
  const lines: string[] = [];
  for (const [name, element] of Object.entries(elements)) {
    lines.push(formatElement(name, element, depth));
    if (!expand || depth >= MAX_EXPAND_DEPTH || element.target === undefined || !ASSOCIATION_TYPES.has(element.type ?? "")) {
      continue;
    }
    if (seen.has(element.target)) {
      lines.push(`${"-".repeat(depth + 1)} ${element.target}: circular`);
      continue;
    }
    const target = csn.definitions[element.target];
    if (target === undefined) {
      lines.push(`${"-".repeat(depth + 1)} ${element.target}: missing`);
      continue;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(element.target);
    lines.push(...describeDefinition(csn, target, expand, depth + 1, nextSeen));
  }
  return lines;
}

export function describeEntity(csn: HanaLensCsn, entityName: string, expand: boolean): string {
  const definition = csn.definitions[entityName];
  if (definition === undefined) {
    throw new Error(`Entity not found: ${entityName}`);
  }
  return describeDefinition(csn, definition, expand, 0, new Set([entityName])).join("\n");
}
