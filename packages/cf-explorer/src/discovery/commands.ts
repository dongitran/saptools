import { CfExplorerError } from "../core/errors.js";

const DEFAULT_MAX_FILES = 200;
const DEFAULT_CONTEXT_LINES = 5;
const MAX_CONTEXT_LINES = 1_000;
const NOISY_DIRS = ["node_modules", ".git", "dist", "build", ".cache", "tmp", "temp"] as const;
const ROOT_CANDIDATES = ["/home/vcap/app", "/workspace/app", "/workspace", "/app", "/opt/app"] as const;

export interface RemoteScript {
  readonly script: string;
  readonly maxFiles?: number;
  readonly maxMatches?: number;
}

export interface BuildFindScriptInput {
  readonly root: string;
  readonly name: string;
  readonly maxFiles?: number;
  readonly followSymlinks?: boolean;
}

export interface BuildLsScriptInput {
  readonly path: string;
  readonly maxFiles?: number;
  readonly pattern?: string;
  readonly followSymlinks?: boolean;
}

export interface BuildGrepScriptInput {
  readonly root: string;
  readonly text: string;
  readonly maxFiles?: number;
  readonly maxMatches?: number;
  readonly preview?: boolean;
  readonly includeFiles?: boolean;
  readonly followSymlinks?: boolean;
}

export interface BuildViewScriptInput {
  readonly file: string;
  readonly line: number;
  readonly context?: number;
}

export interface BuildInspectScriptInput {
  readonly text: string;
  readonly root?: string;
  readonly name?: string;
  readonly maxFiles?: number;
  readonly maxMatches?: number;
  readonly includeFiles?: boolean;
  readonly followSymlinks?: boolean;
}

export function quoteRemoteShellArg(value: string): string {
  assertSafeRemoteValue(value, "remote value");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function assertSafeRemoteValue(value: string, label: string): void {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} must not contain NUL or newlines.`);
  }
  if (/[<>`]/.test(value) || value.includes("$(")) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} contains unsafe shell syntax.`);
  }
  if (value.includes(";") || value.includes("|") || value.includes("&&") || value.includes("||")) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} contains command separators.`);
  }
}

export function assertSafeRemoteRoot(path: string): void {
  assertSafeRemoteValue(path, "remote root");
  if (!path.startsWith("/")) {
    throw new CfExplorerError("UNSAFE_INPUT", "Remote root must be absolute.");
  }
  if (path.split("/").includes("..")) {
    throw new CfExplorerError("UNSAFE_INPUT", "Remote root must not contain parent traversal.");
  }
}

export function assertSafeRemoteFile(path: string): void {
  assertSafeRemoteRoot(path);
}

export function resolveMaxFiles(value: number | undefined): number {
  const maxFiles = value ?? DEFAULT_MAX_FILES;
  if (!Number.isInteger(maxFiles) || maxFiles <= 0 || maxFiles > 10_000) {
    throw new CfExplorerError("UNSAFE_INPUT", "maxFiles must be between 1 and 10000.");
  }
  return maxFiles;
}

export function resolveContextLines(value: number | undefined): number {
  const context = value ?? DEFAULT_CONTEXT_LINES;
  if (!Number.isInteger(context) || context < 0 || context > MAX_CONTEXT_LINES) {
    throw new CfExplorerError("UNSAFE_INPUT", "context must be between 0 and 1000.");
  }
  return context;
}

export function buildRootsScript(maxFiles?: number): RemoteScript {
  const max = resolveMaxFiles(maxFiles);
  return {
    script: [
      "CFX_OP='roots'",
      `CFX_MAX_FILES=${max.toString()}`,
      `CFX_FETCH_FILES=${probeLimit(max).toString()}`,
      emitFunctions(),
      `${rootCandidateStream()} | sort -u | head -n "$CFX_FETCH_FILES" | while IFS= read -r cfx_root; do emit_root "$cfx_root"; done`,
    ].join("\n"),
    maxFiles: max,
  };
}

export function buildFindScript(input: BuildFindScriptInput): RemoteScript {
  assertSafeRemoteRoot(input.root);
  assertSafeRemoteValue(input.name, "file name pattern");
  const max = resolveMaxFiles(input.maxFiles);
  const pattern = input.name.includes("*") ? input.name : `*${input.name}*`;
  return {
    script: [
      "CFX_OP='find'",
      `CFX_ROOT=${quoteRemoteShellArg(input.root)}`,
      `CFX_NAME=${quoteRemoteShellArg(pattern)}`,
      `CFX_MAX_FILES=${max.toString()}`,
      `CFX_FETCH_FILES=${probeLimit(max).toString()}`,
      emitFunctions(),
      findCommand('"$CFX_ROOT"', "$CFX_NAME", '"$CFX_FETCH_FILES"', input.followSymlinks === true),
    ].join("\n"),
    maxFiles: max,
  };
}

export function buildLsScript(input: BuildLsScriptInput): RemoteScript {
  assertSafeRemoteRoot(input.path);
  if (input.pattern !== undefined) {
    assertSafeRemoteValue(input.pattern, "file name pattern");
  }
  const max = resolveMaxFiles(input.maxFiles);
  const findName = input.pattern === undefined ? "" : ' -name "$CFX_PATTERN"';
  return {
    script: [
      "CFX_OP='ls'",
      `CFX_PATH=${quoteRemoteShellArg(input.path)}`,
      ...(input.pattern === undefined ? [] : [`CFX_PATTERN=${quoteRemoteShellArg(input.pattern)}`]),
      `CFX_MAX_FILES=${max.toString()}`,
      `CFX_FETCH_FILES=${probeLimit(max).toString()}`,
      emitLsFunction(),
      "[ -d \"$CFX_PATH\" ] || exit 0",
      `find${input.followSymlinks === true ? " -L" : ""} "$CFX_PATH" -mindepth 1 -maxdepth 1${findName} -print 2>/dev/null | sort | head -n "$CFX_FETCH_FILES" | while IFS= read -r cfx_path; do emit_ls "$cfx_path"; done`,
    ].join("\n"),
    maxFiles: max,
  };
}

export function buildGrepScript(input: BuildGrepScriptInput): RemoteScript {
  assertSafeRemoteRoot(input.root);
  assertSafeRemoteValue(input.text, "search text");
  const max = resolveMaxFiles(input.maxMatches ?? input.maxFiles);
  const emitHit = input.preview === true
    ? [
      "cfx_line=${cfx_hit%%:*}",
      "cfx_preview=${cfx_hit#*:}",
      "printf 'CFX\\tGREP\\t%s\\t%s\\t%s\\n' \"$cfx_file\" \"$cfx_line\" \"$cfx_preview\"",
    ].join("; ")
    : [
      "cfx_line=${cfx_hit%%:*}",
      "printf 'CFX\\tGREP\\t%s\\t%s\\t\\n' \"$cfx_file\" \"$cfx_line\"",
    ].join("; ");
  return {
    script: [
      "CFX_OP='grep'",
      `CFX_ROOT=${quoteRemoteShellArg(input.root)}`,
      `CFX_TEXT=${quoteRemoteShellArg(input.text)}`,
      `CFX_MAX_MATCHES=${max.toString()}`,
      `CFX_FETCH_MATCHES=${probeLimit(max).toString()}`,
      emitFunctions(),
      grepCommand('"$CFX_ROOT"', "$CFX_TEXT", emitHit, '"$CFX_FETCH_MATCHES"', input.followSymlinks === true),
    ].join("\n"),
    maxMatches: max,
  };
}

export function buildViewScript(input: BuildViewScriptInput): RemoteScript {
  assertSafeRemoteFile(input.file);
  if (!Number.isInteger(input.line) || input.line <= 0) {
    throw new CfExplorerError("UNSAFE_INPUT", "line must be a positive integer.");
  }
  const context = resolveContextLines(input.context);
  const start = Math.max(1, input.line - context);
  const end = input.line + context;
  return {
    script: [
      "CFX_OP='view'",
      `CFX_FILE=${quoteRemoteShellArg(input.file)}`,
      `CFX_VIEW_START=${start.toString()}`,
      `CFX_VIEW_END=${end.toString()}`,
      "awk -v cfx_start=\"$CFX_VIEW_START\" -v cfx_end=\"$CFX_VIEW_END\" 'NR >= cfx_start && NR <= cfx_end { printf \"CFX\\tLINE\\t%d\\t%s\\n\", NR, $0 }' \"$CFX_FILE\" 2>/dev/null",
    ].join("\n"),
  };
}

export function buildInspectCandidatesScript(input: BuildInspectScriptInput): RemoteScript {
  assertSafeRemoteValue(input.text, "search text");
  if (input.root !== undefined) {
    assertSafeRemoteRoot(input.root);
  }
  if (input.name !== undefined) {
    assertSafeRemoteValue(input.name, "file name pattern");
  }
  const maxFiles = resolveMaxFiles(input.maxFiles);
  const maxMatches = resolveMaxFiles(input.maxMatches);
  const includeFiles = input.includeFiles === true;
  const name = input.name?.includes("*") ? input.name : `*${input.name ?? ""}*`;
  return {
    script: input.root === undefined
      ? buildDynamicInspectScript(input.text, name, maxFiles, maxMatches, includeFiles, input.followSymlinks === true)
      : buildSingleRootInspectScript(input.root, input.text, name, maxFiles, maxMatches, includeFiles, input.followSymlinks === true),
    maxFiles,
    maxMatches,
  };
}

function emitFunctions(): string {
  return [
    "emit_root() { if [ -d \"$1\" ]; then printf 'CFX\\tROOT\\t%s\\n' \"$1\"; fi; }",
    "emit_find() { if [ -d \"$1\" ]; then printf 'CFX\\tFIND\\tdirectory\\t%s\\n' \"$1\"; else printf 'CFX\\tFIND\\tfile\\t%s\\n' \"$1\"; fi; }",
  ].join("\n");
}

function emitLsFunction(): string {
  return [
    "emit_ls() {",
    "  cfx_path=\"$1\"",
    "  if [ -L \"$cfx_path\" ]; then cfx_kind='symlink'; elif [ -d \"$cfx_path\" ]; then cfx_kind='directory'; elif [ -f \"$cfx_path\" ]; then cfx_kind='file'; else cfx_kind='other'; fi",
    "  cfx_name=${cfx_path##*/}",
    "  cfx_target=''",
    "  if [ -L \"$cfx_path\" ]; then cfx_target=$(readlink \"$cfx_path\" 2>/dev/null || true); fi",
    "  printf 'CFX\\tLS\\t%s\\t%s\\t%s\\t%s\\n' \"$cfx_kind\" \"$cfx_name\" \"$cfx_path\" \"$cfx_target\"",
    "}",
  ].join("\n");
}

function pruneExpression(input: { readonly includeNodeModules?: boolean } = {}): string {
  const dirs = input.includeNodeModules === true
    ? NOISY_DIRS.filter((dir) => dir !== "node_modules")
    : NOISY_DIRS;
  const paths = dirs.flatMap((dir) => [`-path '*/${dir}'`, `-path '*/${dir}/*'`]);
  return `\\( ${paths.join(" -o ")} \\)`;
}

function buildSingleRootInspectScript(
  root: string,
  text: string,
  name: string,
  maxFiles: number,
  maxMatches: number,
  includeFiles: boolean,
  followSymlinks: boolean,
): string {
  return [
    "CFX_OP='inspect'",
    `CFX_ROOT=${quoteRemoteShellArg(root)}`,
    `CFX_TEXT=${quoteRemoteShellArg(text)}`,
    `CFX_NAME=${quoteRemoteShellArg(name)}`,
    `CFX_MAX_FILES=${maxFiles.toString()}`,
    `CFX_FETCH_FILES=${probeLimit(maxFiles).toString()}`,
    `CFX_MAX_MATCHES=${maxMatches.toString()}`,
    `CFX_FETCH_MATCHES=${probeLimit(maxMatches).toString()}`,
    emitFunctions(),
    "inspect_root() {",
    "  cfx_root=\"$1\"",
    "  [ -d \"$cfx_root\" ] || return 0",
    "  emit_root \"$cfx_root\"",
    ...(includeFiles ? [`  ${findCommand('"$cfx_root"', "$CFX_NAME", '"$CFX_FETCH_FILES"', followSymlinks)}`] : []),
    `  ${grepCommand('"$cfx_root"', "$CFX_TEXT", grepEmitHit(false), '"$CFX_FETCH_MATCHES"', followSymlinks)}`,
    "}",
    "inspect_root \"$CFX_ROOT\"",
  ].join("\n");
}

function buildDynamicInspectScript(
  text: string,
  name: string,
  maxFiles: number,
  maxMatches: number,
  includeFiles: boolean,
  followSymlinks: boolean,
): string {
  return [
    "CFX_OP='inspect'",
    `CFX_TEXT=${quoteRemoteShellArg(text)}`,
    `CFX_NAME=${quoteRemoteShellArg(name)}`,
    `CFX_MAX_FILES=${maxFiles.toString()}`,
    `CFX_FETCH_FILES=${probeLimit(maxFiles).toString()}`,
    `CFX_MAX_MATCHES=${maxMatches.toString()}`,
    `CFX_FETCH_MATCHES=${probeLimit(maxMatches).toString()}`,
    emitFunctions(),
    "inspect_root() {",
    "  cfx_root=\"$1\"",
    "  [ -d \"$cfx_root\" ] || return 0",
    "  emit_root \"$cfx_root\"",
    ...(includeFiles ? [`  ${findCommand('"$cfx_root"', "$CFX_NAME", '"$CFX_FETCH_FILES"', followSymlinks)}`] : []),
    `  ${grepCommand('"$cfx_root"', "$CFX_TEXT", grepEmitHit(false), '"$CFX_FETCH_MATCHES"', followSymlinks)}`,
    "}",
    "cfx_root_count=0",
    `${rootCandidateStream()} | sort -u | head -n "$CFX_FETCH_FILES" | while IFS= read -r cfx_root; do`,
    "  cfx_root_count=$((cfx_root_count + 1))",
    "  if [ \"$cfx_root_count\" -le \"$CFX_MAX_FILES\" ]; then inspect_root \"$cfx_root\"; else emit_root \"$cfx_root\"; fi",
    "done",
  ].join("\n");
}

function rootCandidateStream(): string {
  const candidateLines = ROOT_CANDIDATES
    .map((root) => `if [ -d ${quoteRemoteShellArg(root)} ]; then printf '%s\\n' ${quoteRemoteShellArg(root)}; fi`)
    .join("\n");
  return [
    "{",
    candidateLines,
    `${rootDiscoveryFind()} | sed 's#/[^/]*$##' | while IFS= read -r cfx_root; do if [ "$cfx_root" != '/srv' ] && [ -d "$cfx_root" ]; then printf '%s\\n' "$cfx_root"; fi; done`,
    "}",
  ].join("\n");
}

function rootDiscoveryFind(): string {
  return `find / -maxdepth 4 ${pruneExpression()} -prune -o -type f \\( -name 'package.json' -o -name '*.js' -o -name '*.ts' \\) -print 2>/dev/null`;
}

function findCommand(rootExpression: string, nameExpression: string, limitExpression: string, followSymlinks = false): string {
  return `find${followSymlinks ? " -L" : ""} ${rootExpression} ${pruneExpression({ includeNodeModules: followSymlinks })} -prune -o \\( -type f -o -type d \\) -iname "${nameExpression}" -print 2>/dev/null | head -n ${limitExpression} | while IFS= read -r cfx_path; do emit_find "$cfx_path"; done`;
}

function grepCommand(
  rootExpression: string,
  textExpression: string,
  emitHit: string,
  limitExpression: string,
  followSymlinks = false,
): string {
  return `find${followSymlinks ? " -L" : ""} ${rootExpression} ${pruneExpression({ includeNodeModules: followSymlinks })} -prune -o -type f -print 2>/dev/null | while IFS= read -r cfx_file; do grep -n -I -F -- "${textExpression}" "$cfx_file" 2>/dev/null | while IFS= read -r cfx_hit; do ${emitHit}; done; done | head -n ${limitExpression}`;
}

function probeLimit(max: number): number {
  return max + 1;
}

function grepEmitHit(preview: boolean): string {
  return preview
    ? [
      "cfx_line=${cfx_hit%%:*}",
      "cfx_preview=${cfx_hit#*:}",
      "printf 'CFX\\tGREP\\t%s\\t%s\\t%s\\n' \"$cfx_file\" \"$cfx_line\" \"$cfx_preview\"",
    ].join("; ")
    : [
      "cfx_line=${cfx_hit%%:*}",
      "printf 'CFX\\tGREP\\t%s\\t%s\\t\\n' \"$cfx_file\" \"$cfx_line\"",
    ].join("; ");
}
