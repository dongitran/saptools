import type {
  FindMatch,
  GrepMatch,
  InspectCandidatesResult,
  InstanceInfo,
  SuggestedBreakpoint,
  ViewLine,
} from "./types.js";

const ROOT_LINE_PATTERN = /^CFX\tROOT\t(.+)$/;
const FIND_LINE_PATTERN = /^CFX\tFIND\t(file|directory)\t(.+)$/;
const LEGACY_GREP_PREFIX = "CFX\tGREP\t";
const VIEW_LINE_PATTERN = /^CFX\tLINE\t(\d+)\t(.*)$/;

export function parseRootsOutput(stdout: string): readonly string[] {
  return uniqueSorted(
    stdout
      .split(/\r?\n/)
      .map((line) => ROOT_LINE_PATTERN.exec(line)?.[1])
      .filter((path): path is string => path !== undefined && path.length > 0),
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
    .map((match) => ({ line: Number.parseInt(match[1] ?? "0", 10), text: match[2] ?? "" }))
    .filter((line) => line.line > 0);
}

export function parseInspectOutput(
  stdout: string,
  instance: number,
  includePreview: boolean,
): Pick<InspectCandidatesResult, "contentMatches" | "files" | "roots" | "suggestedBreakpoints"> {
  const roots = parseRootsOutput(stdout);
  const files = parseFindOutput(stdout, instance);
  const contentMatches = parseGrepOutput(stdout, instance, includePreview);
  return {
    roots,
    files,
    contentMatches,
    suggestedBreakpoints: suggestBreakpoints(roots, contentMatches),
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
  const match = /^(.+?):(\d+):(.*)$/.exec(payload);
  if (match === null) {
    return undefined;
  }
  return toGrepMatch({
    path: match[1] ?? "",
    line: match[2] ?? "",
    preview: match[3] ?? "",
  }, instance, includePreview);
}

function toGrepMatch(
  input: { readonly path: string; readonly line: string; readonly preview: string },
  instance: number,
  includePreview: boolean,
): GrepMatch | undefined {
  const line = Number.parseInt(input.line, 10);
  const path = input.path;
  if (!Number.isInteger(line) || line <= 0 || path.length === 0) {
    return undefined;
  }
  return {
    instance,
    path,
    line,
    ...(includePreview ? { preview: input.preview } : {}),
  };
}

function parseInstanceRow(line: string): InstanceInfo | undefined {
  const match = /^#?(\d+)\s+([a-zA-Z_-]+)(?:\s+(.+))?$/.exec(line);
  if (match === null) {
    return undefined;
  }
  return {
    index: Number.parseInt(match[1] ?? "0", 10),
    state: match[2] ?? "unknown",
    ...(match[3] === undefined ? {} : { since: match[3].trim() }),
  };
}

function parseInstanceCountFallback(stdout: string): readonly InstanceInfo[] {
  const match = /instances:\s*(\d+)\/(\d+)/i.exec(stdout);
  const running = Number.parseInt(match?.[1] ?? "0", 10);
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
