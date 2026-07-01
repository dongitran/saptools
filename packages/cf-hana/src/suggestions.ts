import { QueryError } from "./errors.js";
import type { CatalogObjectInfo } from "./metadata-cache.js";

export interface MissingObjectName {
  readonly schema?: string;
  readonly name: string;
}

const INVALID_OBJECT_PATTERNS = [
  /invalid\s+(?:table|view|object)\s+name/i,
  /(?:table|view|object)\s+[^\n]*does\s+not\s+exist/i,
  /could\s+not\s+find\s+(?:table|view|object)/i,
];

const REF_KEYWORDS = new Set(["FROM", "JOIN", "UPDATE", "INTO", "TABLE"]);
const STOP_WORDS = new Set([
  "AS",
  "ON",
  "WHERE",
  "SET",
  "VALUES",
  "USING",
  "WHEN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "OUTER",
  "CROSS",
  "JOIN",
]);
const CTE_FOLLOWERS = new Set(["AS"]);

type TokenKind = "word" | "quoted" | "dot" | "comma" | "open" | "close" | "other";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

export function isInvalidCatalogObjectError(error: unknown): boolean {
  if (!(error instanceof QueryError)) {
    return false;
  }
  if (error.sqlState === "42S02" || error.sqlState === "42S01") {
    return true;
  }
  return INVALID_OBJECT_PATTERNS.some((pattern) => pattern.test(error.message));
}

function skipLineComment(sql: string, index: number): number {
  let cursor = index + 2;
  while (cursor < sql.length && sql[cursor] !== "\n") {
    cursor += 1;
  }
  return cursor;
}

function skipBlockComment(sql: string, index: number): number {
  let cursor = index + 2;
  while (cursor < sql.length && !(sql[cursor] === "*" && sql[cursor + 1] === "/")) {
    cursor += 1;
  }
  return Math.min(cursor + 2, sql.length);
}

function skipStringLiteral(sql: string, index: number): number {
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === "'" && sql[cursor + 1] === "'") {
      cursor += 2;
      continue;
    }
    if (sql[cursor] === "'") {
      return cursor + 1;
    }
    cursor += 1;
  }
  return cursor;
}

function readQuotedIdentifier(sql: string, index: number): { readonly text: string; readonly next: number } {
  let cursor = index + 1;
  let text = "";
  while (cursor < sql.length) {
    if (sql[cursor] === '"' && sql[cursor + 1] === '"') {
      text += '"';
      cursor += 2;
      continue;
    }
    if (sql[cursor] === '"') {
      return { text, next: cursor + 1 };
    }
    text += sql.charAt(cursor);
    cursor += 1;
  }
  return { text, next: cursor };
}

function readBareWord(sql: string, index: number): { readonly text: string; readonly next: number } {
  let cursor = index;
  let text = "";
  while (cursor < sql.length && /[A-Za-z0-9_#$]/.test(sql.charAt(cursor))) {
    text += sql.charAt(cursor);
    cursor += 1;
  }
  return { text, next: cursor };
}

function tokenize(sql: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql.charAt(index);
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      index = skipLineComment(sql, index);
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index = skipBlockComment(sql, index);
      continue;
    }
    if (char === "'") {
      index = skipStringLiteral(sql, index);
      continue;
    }
    if (char === '"') {
      const quoted = readQuotedIdentifier(sql, index);
      tokens.push({ kind: "quoted", text: quoted.text });
      index = quoted.next;
      continue;
    }
    if (/[A-Za-z_#$]/.test(char)) {
      const word = readBareWord(sql, index);
      tokens.push({ kind: "word", text: word.text });
      index = word.next;
      continue;
    }
    if (char === ".") {
      tokens.push({ kind: "dot", text: char });
    } else if (char === ",") {
      tokens.push({ kind: "comma", text: char });
    } else if (char === "(") {
      tokens.push({ kind: "open", text: char });
    } else if (char === ")") {
      tokens.push({ kind: "close", text: char });
    } else {
      tokens.push({ kind: "other", text: char });
    }
    index += 1;
  }
  return tokens;
}

function upper(token: Token | undefined): string {
  return token?.text.toUpperCase() ?? "";
}

function isIdentifier(token: Token | undefined): token is Token {
  return token?.kind === "word" || token?.kind === "quoted";
}

function readName(
  tokens: readonly Token[],
  start: number,
  allowFollowingParens = false,
): { readonly name: MissingObjectName; readonly next: number } | undefined {
  const first = tokens[start];
  if (!isIdentifier(first)) {
    return undefined;
  }

  let next = start + 1;
  let schema: string | undefined;
  let name = first.text;
  const maybeObject = tokens[next + 1];
  if (tokens[next]?.kind === "dot" && isIdentifier(maybeObject)) {
    schema = name;
    name = maybeObject.text;
    next += 2;
  }
  if (!allowFollowingParens && tokens[next]?.kind === "open") {
    return undefined;
  }
  return { name: schema === undefined ? { name } : { schema, name }, next };
}


function firstNameFromText(text: string): MissingObjectName | undefined {
  const tokens = tokenize(text);
  for (let index = 0; index < tokens.length; index += 1) {
    const read = readName(tokens, index, true);
    if (read !== undefined) {
      return read.name;
    }
  }
  return undefined;
}

export function extractMissingObjectNameFromError(error: unknown): MissingObjectName | undefined {
  if (!(error instanceof QueryError)) {
    return undefined;
  }

  const message = error.message;
  const invalidName = /invalid\s+(?:table|view|object)\s+name\s*:?\s*(.+)$/i.exec(message);
  if (invalidName?.[1] !== undefined) {
    return firstNameFromText(invalidName[1]);
  }

  const missingObject = /(?:table|view|object)\s+(.+?)\s+(?:does\s+not\s+exist|not\s+found)/i.exec(message);
  if (missingObject?.[1] !== undefined) {
    return firstNameFromText(missingObject[1]);
  }

  return undefined;
}

function cteNames(tokens: readonly Token[]): ReadonlySet<string> {
  const names = new Set<string>();
  if (upper(tokens[0]) !== "WITH") {
    return names;
  }

  let depth = 0;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (depth === 0 && upper(token) === "SELECT") {
      break;
    }
    if (depth === 0 && isIdentifier(token) && CTE_FOLLOWERS.has(upper(tokens[index + 1]))) {
      names.add(token.text.toUpperCase());
    }
    if (token?.kind === "open") {
      depth += 1;
    } else if (token?.kind === "close" && depth > 0) {
      depth -= 1;
    }
  }
  return names;
}

export function extractMissingObjectName(sql: string): MissingObjectName | undefined {
  const tokens = tokenize(sql.replace(/^;+|;+$/g, ""));
  const ctes = cteNames(tokens);
  let candidate: MissingObjectName | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const word = upper(tokens[index]);
    if (!REF_KEYWORDS.has(word)) {
      continue;
    }
    if (word === "TABLE" && upper(tokens[index - 1]) !== "TRUNCATE") {
      continue;
    }
    if (
      word === "INTO" &&
      !(upper(tokens[index - 1]) === "INSERT" || upper(tokens[index - 1]) === "MERGE")
    ) {
      continue;
    }
    const read = readName(tokens, index + 1, word === "INTO");
    if (read === undefined) {
      continue;
    }
    if (read.name.schema === undefined && ctes.has(read.name.name.toUpperCase())) {
      continue;
    }
    if (STOP_WORDS.has(read.name.name.toUpperCase())) {
      continue;
    }
    candidate = read.name;
    let next = read.next;
    if (isIdentifier(tokens[next]) && !STOP_WORDS.has(upper(tokens[next]))) {
      next += 1;
    }
    while (tokens[next]?.kind === "comma") {
      const commaRead = readName(tokens, next + 1);
      if (commaRead === undefined) {
        break;
      }
      if (!(commaRead.name.schema === undefined && ctes.has(commaRead.name.name.toUpperCase()))) {
        candidate = commaRead.name;
      }
      next = commaRead.next;
      if (isIdentifier(tokens[next]) && !STOP_WORDS.has(upper(tokens[next]))) {
        next += 1;
      }
    }
  }
  return candidate;
}

function singular(value: string): string {
  if (value.endsWith("ES")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("S")) {
    return value.slice(0, -1);
  }
  return value;
}

function norm(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function distance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let leftIndex = 1; leftIndex <= a.length; leftIndex += 1) {
    let last = leftIndex - 1;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= b.length; rightIndex += 1) {
      const old = previous[rightIndex] ?? 0;
      previous[rightIndex] = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + 1,
        last + (a.charAt(leftIndex - 1) === b.charAt(rightIndex - 1) ? 0 : 1),
      );
      last = old;
    }
  }
  return previous[b.length] ?? 0;
}

function score(requested: MissingObjectName, candidate: CatalogObjectInfo): number {
  const requestedName = norm(requested.name);
  const candidateName = norm(candidate.name);
  if (requested.schema !== undefined && norm(requested.schema) !== norm(candidate.schema)) {
    return 0;
  }
  if (requestedName === candidateName) {
    return 100;
  }
  if (singular(requestedName) === singular(candidateName)) {
    return 92;
  }
  let value = 0;
  if (candidateName.startsWith(requestedName) || requestedName.startsWith(candidateName)) {
    value = Math.max(value, 80 - Math.abs(candidateName.length - requestedName.length));
  }
  if (candidateName.endsWith(requestedName) || requestedName.endsWith(candidateName)) {
    value = Math.max(value, 70 - Math.abs(candidateName.length - requestedName.length));
  }
  const editDistance = distance(requestedName, candidateName);
  const max = Math.max(requestedName.length, candidateName.length, 1);
  if (editDistance <= Math.max(3, Math.floor(max * 0.35))) {
    value = Math.max(value, Math.round(75 * (1 - editDistance / max)));
  }
  return value;
}

export interface NameSuggestion {
  readonly name: string;
}

export function extractInvalidColumnNameFromError(error: unknown): string | undefined {
  if (!(error instanceof QueryError)) {
    return undefined;
  }
  const match = /invalid column name:\s*([^:]+)/i.exec(error.message);
  const name = match?.[1]?.trim();
  return name === undefined || name.length === 0 ? undefined : name;
}

export function rankCatalogSuggestions(
  requested: MissingObjectName,
  candidates: readonly CatalogObjectInfo[],
  limit = 5,
): readonly CatalogObjectInfo[] {
  return candidates
    .map((candidate) => ({ candidate, score: score(requested, candidate) }))
    .filter((item) => item.score >= 45)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.schema.localeCompare(right.candidate.schema) ||
        (left.candidate.type === right.candidate.type
          ? 0
          : left.candidate.type === "TABLE"
            ? -1
            : 1) ||
        left.candidate.name.localeCompare(right.candidate.name),
    )
    .slice(0, limit)
    .map((item) => item.candidate);
}

export function formatSuggestions(suggestions: readonly CatalogObjectInfo[]): string | undefined {
  if (suggestions.length === 0) {
    return undefined;
  }
  return [
    "Did you mean:",
    ...suggestions.map((item) => `  ${item.schema}.${item.name} (${item.type})`),
  ].join("\n");
}

export function rankNameSuggestions<T extends NameSuggestion>(
  requested: string,
  candidates: readonly T[],
  limit = 5,
): readonly T[] {
  const requestedName = { name: requested };
  return candidates
    .map((candidate) => ({
      candidate,
      score: score(requestedName, { schema: "", name: candidate.name, type: "TABLE" }),
    }))
    .filter((item) => item.score >= 45)
    .sort(
      (left, right) =>
        right.score - left.score || left.candidate.name.localeCompare(right.candidate.name),
    )
    .slice(0, limit)
    .map((item) => item.candidate);
}

export function formatColumnSuggestions(suggestions: readonly NameSuggestion[]): string | undefined {
  if (suggestions.length === 0) {
    return undefined;
  }
  return [
    "Did you mean column:",
    ...suggestions.map((item) => `  ${item.name}`),
  ].join("\n");
}
