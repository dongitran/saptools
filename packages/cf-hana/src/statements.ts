import { QueryError } from "./errors.js";
import type { SqlParam, StatementKind } from "./types.js";

const SELECT_KEYWORDS = new Set(["SELECT"]);
const DML_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE"]);
const DDL_KEYWORDS = new Set(["CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME", "COMMENT"]);

function skipLineComment(sql: string, start: number): number {
  let index = start + 2;
  while (index < sql.length && sql[index] !== "\n") {
    index += 1;
  }
  return index;
}

/** Skip whitespace, line comments, and block comments starting at `start`. */
function skipWhitespaceAndComments(sql: string, start: number): number {
  let index = start;
  while (index < sql.length) {
    const char = sql.charAt(index);
    if (char.trim().length === 0) {
      index += 1;
      continue;
    }
    if (char === "-" && sql.charAt(index + 1) === "-") {
      index = skipLineComment(sql, index);
      continue;
    }
    if (char === "/" && sql.charAt(index + 1) === "*") {
      index = skipBlockComment(sql, index);
      continue;
    }
    break;
  }
  return index;
}

/** The keyword (upper-cased) starting at or after `start`, skipping comments/whitespace first. */
function keywordAt(sql: string, start: number): { readonly keyword: string; readonly end: number } {
  const index = skipWhitespaceAndComments(sql, start);
  let end = index;
  while (end < sql.length) {
    const code = sql.charCodeAt(end);
    const isUpperCase = code >= 65 && code <= 90;
    const isLowerCase = code >= 97 && code <= 122;
    if (!isUpperCase && !isLowerCase) {
      break;
    }
    end += 1;
  }
  return { keyword: sql.slice(index, end).toUpperCase(), end };
}

/** The leading SQL keyword, upper-cased, skipping comments and whitespace. */
export function firstKeyword(sql: string): string {
  return keywordAt(sql, 0).keyword;
}

/** Skip a quoted string/identifier starting at `start`; returns the index just past its closing quote. */
export function skipQuotedText(sql: string, start: number): number {
  const quote = sql[start];
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      index += 1;
      break;
    }
    index += 1;
  }
  return index;
}

/** Skip a block comment starting at `start`; returns the index just past its closing `star-slash`. */
export function skipBlockComment(sql: string, start: number): number {
  let index = start + 2;
  while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
    index += 1;
  }
  return Math.min(index + 2, sql.length);
}

/** Replace every quoted string/identifier and comment with spaces, preserving length and positions. */
export function maskIgnoredSqlText(sql: string): string {
  let masked = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      const end = skipQuotedText(sql, index);
      masked += " ".repeat(end - index);
      index = end;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const end = skipLineComment(sql, index);
      masked += " ".repeat(end - index);
      index = end;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = skipBlockComment(sql, index);
      masked += " ".repeat(end - index);
      index = end;
      continue;
    }
    masked += char ?? "";
    index += 1;
  }
  return masked;
}

function topLevelKeywordIndex(sql: string, keyword: string): number | undefined {
  const masked = maskIgnoredSqlText(sql);
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (
      depth === 0 &&
      masked.slice(index, index + keyword.length).toUpperCase() === keyword &&
      !/[A-Za-z0-9_$#]/.test(masked.charAt(index - 1)) &&
      !/[A-Za-z0-9_$#]/.test(masked.charAt(index + keyword.length))
    ) {
      return index;
    }
  }
  return undefined;
}

/** Whether `keyword` appears at paren-depth 0, outside string/identifier literals and comments. */
export function hasTopLevelKeyword(sql: string, keyword: string): boolean {
  return topLevelKeywordIndex(sql, keyword) !== undefined;
}

/** Shared explanation for why a multi-statement SQL string is refused. */
export const MULTI_STATEMENT_MESSAGE =
  "cf-hana executes exactly one SQL statement per call; additional content was found " +
  "after a ';' separator - remove it, or run each statement as a separate call.";

const ROUTINE_KEYWORDS = new Set(["PROCEDURE", "FUNCTION", "TRIGGER"]);

/**
 * Whether `sql` is a `CREATE [OR REPLACE] PROCEDURE/FUNCTION/TRIGGER`
 * definition *with a real body*. Narrow on purpose: `CREATE TABLE`/`VIEW`/
 * `INDEX` etc. do not get this exemption, since - unlike a routine body -
 * they have no legitimate reason to contain a top-level-looking `;` before
 * their own end. A top-level `BEGIN` and `END` are required, not just the
 * leading keyword pair - without this, e.g. `"CREATE PROCEDURE p; DROP
 * TABLE other"` (no body at all) would skip the multi-statement check
 * entirely on the strength of two keywords alone.
 */
export function isRoutineDefinition(sql: string): boolean {
  const create = keywordAt(sql, 0);
  if (create.keyword !== "CREATE") {
    return false;
  }
  const second = keywordAt(sql, create.end);
  if (!ROUTINE_KEYWORDS.has(second.keyword)) {
    if (second.keyword !== "OR") {
      return false;
    }
    const third = keywordAt(sql, second.end);
    if (third.keyword !== "REPLACE" || !ROUTINE_KEYWORDS.has(keywordAt(sql, third.end).keyword)) {
      return false;
    }
  }
  return hasTopLevelKeyword(sql, "BEGIN") && hasTopLevelKeyword(sql, "END");
}

/**
 * Whether `sql` is a HANA SQLScript anonymous block (`DO [(...)] BEGIN ...
 * END`). Like a routine definition, its `BEGIN`/`END` body legitimately
 * contains internal, top-level-looking semicolons that are not additional
 * statements smuggled after this one.
 */
export function isAnonymousBlock(sql: string): boolean {
  if (keywordAt(sql, 0).keyword !== "DO") {
    return false;
  }
  return hasTopLevelKeyword(sql, "BEGIN") && hasTopLevelKeyword(sql, "END");
}

/**
 * Split `sql` into top-level statements at genuine (unquoted, uncommented,
 * outside-parens) `;` separators, returning slices of the *original* `sql`
 * (not the masked one) so callers see unmodified real SQL. A `;` inside a
 * string/identifier literal, a comment, or nested inside parens is never a
 * separator - only a depth-0, unmasked semicolon is.
 */
export function splitTopLevelStatements(sql: string): readonly string[] {
  const masked = maskIgnoredSqlText(sql);
  const segments: string[] = [];
  let depth = 0;
  let segmentStart = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked.charAt(index);
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === ";" && depth === 0) {
      segments.push(sql.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }
  segments.push(sql.slice(segmentStart));
  return segments;
}

// Zero-width Unicode format characters: invisible, no glyph of their own,
// and not part of ECMAScript's whitespace set, so a plain `.trim()` alone
// does not strip them. A segment consisting only of these - e.g. a stray
// zero-width space left over from pasting SQL out of a chat app or word
// processor - has no real content, even though it isn't blank in the
// strict `.trim()` sense.
const ZERO_WIDTH_CHARS = /[\u200B-\u200D\u2060\uFEFF]/g;

function hasRealContent(segment: string): boolean {
  return maskIgnoredSqlText(segment).replace(ZERO_WIDTH_CHARS, "").trim().length > 0;
}

function hasUnbalancedParens(masked: string): boolean {
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked.charAt(index);
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth !== 0;
}

/**
 * Whether `sql` contains more than one genuine top-level SQL statement.
 * cf-hana always executes exactly one statement per call; this is the
 * structural check that makes that an enforced, guarded property rather
 * than an assumption resting entirely on HANA's own rejection of
 * multi-statement text (see CHANGELOG). A lone trailing `;` - with nothing
 * but whitespace/comments after it - is not a second statement; only a
 * segment with real content counts. `CREATE PROCEDURE`/`FUNCTION`/`TRIGGER`
 * definitions and `DO` anonymous blocks are exempted entirely (see
 * `isRoutineDefinition`/`isAnonymousBlock`) since their `BEGIN`/`END` bodies
 * legitimately contain many internal, top-level-looking semicolons that are
 * not additional statements smuggled after this one.
 */
export function hasMultipleStatements(sql: string): boolean {
  if (isRoutineDefinition(sql) || isAnonymousBlock(sql)) {
    return false;
  }
  // An unclosed top-level paren makes every ';' after it look "still
  // nested" to splitTopLevelStatements below (and, separately, keeps the
  // pre-existing WHERE-scope check in safety.ts from ever seeing what comes
  // after it either) - the statement's real shape cannot be determined at
  // all, so refuse rather than guess, mirroring the same fail-closed
  // precedent already used for an unresolved WITH statement.
  if (hasUnbalancedParens(maskIgnoredSqlText(sql))) {
    return true;
  }
  const realSegments = splitTopLevelStatements(sql).filter(hasRealContent);
  return realSegments.length > 1;
}

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_$#]/.test(char);
}

function skipWhitespace(masked: string, start: number): number {
  let index = start;
  while (index < masked.length && /\s/.test(masked.charAt(index))) {
    index += 1;
  }
  return index;
}

function matchingCloseParenIndex(masked: string, openIndex: number): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    const char = masked.charAt(index);
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function isAsKeywordAt(masked: string, index: number): boolean {
  return (
    masked.slice(index, index + 2).toUpperCase() === "AS" &&
    !isIdentifierChar(masked.charAt(index - 1)) &&
    !isIdentifierChar(masked.charAt(index + 2))
  );
}

/**
 * Skip a single CTE name at `start` and return the index just past it.
 * `cteListEndIndex`'s surrounding walk otherwise skips whitespace and reads
 * an identifier entirely against `masked` - but a quoted identifier's masked
 * span is blanked out exactly like real whitespace, indistinguishable from
 * it without consulting the original text. So this skips genuine
 * whitespace/comments against the unmasked `sql` first (mirroring
 * `firstKeyword`'s own prologue), then, if the next real character is a
 * quote mark, jumps past the whole quoted span via `skipQuotedText` instead
 * of falling through to the bare-identifier scan - which would otherwise
 * slide straight through the quoted name and misread whatever keyword comes
 * next (typically `AS`) as if it were the CTE's name.
 */
function skipCteName(sql: string, masked: string, start: number): number {
  let index = start;
  while (index < sql.length) {
    const char = sql.charAt(index);
    if (char.trim().length === 0) {
      index += 1;
      continue;
    }
    if (char === "-" && sql.charAt(index + 1) === "-") {
      index = skipLineComment(sql, index);
      continue;
    }
    if (char === "/" && sql.charAt(index + 1) === "*") {
      index = skipBlockComment(sql, index);
      continue;
    }
    break;
  }
  if (sql.charAt(index) === "'" || sql.charAt(index) === '"') {
    return skipQuotedText(sql, index);
  }
  let end = index;
  while (end < masked.length && isIdentifierChar(masked.charAt(end))) {
    end += 1;
  }
  return end;
}

/**
 * The position where a `WITH` statement's real trailing statement begins —
 * just past its comma-separated CTE definitions (each `name [(cols)] AS
 * (body)`) — found by structurally walking that grammar rather than
 * searching for an expected keyword, so it correctly resolves *any*
 * trailing statement type (DML, DDL, `CALL`, or anything else), not just a
 * fixed candidate list. Returns `undefined` only when the CTE-list syntax
 * itself does not parse (malformed input, or an unrecognized variant) —
 * callers must fail closed on that, never default it to "select".
 */
function cteListEndIndex(sql: string, masked: string, afterWith: number): number | undefined {
  let index = afterWith;
  for (;;) {
    index = skipCteName(sql, masked, index);
    index = skipWhitespace(masked, index);
    if (masked.charAt(index) === "(") {
      // An optional explicit column list: `cte_name (col1, col2) AS (...)`.
      const columnListEnd = matchingCloseParenIndex(masked, index);
      if (columnListEnd === undefined) {
        return undefined;
      }
      index = skipWhitespace(masked, columnListEnd + 1);
    }
    if (!isAsKeywordAt(masked, index)) {
      return undefined;
    }
    index = skipWhitespace(masked, index + 2);
    if (masked.charAt(index) !== "(") {
      return undefined;
    }
    const closeIndex = matchingCloseParenIndex(masked, index);
    if (closeIndex === undefined) {
      return undefined;
    }
    index = skipWhitespace(masked, closeIndex + 1);
    if (masked.charAt(index) === ",") {
      index += 1;
      continue;
    }
    return index;
  }
}

export interface EffectiveStatement {
  readonly keyword: string;
  readonly index: number;
}

/**
 * Resolves a `WITH`-led statement down to its real trailing statement's
 * leading keyword and start position (an index into the original,
 * unmasked `sql`) — `undefined` only when the CTE-list itself doesn't parse
 * (see `cteListEndIndex`). Quoted identifiers/string literals/comments are
 * masked first, so a CTE literally (quoted-)named e.g. `"DELETE"` can never
 * be mistaken for the real keyword.
 */
export function resolveWithStatement(sql: string): EffectiveStatement | undefined {
  const withIndex = topLevelKeywordIndex(sql, "WITH");
  if (withIndex === undefined) {
    return undefined;
  }
  const masked = maskIgnoredSqlText(sql);
  const trailingIndex = cteListEndIndex(sql, masked, withIndex + "WITH".length);
  if (trailingIndex === undefined) {
    return undefined;
  }
  let keywordEnd = trailingIndex;
  while (keywordEnd < masked.length && isIdentifierChar(masked.charAt(keywordEnd))) {
    keywordEnd += 1;
  }
  return { keyword: masked.slice(trailingIndex, keywordEnd).toUpperCase(), index: trailingIndex };
}

function classifyByKeyword(keyword: string): StatementKind {
  if (SELECT_KEYWORDS.has(keyword)) {
    return "select";
  }
  if (DML_KEYWORDS.has(keyword)) {
    return "dml";
  }
  if (DDL_KEYWORDS.has(keyword)) {
    return "ddl";
  }
  return "unknown";
}

/** Classify a SQL statement by its leading keyword. */
export function classifyStatement(sql: string): StatementKind {
  const keyword = firstKeyword(sql);
  if (keyword === "WITH") {
    const resolved = resolveWithStatement(sql);
    // Fail closed: an unparseable CTE-list is never assumed to be a safe read.
    return resolved === undefined ? "unknown" : classifyByKeyword(resolved.keyword);
  }
  return classifyByKeyword(keyword);
}

/** Quote a SQL identifier (table/column name) for safe interpolation. */
export function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) {
    throw new QueryError("A SQL identifier must not be empty");
  }
  if (identifier.includes("\0")) {
    throw new QueryError("A SQL identifier must not contain a NUL character");
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Build a `"schema"."table"` qualified, quoted name. */
export function qualifiedName(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

/** Count `?` placeholders, skipping string literals, quoted identifiers, and comments. */
export function countPlaceholders(sql: string): number {
  let count = 0;
  let index = 0;
  const length = sql.length;

  while (index < length) {
    const char = sql[index];

    if (char === "'" || char === '"') {
      const quote = char;
      index += 1;
      while (index < length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < length && !(sql[index] === "*" && sql[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char === "?") {
      count += 1;
    }
    index += 1;
  }

  return count;
}

/** Throw when the number of `?` placeholders does not match the parameter count. */
export function assertParamArity(sql: string, params: readonly SqlParam[]): void {
  const expected = countPlaceholders(sql);
  if (expected !== params.length) {
    throw new QueryError(
      `SQL expects ${String(expected)} bound parameter(s) ` +
        `but received ${String(params.length)} value(s)`,
    );
  }
}
