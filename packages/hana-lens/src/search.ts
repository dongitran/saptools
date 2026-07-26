import process from "node:process";

import { matchRegexCandidates } from "./001-regex-search.js";
import { levenshtein } from "./levenshtein.js";
import { findReferenceTargetCandidates, isAssociationElement, resolveTarget } from "./targets.js";
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
  return parts.length <= 1 ? [name] : [name, ...parts];
}

// Exact match (including an exact whole-segment match, since segments are candidates too) always
// wins. A substring match ranks by where it starts, not by the candidate's overall length -- so a
// long, descriptive name that matches at the same position as a short one ties with it instead of
// always losing to "shortest wins", which previously buried more relevant, longer entity names.
function scoreCandidate(keyword: string, candidate: string): number {
  if (candidate === keyword) {
    return -2000;
  }
  const matchIndex = candidate.indexOf(keyword);
  return matchIndex === -1 ? levenshtein(keyword, candidate) : -1000 + matchIndex;
}

function fuzzyScore(keyword: string, definitionName: string): number {
  return Math.min(...searchableNameParts(definitionName.toLowerCase()).map((candidate) => scoreCandidate(keyword, candidate)));
}

function assertKeyword(keyword: string, regexMode: boolean): string {
  // A whitespace-only string is a genuinely valid, if unusual, regex (it matches literal spaces),
  // so only regex mode's own emptiness check applies to the untrimmed keyword; trimming before
  // checking -- as fuzzy mode deliberately does, since a fuzzy search for pure whitespace is
  // meaningless -- must not also reject a regex pattern that is not actually empty.
  const searchKeyword = regexMode ? keyword : keyword.trim();
  if (searchKeyword.length === 0) {
    throw new Error("Search keyword must not be empty");
  }
  // Worker timeouts plus the linear fallback are the ReDoS boundary for regex mode; fuzzy mode's
  // own levenshtein comparisons are O(keyword x candidate), so an unbounded keyword is a CPU risk
  // there too. Both share one clear length error before either evaluation path even starts.
  if (searchKeyword.length > 256) {
    throw new Error(regexMode ? "Regex pattern is too long" : "Search keyword is too long");
  }
  return searchKeyword;
}

export function searchDefinitions(csn: HanaLensCsn, keyword: string, regexMode: boolean): readonly SearchResult[] {
  const searchKeyword = assertKeyword(keyword, regexMode);
  const entries = Object.entries(csn.definitions);
  if (regexMode) {
    const candidateGroups = entries.map(([name]) => ({ name, candidates: searchableNameParts(name) }));
    const matches = matchRegexCandidates(
      searchKeyword,
      candidateGroups.flatMap((group) => group.candidates),
    );
    const matchingNames = new Set<string>();
    let matchIndex = 0;
    for (const group of candidateGroups) {
      const nextMatchIndex = matchIndex + group.candidates.length;
      if (matches.slice(matchIndex, nextMatchIndex).some((matched) => matched)) {
        matchingNames.add(group.name);
      }
      matchIndex = nextMatchIndex;
    }
    return entries
      .filter(([name]) => matchingNames.has(name))
      .map(([name, definition]) => ({ name, packageName: packageNameOf(definition), score: 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const normalizedKeyword = searchKeyword.toLowerCase();
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
  const searchKeyword = assertKeyword(keyword, regexMode);
  const normalizedKeyword = searchKeyword.toLowerCase();
  const fields: { readonly entityName: string; readonly fieldName: string }[] = [];
  for (const [entityName, definition] of Object.entries(csn.definitions)) {
    if (definition.elements !== undefined) {
      fields.push(...Object.keys(definition.elements).map((fieldName) => ({ entityName, fieldName })));
    }
  }
  const regexMatches = regexMode
    ? matchRegexCandidates(searchKeyword, fields.map(({ fieldName }) => fieldName))
    : undefined;
  return fields.map(({ entityName, fieldName }, index) => {
    if (regexMatches !== undefined) {
      return regexMatches[index] === true
        ? { entityName, exact: false, matchedField: fieldName, score: 0 }
        : undefined;
    }
    const exact = fieldName.toLowerCase() === normalizedKeyword;
    const score = fuzzyScore(normalizedKeyword, fieldName);
    // Keep this relevance threshold aligned with definition search above.
    return exact || fieldName.toLowerCase().includes(normalizedKeyword) || score <= Math.max(2, Math.ceil(normalizedKeyword.length / 3))
      ? { entityName, exact, matchedField: fieldName, score }
      : undefined;
  }).filter((match): match is FieldSearchResult => match !== undefined)
    .sort((a, b) => a.score - b.score
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
      } else if (isRecord(first) && typeof first["id"] === "string") {
        // A parameterized source (e.g. a calculation view) serializes its ref as
        // { id, args } rather than a bare string -- describe.ts's expression formatter
        // already reads segment.id for the identical shape.
        sources.add(first["id"]);
      }
    }
    // Only source-bearing FROM/JOIN nodes count; field refs in columns or filters are not target definitions.
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
  const requestedTargets = new Set(findReferenceTargetCandidates(csn, entityName).map((candidate) => candidate.name));
  if (requestedTargets.size === 0) {
    throw new Error(`Entity not found: ${entityName}`);
  }

  const references: IncomingReference[] = [];
  for (const [sourceName, definition] of Object.entries(csn.definitions)) {
    const elements = definition.elements;
    if (elements !== undefined) {
      for (const [fieldName, element] of Object.entries(elements)) {
        if (isAssociationElement(element)) {
          const targetName = element.target;
          if (targetName === undefined) {
            continue;
          }
          const resolution = resolveTarget(csn, targetName, definition);
          if (resolution.status === "resolved" && requestedTargets.has(resolution.target.name)) {
            references.push({ entityName: sourceName, fieldName });
          }
          continue;
        }
        // A `type` reuses another definition by its FQN; cds.* builtins never resolve to a
        // cached definition, so this skips straight past the overwhelming majority of scalar
        // elements before resolveTarget's O(n) fallback scan would otherwise run per element.
        if (element.type !== undefined && !element.type.startsWith("cds.")) {
          const resolution = resolveTarget(csn, element.type, definition);
          if (resolution.status === "resolved" && resolution.target.definition.kind === "type" && requestedTargets.has(resolution.target.name)) {
            references.push({ entityName: sourceName, fieldName, viaType: true });
          }
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
    process.stderr.write(`... showing ${shown.length.toString()} of ${results.length.toString()} matches\n`);
  }
  return lines.join("\n");
}

export function formatFieldSearchResults(keyword: string, results: readonly FieldSearchResult[]): string {
  if (results.length === 0) {
    return `No field matches for ${JSON.stringify(keyword)}`;
  }
  const shown = results.slice(0, FIELD_RESULT_LIMIT);
  const lines = [`Field matching ${JSON.stringify(keyword)} found in:`];
  for (const result of shown) {
    const suffix = result.exact ? `exact: ${result.matchedField}` : `matched: ${result.matchedField}`;
    lines.push(`- ${result.entityName} (${suffix})`);
  }
  if (results.length > shown.length) {
    process.stderr.write(`... showing ${shown.length.toString()} of ${results.length.toString()} matches\n`);
  }
  return lines.join("\n");
}

export function formatIncomingReferences(
  entityName: string,
  references: readonly IncomingReference[],
  matchedTargetNames: readonly string[] = [],
): string {
  const shown = references.slice(0, REFERENCE_RESULT_LIMIT);
  const targets = [...new Set(matchedTargetNames)].sort((left, right) => left.localeCompare(right));
  let note: string | undefined;
  if (targets.length > 1) {
    const visibleTargets = targets.slice(0, 5);
    const remainingTargets = targets.length - visibleTargets.length;
    const suffix = remainingTargets > 0 ? `, ... (+${remainingTargets.toString()} more)` : "";
    note = `Note: ${JSON.stringify(entityName)} matched ${targets.length.toString()} definitions `
      + `(${visibleTargets.join(", ")}${suffix}); references below are the union.`;
  }
  const lines = [
    ...(note === undefined ? [] : [note]),
    `Incoming References to [${entityName}]:`,
    ...(shown.length === 0
      ? ["(no incoming references found)"]
      : shown.map((reference) => `- ${reference.entityName} (via field: ${reference.fieldName}${reference.viaType === true ? ", type reference" : ""})`)),
  ];
  if (references.length > shown.length) {
    process.stderr.write(`... showing ${shown.length.toString()} of ${references.length.toString()} references\n`);
  }
  return lines.join("\n");
}
