import { levenshtein } from "./levenshtein.js";
import { findTargetCandidates, isAssociationElement, resolveTarget } from "./targets.js";
import { PACKAGE_ANNOTATION } from "./types.js";
import type { FieldSearchResult, HanaLensCsn, HanaLensDefinition, IncomingReference, SearchResult } from "./types.js";

const DEFINITION_RESULT_LIMIT = 10;
const FIELD_RESULT_LIMIT = 25;
const REFERENCE_RESULT_LIMIT = 25;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageNameOf(definition: HanaLensCsn["definitions"][string]): string {
  return definition[PACKAGE_ANNOTATION] ?? "unknown";
}

function searchableNameParts(name: string): readonly string[] {
  const parts = name.split(".").filter((part) => part.length > 0);
  const last = parts.at(-1);
  return last === undefined || last === name ? [name] : [name, last];
}

function fuzzyScore(keyword: string, definitionName: string): number {
  return Math.min(...searchableNameParts(definitionName.toLowerCase()).map((candidate) => {
    const containsBoost = candidate.includes(keyword) ? -1000 : 0;
    return levenshtein(keyword, candidate) + containsBoost;
  }));
}

function assertSafeRegexPattern(pattern: string): void {
  if (pattern.length > 256) {
    throw new Error("Regex pattern is too long");
  }
  // Reject common catastrophic-backtracking constructs such as nested quantifiers.
  if (/\([^)]*[+*][^)]*\)[+*?{]/u.test(pattern)) {
    throw new Error("Unsafe regex pattern");
  }
}

function assertKeyword(keyword: string): string {
  const trimmedKeyword = keyword.trim();
  if (trimmedKeyword.length === 0) {
    throw new Error("Search keyword must not be empty");
  }
  return trimmedKeyword;
}

export function searchDefinitions(csn: HanaLensCsn, keyword: string, regexMode: boolean): readonly SearchResult[] {
  const trimmedKeyword = assertKeyword(keyword);
  const entries = Object.entries(csn.definitions);
  if (regexMode) {
    assertSafeRegexPattern(trimmedKeyword);
    const pattern = new RegExp(trimmedKeyword, "iu");
    return entries
      .filter(([name]) => pattern.test(name))
      .map(([name, definition]) => ({ name, packageName: packageNameOf(definition), score: 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const normalizedKeyword = trimmedKeyword.toLowerCase();
  // Keep this relevance threshold aligned with field search below.
  const threshold = Math.max(2, Math.ceil(normalizedKeyword.length / 3));
  return entries
    .map(([name, definition]) => ({
      name,
      packageName: packageNameOf(definition),
      score: fuzzyScore(normalizedKeyword, name),
    }))
    .filter((result) => result.score <= threshold)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
}

export function searchFields(csn: HanaLensCsn, keyword: string, regexMode: boolean): readonly FieldSearchResult[] {
  const trimmedKeyword = assertKeyword(keyword);
  const normalizedKeyword = trimmedKeyword.toLowerCase();
  if (regexMode) {
    assertSafeRegexPattern(trimmedKeyword);
  }
  const pattern = regexMode ? new RegExp(trimmedKeyword, "iu") : undefined;

  const results: FieldSearchResult[] = [];
  for (const [entityName, definition] of Object.entries(csn.definitions)) {
    const elements = definition.elements;
    if (elements === undefined) {
      continue;
    }
    const matches = Object.keys(elements)
      .map((fieldName) => {
        if (pattern !== undefined) {
          return pattern.test(fieldName) ? { entityName, exact: false, matchedField: fieldName, score: 0 } : undefined;
        }
        const exact = fieldName.toLowerCase() === normalizedKeyword;
        const score = fuzzyScore(normalizedKeyword, fieldName);
        // Keep this relevance threshold aligned with definition search above.
        return exact || fieldName.toLowerCase().includes(normalizedKeyword) || score <= Math.max(2, Math.ceil(normalizedKeyword.length / 3))
          ? { entityName, exact, matchedField: fieldName, score }
          : undefined;
      })
      .filter((match): match is FieldSearchResult => match !== undefined)
      .sort((a, b) => a.score - b.score || a.matchedField.localeCompare(b.matchedField));
    results.push(...matches);
  }
  return results.sort((a, b) => a.score - b.score
    || a.entityName.localeCompare(b.entityName)
    || a.matchedField.localeCompare(b.matchedField));
}

function projectionSources(definition: HanaLensDefinition): readonly string[] {
  const sources = new Set<string>();

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      const items: readonly unknown[] = node;
      for (const item of items) {
        visit(item);
      }
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    const ref = node["ref"];
    if (Array.isArray(ref)) {
      const first: unknown = ref[0];
      if (typeof first === "string") {
        sources.add(first);
      }
    }
    visit(node["from"]);
    visit(node["SELECT"]);
    visit(node["SET"]);
    visit(node["args"]);
    visit(node["join"]);
  }

  visit(definition.projection);
  visit(definition.query);
  return [...sources];
}

export function findIncomingReferences(csn: HanaLensCsn, entityName: string): readonly IncomingReference[] {
  const requestedTargets = new Set(findTargetCandidates(csn, entityName).map((candidate) => candidate.name));
  if (requestedTargets.size === 0) {
    throw new Error(`Entity not found: ${entityName}`);
  }

  const references: IncomingReference[] = [];
  for (const [sourceName, definition] of Object.entries(csn.definitions)) {
    const elements = definition.elements;
    if (elements !== undefined) {
      for (const [fieldName, element] of Object.entries(elements)) {
        const targetName = element.target;
        if (!isAssociationElement(element) || targetName === undefined) {
          continue;
        }
        const resolution = resolveTarget(csn, targetName, definition);
        if (resolution.status === "resolved" && requestedTargets.has(resolution.target.name)) {
          references.push({ entityName: sourceName, fieldName });
        }
      }
    }
    for (const source of projectionSources(definition)) {
      const resolution = resolveTarget(csn, source, definition);
      if (resolution.status === "resolved" && requestedTargets.has(resolution.target.name)) {
        references.push({ entityName: sourceName, fieldName: "(projection)" });
        break;
      }
    }
  }
  return references.sort((a, b) => a.entityName.localeCompare(b.entityName) || a.fieldName.localeCompare(b.fieldName));
}

export function formatSearchResults(results: readonly SearchResult[]): string {
  const shown = results.slice(0, DEFINITION_RESULT_LIMIT);
  const lines = shown.map((result) => `${result.name}|${result.packageName}`);
  if (results.length > shown.length) {
    lines.push(`... showing ${shown.length.toString()} of ${results.length.toString()} matches`);
  }
  return lines.join("\n");
}

export function formatFieldSearchResults(keyword: string, results: readonly FieldSearchResult[]): string {
  const shown = results.slice(0, FIELD_RESULT_LIMIT);
  const lines = [`Field matching ${JSON.stringify(keyword)} found in:`];
  for (const result of shown) {
    const suffix = result.exact ? `exact: ${result.matchedField}` : `matched: ${result.matchedField}`;
    lines.push(`- ${result.entityName} (${suffix})`);
  }
  if (results.length > shown.length) {
    lines.push(`... showing ${shown.length.toString()} of ${results.length.toString()} matches`);
  }
  return lines.join("\n");
}

export function formatIncomingReferences(entityName: string, references: readonly IncomingReference[]): string {
  const shown = references.slice(0, REFERENCE_RESULT_LIMIT);
  const lines = [`Incoming References to [${entityName}]:`];
  lines.push(...shown.map((reference) => `- ${reference.entityName} (via field: ${reference.fieldName})`));
  if (references.length > shown.length) {
    lines.push(`... showing ${shown.length.toString()} of ${references.length.toString()} references`);
  }
  return lines.join("\n");
}
