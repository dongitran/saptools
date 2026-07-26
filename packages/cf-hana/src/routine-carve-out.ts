import {
  isIdentifierChar,
  keywordAt,
  maskIgnoredSqlText,
  skipQuotedText,
  skipWhitespace,
  skipWhitespaceAndComments,
} from "./sql-scan.js";

const ROUTINE_KEYWORDS = new Set(["PROCEDURE", "FUNCTION", "TRIGGER"]);

interface HeaderMatch {
  readonly end: number;
  readonly isTrigger: boolean;
}

/**
 * Skip a routine/trigger name at `start` - a bare or quoted identifier,
 * optionally schema-qualified (`schema.name` or `"schema"."name"`) - and
 * return the index just past it. A routine can legitimately be named
 * after a word that also appears in a `HEADER_DISQUALIFYING_KEYWORDS_*`
 * list (e.g. an unquoted `replace`); skipping exactly the name here,
 * before that keyword scan ever starts, is what keeps such a routine from
 * being mistaken for a smuggled statement's leading verb. A single
 * identifier token can never itself contain a real top-level `;` or a
 * keyword-boundary-respecting keyword, so this cannot be abused to also
 * skip a real second statement. HANA anonymous `DO` blocks have no name
 * to skip; only `routineHeaderEnd` (not `blockHeaderEnd`) calls this.
 */
function skipRoutineName(sql: string, masked: string, start: number): number {
  const nameEnd = skipNameSegment(sql, masked, start);
  const afterDot = skipWhitespace(masked, nameEnd);
  if (masked.charAt(afterDot) !== ".") {
    return nameEnd;
  }
  return skipNameSegment(sql, masked, skipWhitespace(masked, afterDot + 1));
}

function skipNameSegment(sql: string, masked: string, start: number): number {
  const index = skipWhitespaceAndComments(sql, start);
  if (sql.charAt(index) === "'" || sql.charAt(index) === '"') {
    return skipQuotedText(sql, index);
  }
  let end = index;
  while (end < masked.length && isIdentifierChar(masked.charAt(end))) {
    end += 1;
  }
  return end;
}

/** The header keywords and name just past a `CREATE [OR REPLACE] PROCEDURE/FUNCTION/TRIGGER`, or `undefined`. */
function routineHeaderEnd(sql: string, masked: string, start: number): HeaderMatch | undefined {
  const create = keywordAt(sql, start);
  if (create.keyword !== "CREATE") {
    return undefined;
  }
  const second = keywordAt(sql, create.end);
  if (ROUTINE_KEYWORDS.has(second.keyword)) {
    return { end: skipRoutineName(sql, masked, second.end), isTrigger: second.keyword === "TRIGGER" };
  }
  if (second.keyword !== "OR") {
    return undefined;
  }
  const third = keywordAt(sql, second.end);
  const fourth = keywordAt(sql, third.end);
  return third.keyword === "REPLACE" && ROUTINE_KEYWORDS.has(fourth.keyword)
    ? { end: skipRoutineName(sql, masked, fourth.end), isTrigger: fourth.keyword === "TRIGGER" }
    : undefined;
}

/** The header keywords just past a HANA SQLScript anonymous block's `DO`, or `undefined`. */
function blockHeaderEnd(sql: string, start: number): HeaderMatch | undefined {
  const doKeyword = keywordAt(sql, start);
  return doKeyword.keyword === "DO" ? { end: doKeyword.end, isTrigger: false } : undefined;
}

// Keywords that could lead a genuinely separate, independently-dangerous
// statement, disqualifying a header-to-BEGIN region from being treated as
// a plausible routine/block header if found there at top level. `INSERT`/
// `UPDATE`/`DELETE` are excluded only for the `CREATE TRIGGER` case, since
// a trigger header legitimately references them as event keywords
// (`BEFORE INSERT`, `AFTER UPDATE`, `INSTEAD OF DELETE`) - excluding them
// for every type would (confirmed by running the existing test suite)
// wrongly reject a perfectly ordinary `CREATE TRIGGER ... BEFORE INSERT
// ... BEGIN ... END`. `MERGE`/`UPSERT`/`REPLACE` have no such legitimate
// role in a trigger header, so they stay disqualifying for every type,
// including `TRIGGER`.
const HEADER_DISQUALIFYING_KEYWORDS_BASE = [
  "SELECT",
  "CREATE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "RENAME",
  "COMMENT",
  "WITH",
  "CALL",
  "MERGE",
  "UPSERT",
  "REPLACE",
];
const HEADER_DISQUALIFYING_KEYWORDS_NON_TRIGGER = [...HEADER_DISQUALIFYING_KEYWORDS_BASE, "INSERT", "UPDATE", "DELETE"];

/**
 * The next top-level `BEGIN` or `END` keyword token in `masked` at or
 * after `start` (paren-depth aware, matching `topLevelKeywordIndex`'s own
 * convention in `statements.ts`), whichever comes first. `undefined` when
 * neither appears again before the end of the string. When
 * `headerDisqualifiers` is not `null`, a top-level `;` or any of those
 * keywords found before either `BEGIN`/`END` also makes this return
 * `undefined` - used only while scanning a routine/block *header* (see
 * `routineBodyEnd`), never while scanning inside an already-opened body,
 * where internal semicolons and arbitrary statement keywords are expected
 * and safe.
 */
function nextTopLevelBeginOrEnd(
  masked: string,
  start: number,
  headerDisqualifiers: readonly string[] | null,
): { readonly isBegin: boolean; readonly end: number } | undefined {
  let depth = 0;
  for (let index = start; index < masked.length; index += 1) {
    const char = masked.charAt(index);
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (
      headerDisqualifiers !== null &&
      (char === ";" || headerDisqualifiers.some((keyword) => matchesTopLevelWord(masked, index, keyword)))
    ) {
      return undefined;
    }
    if (matchesTopLevelWord(masked, index, "BEGIN")) {
      return { isBegin: true, end: index + "BEGIN".length };
    }
    if (matchesTopLevelWord(masked, index, "END")) {
      return { isBegin: false, end: index + "END".length };
    }
  }
  return undefined;
}

function matchesTopLevelWord(masked: string, index: number, word: string): boolean {
  return (
    masked.slice(index, index + word.length).toUpperCase() === word &&
    !isIdentifierChar(masked.charAt(index - 1)) &&
    !isIdentifierChar(masked.charAt(index + word.length))
  );
}

/**
 * The index just past a well-formed `BEGIN`/`END` body starting at or
 * after `start` in `masked`. The first top-level `BEGIN`-or-`END` token
 * found must actually be a `BEGIN` (a stray `END` first, or neither
 * appearing at all, is never a body) reached with nothing header-
 * disqualifying (see `nextTopLevelBeginOrEnd`) before it - a plain
 * existence/depth check alone is not enough: without also validating what
 * the header region between `start` and that first `BEGIN` contains, it
 * can be made to skip over an entire independent, `;`-or-keyword-led
 * statement on the way to a later, legitimate-looking `BEGIN ... END`,
 * which would otherwise exempt that smuggled statement along with it.
 * Nesting depth from that first `BEGIN` - incremented on each subsequent
 * top-level `BEGIN`, decremented on each `END`, with no further
 * restriction once inside the body - must then return to exactly 0
 * before the string ends. `undefined` when no well-formed body exists.
 */
function routineBodyEnd(masked: string, start: number, isTrigger: boolean): number | undefined {
  const headerDisqualifiers = isTrigger
    ? HEADER_DISQUALIFYING_KEYWORDS_BASE
    : HEADER_DISQUALIFYING_KEYWORDS_NON_TRIGGER;
  const first = nextTopLevelBeginOrEnd(masked, start, headerDisqualifiers);
  if (!first?.isBegin) {
    return undefined;
  }
  let depth = 1;
  let index = first.end;
  while (depth > 0) {
    const token = nextTopLevelBeginOrEnd(masked, index, null);
    if (token === undefined) {
      return undefined;
    }
    depth += token.isBegin ? 1 : -1;
    index = token.end;
  }
  return index;
}

/** Skip whitespace, comments, and top-level (unmasked) `;` separators starting at `start`. */
function skipInertBetweenChunks(sql: string, masked: string, start: number): number {
  let index = start;
  for (;;) {
    const afterWhitespace = skipWhitespaceAndComments(sql, index);
    if (masked.charAt(afterWhitespace) === ";") {
      index = afterWhitespace + 1;
      continue;
    }
    return afterWhitespace;
  }
}

function isCompleteBody(sql: string, masked: string, header: HeaderMatch): boolean {
  const bodyEnd = routineBodyEnd(masked, header.end, header.isTrigger);
  return bodyEnd !== undefined && skipInertBetweenChunks(sql, masked, bodyEnd) >= sql.length;
}

/**
 * Whether `sql` is, in its *entirety*, a single `CREATE [OR REPLACE]
 * PROCEDURE/FUNCTION/TRIGGER` definition with a real, genuinely balanced
 * top-level `BEGIN`/`END` body, and a plausible (not `;`-or-keyword-led)
 * header before that body. Narrow on purpose: `CREATE TABLE`/`VIEW`/
 * `INDEX` etc. do not get this exemption, since - unlike a routine body -
 * they have no legitimate reason to contain a top-level-looking `;`
 * before their own end. Requiring the body to reach genuinely all the way
 * to the end of the input (not just a `BEGIN` and an `END` to exist
 * somewhere, in any order) is what closes a reordered (`END ... BEGIN`)
 * or partial (`BEGIN END <real statement>`) forgery, and also closes the
 * "no body at all" bypass (`"CREATE PROCEDURE p; DROP TABLE other"`)
 * without a separate check. `hasMultipleStatements` (in `statements.ts`)
 * uses the separate, chain-aware `isRoutineOrBlockChain` below - which
 * additionally allows several such definitions back to back - to decide
 * its own exemption.
 */
export function isRoutineDefinition(sql: string): boolean {
  const masked = maskIgnoredSqlText(sql);
  const header = routineHeaderEnd(sql, masked, 0);
  return header !== undefined && isCompleteBody(sql, masked, header);
}

/**
 * Whether `sql` is, in its entirety, a single HANA SQLScript anonymous
 * block (`DO [(...)] BEGIN ... END`). Same structural requirement as
 * `isRoutineDefinition`, just with a `DO` header instead of a
 * `CREATE`-routine one.
 */
export function isAnonymousBlock(sql: string): boolean {
  const masked = maskIgnoredSqlText(sql);
  const header = blockHeaderEnd(sql, 0);
  return header !== undefined && isCompleteBody(sql, masked, header);
}

/**
 * Whether `sql` consists of one or more complete routine-definition/
 * anonymous-block chunks (see `isRoutineDefinition`/`isAnonymousBlock`),
 * back to back, with nothing but whitespace/comments/semicolons anywhere
 * between or around them. Chaining several legitimate definitions this
 * way is not itself dangerous - defining several procedures is not a
 * destructive act - but real content that is not itself the start of
 * another valid chunk ends the chain immediately and makes the whole
 * input non-exempt: a statement smuggled between two definitions, before
 * a chunk's own `BEGIN`, inside a reordered/partial body, or trailing
 * after a real one, is never swallowed by this exemption. Used only by
 * `hasMultipleStatements` (in `statements.ts`); `isRoutineDefinition`/
 * `isAnonymousBlock` intentionally keep their own narrower,
 * single-definition public contract.
 */
export function isRoutineOrBlockChain(sql: string): boolean {
  const masked = maskIgnoredSqlText(sql);
  let position = 0;
  let matchedAny = false;
  for (;;) {
    position = skipInertBetweenChunks(sql, masked, position);
    if (position >= sql.length) {
      return matchedAny;
    }
    const header = routineHeaderEnd(sql, masked, position) ?? blockHeaderEnd(sql, position);
    if (header === undefined) {
      return false;
    }
    const bodyEnd = routineBodyEnd(masked, header.end, header.isTrigger);
    if (bodyEnd === undefined) {
      return false;
    }
    position = bodyEnd;
    matchedAny = true;
  }
}
