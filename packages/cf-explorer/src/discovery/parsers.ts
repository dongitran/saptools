import type {
  FindMatch,
  GrepMatch,
  InspectCandidatesResult,
  InstanceInfo,
  LsEntry,
  SuggestedBreakpoint,
  ViewLine,
} from "../core/types.js";

const ROOT_LINE_PATTERN = /^CFX\tROOT\t(.+)$/;
const FIND_LINE_PATTERN = /^CFX\tFIND\t(file|directory)\t(.+)$/;
const LS_LINE_PATTERN = /^CFX\tLS\t(file|directory|symlink|other)\t([^\t]+)\t([^\t]+)(?:\t(.*))?$/;
const LEGACY_GREP_PREFIX = "CFX\tGREP\t";
const VIEW_LINE_PATTERN = /^CFX\tLINE\t(\d+)\t(.*)$/;
const SYSTEM_ROOTS = new Set(["/srv"]);

export function parseRootsOutput(stdout: string): readonly string[] {
  return uniqueSorted(
    stdout
      .split(/\r?\n/)
      .map((line) => ROOT_LINE_PATTERN.exec(line)?.[1])
      .filter((path): path is string => path !== undefined && path.length > 0)
      .filter((path) => !SYSTEM_ROOTS.has(path)),
  );
}

export function parseFindOutput(stdout: string, instance: number): readonly FindMatch[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => FIND_LINE_PATTERN.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => {
      const kind = match[1] === "directory" ? "directory" as const : "file" as const;
      return { instance, kind, path: match[2] ?? "" };
    })
    .filter((match) => match.path.length > 0);
}

export function parseLsOutput(stdout: string, instance: number): readonly LsEntry[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => LS_LINE_PATTERN.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => {
      const target = match[4] ?? "";
      return {
        instance,
        kind: parseLsKind(match[1] ?? "other"),
        name: match[2] ?? "",
        path: match[3] ?? "",
        ...(target.length === 0 ? {} : { target }),
      };
    })
    .filter((entry) => entry.name.length > 0 && entry.path.length > 0);
}

export function parseGrepOutput(
  stdout: string,
  instance: number,
  includePreview: boolean,
): readonly GrepMatch[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => parseGrepLine(line, instance, includePreview))
    .filter((match): match is GrepMatch => match !== undefined);
}

export function parseViewOutput(stdout: string): readonly ViewLine[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => VIEW_LINE_PATTERN.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ line: parsePositiveDecimal(match[1] ?? "") ?? 0, text: match[2] ?? "" }))
    .filter((line) => line.line > 0);
}

export function parseInspectOutput(
  stdout: string,
  instance: number,
  includePreview: boolean,
  includeFiles = true,
): Pick<InspectCandidatesResult, "contentMatches" | "files" | "roots" | "suggestedBreakpoints"> {
  const roots = parseRootsOutput(stdout);
  const files = uniqueFindMatches(parseFindOutput(stdout, instance));
  const contentMatches = uniqueGrepMatches(parseGrepOutput(stdout, instance, includePreview));
  return {
    roots,
    ...(includeFiles ? { files } : {}),
    contentMatches,
    suggestedBreakpoints: uniqueBreakpoints(suggestBreakpoints(roots, contentMatches)),
  };
}

export function parseCfAppInstances(stdout: string): readonly InstanceInfo[] {
  const rows = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map(parseInstanceRow)
    .filter((row): row is InstanceInfo => row !== undefined);
  if (rows.length > 0) {
    return rows;
  }
  return parseInstanceCountFallback(stdout);
}

export function suggestBreakpoints(
  roots: readonly string[],
  matches: readonly GrepMatch[],
): readonly SuggestedBreakpoint[] {
  return matches.map((match) => {
    const remoteRoot = roots.find((root) => match.path.startsWith(`${root}/`)) ?? roots[0] ?? "/";
    return {
      instance: match.instance,
      bp: match.path,
      remoteRoot,
      line: match.line,
      confidence: confidenceForPath(match.path),
      reason: "content match",
    };
  });
}

function parseGrepLine(
  lineText: string,
  instance: number,
  includePreview: boolean,
): GrepMatch | undefined {
  if (!lineText.startsWith(LEGACY_GREP_PREFIX)) {
    return undefined;
  }
  const payload = lineText.slice(LEGACY_GREP_PREFIX.length);
  return parseTabDelimitedGrepLine(payload, instance, includePreview)
    ?? parseLegacyGrepLine(payload, instance, includePreview);
}

function parseTabDelimitedGrepLine(
  payload: string,
  instance: number,
  includePreview: boolean,
): GrepMatch | undefined {
  const pathEnd = payload.indexOf("\t");
  if (pathEnd < 0) {
    return undefined;
  }
  const lineEnd = payload.indexOf("\t", pathEnd + 1);
  if (lineEnd < 0) {
    return undefined;
  }
  return toGrepMatch({
    path: payload.slice(0, pathEnd),
    line: payload.slice(pathEnd + 1, lineEnd),
    preview: payload.slice(lineEnd + 1),
  }, instance, includePreview);
}

function parseLegacyGrepLine(
  payload: string,
  instance: number,
  includePreview: boolean,
): GrepMatch | undefined {
  let separator = payload.indexOf(":", 1);
  while (separator >= 0) {
    let cursor = separator + 1;
    while (cursor < payload.length) {
      const code = payload.charCodeAt(cursor);
      if (code < 48 || code > 57) {
        break;
      }
      cursor += 1;
    }
    if (cursor > separator + 1 && payload[cursor] === ":") {
      const preview = payload.slice(cursor + 1);
      if (!/[\n\r\u2028\u2029]/u.test(preview)) {
        return toGrepMatch({
          path: payload.slice(0, separator),
          line: payload.slice(separator + 1, cursor),
          preview,
        }, instance, includePreview);
      }
      return undefined;
    }
    separator = payload.indexOf(":", separator + 1);
  }
  return undefined;
}

function toGrepMatch(
  input: { readonly path: string; readonly line: string; readonly preview: string },
  instance: number,
  includePreview: boolean,
): GrepMatch | undefined {
  const line = parsePositiveDecimal(input.line);
  const path = input.path;
  if (line === undefined || path.length === 0) {
    return undefined;
  }
  return {
    instance,
    path,
    line,
    ...(includePreview ? { preview: input.preview } : {}),
  };
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function advanceWhile(
  value: string,
  start: number,
  predicate: (character: string | undefined) => boolean,
): number {
  let cursor = start;
  while (cursor < value.length && predicate(value[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function parseInstanceRow(line: string): InstanceInfo | undefined {
  let cursor = line.startsWith("#") ? 1 : 0;
  const indexStart = cursor;
  cursor = advanceWhile(line, cursor, (character) => /[0-9]/u.test(character ?? ""));
  if (cursor === indexStart || !isWhitespace(line[cursor])) {
    return undefined;
  }
  const index = parseNonNegativeDecimal(line.slice(indexStart, cursor));
  if (index === undefined) {
    return undefined;
  }
  cursor = advanceWhile(line, cursor, isWhitespace);
  const stateStart = cursor;
  cursor = advanceWhile(line, cursor, (character) => /[A-Za-z_-]/u.test(character ?? ""));
  if (cursor === stateStart) {
    return undefined;
  }
  const state = line.slice(stateStart, cursor);
  if (cursor === line.length) {
    return { index, state };
  }
  if (!isWhitespace(line[cursor])) {
    return undefined;
  }
  cursor = advanceWhile(line, cursor, isWhitespace);
  const sinceStart = cursor;
  cursor = advanceWhile(line, cursor, (character) => !isWhitespace(character));
  const since = line.slice(sinceStart, cursor);
  if (since.length === 0) {
    return { index, state };
  }
  cursor = advanceWhile(line, cursor, isWhitespace);
  if (/[\n\r\u2028\u2029]/u.test(line.slice(cursor))) {
    return undefined;
  }
  return {
    index,
    state,
    since,
  };
}

function parseLsKind(value: string): LsEntry["kind"] {
  if (value === "file" || value === "directory" || value === "symlink") {
    return value;
  }
  return "other";
}

function parseInstanceCountFallback(stdout: string): readonly InstanceInfo[] {
  const match = /instances:\s*(\d+)\/(\d+)/i.exec(stdout);
  const running = parseNonNegativeDecimal(match?.[1] ?? "") ?? 0;
  if (running > 10_000) {
    return [];
  }
  return Array.from({ length: running }, (_value, index) => ({ index, state: "running" }));
}

function confidenceForPath(path: string): SuggestedBreakpoint["confidence"] {
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return "high";
  }
  return path.endsWith(".ts") ? "medium" : "low";
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function parsePositiveDecimal(value: string): number | undefined {
  const parsed = parseNonNegativeDecimal(value);
  return parsed === undefined || parsed <= 0 ? undefined : parsed;
}

function parseNonNegativeDecimal(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}


function uniqueFindMatches(matches: readonly FindMatch[]): readonly FindMatch[] {
  return uniqueBy(matches, (match) => `${match.instance.toString()}:${match.kind}:${normalizePath(match.path)}`);
}

function uniqueGrepMatches(matches: readonly GrepMatch[]): readonly GrepMatch[] {
  return uniqueBy(matches, (match) => `${match.instance.toString()}:${normalizePath(match.path)}:${match.line.toString()}`);
}

function uniqueBreakpoints(matches: readonly SuggestedBreakpoint[]): readonly SuggestedBreakpoint[] {
  return uniqueBy(matches, (match) => `${match.instance.toString()}:${normalizePath(match.bp)}:${match.line.toString()}`);
}

function uniqueBy<T>(values: readonly T[], keyFor: (value: T) => string): readonly T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyFor(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizePath(path: string): string {
  return path.replace(/\/+/g, "/");
}
