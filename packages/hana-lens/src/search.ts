import { levenshtein } from "./levenshtein.js";
import { PACKAGE_ANNOTATION } from "./types.js";
import type { HanaLensCsn, SearchResult } from "./types.js";

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

export function searchDefinitions(csn: HanaLensCsn, keyword: string, regexMode: boolean): readonly SearchResult[] {
  const trimmedKeyword = keyword.trim();
  if (trimmedKeyword.length === 0) {
    throw new Error("Search keyword must not be empty");
  }
  const entries = Object.entries(csn.definitions);
  if (regexMode) {
    const pattern = new RegExp(trimmedKeyword, "iu");
    return entries
      .filter(([name]) => pattern.test(name))
      .slice(0, 10)
      .map(([name, definition]) => ({ name, packageName: packageNameOf(definition), score: 0 }));
  }
  const normalizedKeyword = trimmedKeyword.toLowerCase();
  return entries
    .map(([name, definition]) => ({
      name,
      packageName: packageNameOf(definition),
      score: fuzzyScore(normalizedKeyword, name),
    }))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 10);
}

export function formatSearchResults(results: readonly SearchResult[]): string {
  return results.map((result) => `${result.name}|${result.packageName}`).join("\n");
}
