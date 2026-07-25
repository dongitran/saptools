export interface TopLevelToken {
  readonly keyword: string;
  readonly start: number;
  readonly end: number;
}

export interface ParsedTarget {
  readonly sql: string;
  readonly reference: string;
  readonly end: number;
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$#]/.test(char);
}

function skipQuotedText(sql: string, index: number): number {
  const quote = sql[index];
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === quote) {
      if (sql[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return cursor;
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

function skipNonCode(sql: string, index: number): number | undefined {
  const char = sql[index];
  if (char === "'" || char === '"') {
    return skipQuotedText(sql, index);
  }
  if (char === "-" && sql[index + 1] === "-") {
    return skipLineComment(sql, index);
  }
  if (char === "/" && sql[index + 1] === "*") {
    return skipBlockComment(sql, index);
  }
  return undefined;
}

export function skipTrivia(sql: string, start: number, end: number): number {
  let index = start;
  while (index < end) {
    if (/\s/.test(sql.charAt(index))) {
      index += 1;
      continue;
    }
    if (sql[index] === "-" && sql[index + 1] === "-") {
      index = skipLineComment(sql, index);
      continue;
    }
    if (sql[index] === "/" && sql[index + 1] === "*") {
      index = skipBlockComment(sql, index);
      continue;
    }
    break;
  }
  return index;
}

export function readIdentifierPart(
  sql: string,
  start: number,
  end: number,
): { readonly sql: string; readonly end: number } | undefined {
  const index = skipTrivia(sql, start, end);
  if (sql[index] === '"') {
    const next = skipQuotedText(sql, index);
    return next <= end && sql[next - 1] === '"'
      ? { sql: sql.slice(index, next), end: next }
      : undefined;
  }
  if (!/[A-Za-z_#$]/.test(sql.charAt(index))) {
    return undefined;
  }
  let next = index + 1;
  while (next < end && /[A-Za-z0-9_#$]/.test(sql.charAt(next))) {
    next += 1;
  }
  return { sql: sql.slice(index, next), end: next };
}

export function readQualifiedTarget(
  sql: string,
  start: number,
  end: number,
): ParsedTarget | undefined {
  const first = readIdentifierPart(sql, start, end);
  if (first === undefined) {
    return undefined;
  }
  const parts = [first.sql];
  let cursor = first.end;
  while (parts.length < 3) {
    const dot = skipTrivia(sql, cursor, end);
    if (sql[dot] !== ".") {
      break;
    }
    const part = readIdentifierPart(sql, dot + 1, end);
    if (part === undefined) {
      return undefined;
    }
    parts.push(part.sql);
    cursor = part.end;
  }
  return { sql: parts.join("."), reference: parts.at(-1) ?? first.sql, end: cursor };
}

export function topLevelTokens(sql: string): readonly TopLevelToken[] {
  const tokens: TopLevelToken[] = [];
  let index = 0;
  let depth = 0;
  while (index < sql.length) {
    const skipped = skipNonCode(sql, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const char = sql.charAt(index);
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (!/[A-Za-z_#$]/.test(char)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < sql.length && /[A-Za-z0-9_#$]/.test(sql.charAt(end))) {
      end += 1;
    }
    if (depth === 0) {
      tokens.push({ keyword: sql.slice(index, end).toUpperCase(), start: index, end });
    }
    index = end;
  }
  return tokens;
}

export function findToken(
  tokens: readonly TopLevelToken[],
  keyword: string,
  start = 0,
): number | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]?.keyword === keyword) {
      return index;
    }
  }
  return undefined;
}

function keywordMatches(sql: string, index: number, keyword: string): boolean {
  const end = index + keyword.length;
  return (
    sql.slice(index, end).toUpperCase() === keyword &&
    !isIdentifierChar(sql[index - 1]) &&
    !isIdentifierChar(sql[end])
  );
}

export function findTopLevelKeyword(
  sql: string,
  keyword: string,
  startIndex = 0,
): number | undefined {
  let index = startIndex;
  let depth = 0;
  while (index < sql.length) {
    const skipped = skipNonCode(sql, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const char = sql[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
    } else if (depth === 0 && keywordMatches(sql, index, keyword)) {
      return index;
    }
    index += 1;
  }
  return undefined;
}

export function findTopLevelChar(
  sql: string,
  target: string,
  startIndex: number,
  endIndex: number,
): number | undefined {
  let index = startIndex;
  let depth = 0;
  while (index < endIndex) {
    const skipped = skipNonCode(sql, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const char = sql[index];
    if (char === target && depth === 0) {
      return index;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
    }
    index += 1;
  }
  return undefined;
}
