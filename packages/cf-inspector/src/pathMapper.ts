import { CfInspectorError } from "./types.js";
import type { BreakpointLocation, RemoteRootSetting } from "./types.js";

const REGEX_PREFIX = "regex:";
// cspell:ignore dgimsuvy
const REGEX_FLAGS_PATTERN = /^[dgimsuvy]*$/;
const TS_JS_EXT_PATTERN = /\.(?:ts|js|mts|mjs|cts|cjs)$/i;

/**
 * `--remote-root regex:...`/`/pattern/flags` lets an operator supply a raw
 * regex on purpose (unlike every other input here, which goes through
 * `escapeRegExp`) — CodeQL correctly flags "regex built from user input" on
 * that path. Bounding length and rejecting the classic nested-quantifier
 * shape (`(x+)+`, `(x*)+`, `(x+)*`, ...) is defense-in-depth: this is a local
 * CLI operated by whoever supplies the pattern, not a network-facing input,
 * so the realistic risk is an operator DoS-ing their own debugger session,
 * but a bad pattern should still fail fast with a clear message rather than
 * hang the process.
 */
const MAX_REMOTE_ROOT_PATTERN_LENGTH = 200;
const NESTED_QUANTIFIER_PATTERN = /\([^()]*[+*][^()]*\)[+*]/;

function assertSafeRemoteRootPattern(pattern: string): void {
  if (pattern.length > MAX_REMOTE_ROOT_PATTERN_LENGTH) {
    throw new CfInspectorError(
      "INVALID_REMOTE_ROOT",
      `--remote-root regex pattern is too long (${pattern.length.toString()} chars, max ${MAX_REMOTE_ROOT_PATTERN_LENGTH.toString()}) — this bounds worst-case backtracking cost`,
    );
  }
  if (NESTED_QUANTIFIER_PATTERN.test(pattern)) {
    throw new CfInspectorError(
      "INVALID_REMOTE_ROOT",
      `--remote-root regex pattern "${pattern}" contains a nested quantifier (e.g. "(x+)+"), which can cause catastrophic backtracking — simplify the pattern`,
    );
  }
}

export function parseBreakpointSpec(input: string): BreakpointLocation {
  const idx = input.lastIndexOf(":");
  if (idx <= 0 || idx === input.length - 1) {
    throw new CfInspectorError(
      "INVALID_BREAKPOINT",
      `Breakpoint must be in 'file:line' form, received: "${input}"`,
    );
  }
  const file = input.slice(0, idx).trim();
  const lineRaw = input.slice(idx + 1).trim();
  const line = Number.parseInt(lineRaw, 10);
  if (!Number.isInteger(line) || line <= 0 || line.toString() !== lineRaw) {
    throw new CfInspectorError(
      "INVALID_BREAKPOINT",
      `Breakpoint line must be a positive integer, received: "${lineRaw}"`,
    );
  }
  if (file.length === 0) {
    throw new CfInspectorError(
      "INVALID_BREAKPOINT",
      `Breakpoint file path is empty in "${input}"`,
    );
  }
  return { file, line };
}

export function parseRemoteRoot(value: string | undefined): RemoteRootSetting {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return { kind: "none" };
  }
  if (trimmed.startsWith(REGEX_PREFIX)) {
    return toRegex(trimmed.slice(REGEX_PREFIX.length), "");
  }
  const slashRegex = parseSlashDelimited(trimmed);
  if (slashRegex !== undefined) {
    return toRegex(slashRegex.pattern, slashRegex.flags);
  }
  return { kind: "literal", value: stripTrailingSlash(trimmed) };
}

function toRegex(pattern: string, flags: string): RemoteRootSetting {
  assertSafeRemoteRootPattern(pattern);
  return { kind: "regex", pattern, flags };
}

function parseSlashDelimited(value: string): { pattern: string; flags: string } | undefined {
  if (!value.startsWith("/")) {
    return undefined;
  }
  const closing = findLastUnescapedSlash(value);
  if (closing <= 0) {
    return undefined;
  }
  const flags = value.slice(closing + 1);
  // Disambiguate with literal paths: a path like "/home/vcap/app/" would parse
  // as `/<pattern>/` with empty flags. We require non-empty flags for the
  // slash-delimited form; flagless regexes must use the explicit "regex:" prefix.
  if (flags.length === 0 || !REGEX_FLAGS_PATTERN.test(flags)) {
    return undefined;
  }
  return { pattern: value.slice(1, closing), flags };
}

function findLastUnescapedSlash(value: string): number {
  for (let i = value.length - 1; i > 0; i--) {
    if (value[i] === "/" && !isEscaped(value, i)) {
      return i;
    }
  }
  return -1;
}

function isEscaped(value: string, idx: number): boolean {
  let backslashes = 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (value[i] === "\\") {
      backslashes++;
    } else {
      break;
    }
  }
  return backslashes % 2 === 1;
}

function stripTrailingSlash(value: string): string {
  if (value.length > 1 && value.endsWith("/")) {
    return value.slice(0, -1);
  }
  return value;
}

function normalizeRegexRootPattern(pattern: string): string {
  const withoutStartAnchor = pattern.startsWith("^") ? pattern.slice(1) : pattern;
  const withoutEndAnchor =
    withoutStartAnchor.endsWith("$") && !isEscaped(withoutStartAnchor, withoutStartAnchor.length - 1)
      ? withoutStartAnchor.slice(0, -1)
      : withoutStartAnchor;
  return stripTrailingSlash(withoutEndAnchor);
}

function buildFileUrlRegex(embeddedRoot: string, tail: string, separator: "" | "/"): string {
  return `^file://${embeddedRoot}${separator}${tail}$`;
}

function rootSeparator(rawPattern: string): "" | "/" {
  return rawPattern.endsWith("/") ? "" : "/";
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function normalizeRelative(file: string): string {
  return file.replaceAll(/^[./\\]+/g, "").replaceAll("\\", "/");
}

function dropExtension(file: string): { stem: string; matchedExt: boolean } {
  const match = TS_JS_EXT_PATTERN.exec(file);
  if (!match) {
    return { stem: file, matchedExt: false };
  }
  return { stem: file.slice(0, match.index), matchedExt: true };
}

const EXT_GROUP = String.raw`\.(?:ts|js|mts|mjs|cts|cjs)`;
const OPTIONAL_EXT_GROUP = String.raw`(?:\.(?:ts|js|mts|mjs|cts|cjs))?`;

export interface BuildUrlRegexInput {
  readonly file: string;
  readonly remoteRoot: RemoteRootSetting;
}

export function buildBreakpointUrlRegex(input: BuildUrlRegexInput): string {
  const normalized = normalizeRelative(input.file);
  const { stem, matchedExt } = dropExtension(normalized);
  const escapedStem = escapeRegExp(stem);
  const tail = matchedExt ? `${escapedStem}${EXT_GROUP}` : `${escapedStem}${OPTIONAL_EXT_GROUP}`;

  switch (input.remoteRoot.kind) {
    case "none": {
      return `(?:^|/)${tail}$`;
    }
    case "literal": {
      const root = input.remoteRoot.value;
      return buildFileUrlRegex(escapeRegExp(root), tail, rootSeparator(root));
    }
    case "regex": {
      const root = normalizeRegexRootPattern(input.remoteRoot.pattern);
      // Wrap the user pattern in a non-capturing group so alternation in the
      // user's regex (e.g. `regex:a|b`) does not bind to the surrounding
      // `^file://` / tail. Without this, the engine would parse the result as
      // `(^file://a)|(b/.../src/...$)`.
      return buildFileUrlRegex(`(?:${root})`, tail, rootSeparator(root));
    }
  }
}
