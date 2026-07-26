/**
 * Low-level, dependency-free SQL text scanning primitives shared by
 * `statements.ts` (statement classification, `WITH`-clause resolution)
 * and `routine-carve-out.ts` (the routine/anonymous-block multi-statement
 * exemption). Split out on its own so those two modules can both depend
 * on this one without depending on each other.
 */

/** Skip a `--` line comment starting at `start`; returns the index just past its trailing newline (or end of string). */
export function skipLineComment(sql: string, start: number): number {
  let index = start + 2;
  while (index < sql.length && sql[index] !== "\n") {
    index += 1;
  }
  return index;
}

/** Skip whitespace, line comments, and block comments starting at `start`. */
export function skipWhitespaceAndComments(sql: string, start: number): number {
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
export function keywordAt(sql: string, start: number): { readonly keyword: string; readonly end: number } {
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

export function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_$#]/.test(char);
}

export function skipWhitespace(masked: string, start: number): number {
  let index = start;
  while (index < masked.length && /\s/.test(masked.charAt(index))) {
    index += 1;
  }
  return index;
}
