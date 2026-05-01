import { CfExplorerError } from "./errors.js";

const DEFAULT_MAX_FILES = 200;
const DEFAULT_CONTEXT_LINES = 5;
const MAX_CONTEXT_LINES = 50;
const NOISY_DIRS = ["node_modules", ".git", "dist", "build", ".cache", "tmp", "temp"] as const;
const ROOT_CANDIDATES = ["/home/vcap/app", "/workspace/app", "/workspace", "/app", "/srv", "/opt/app"] as const;

export interface RemoteScript {
  readonly script: string;
}

export interface BuildFindScriptInput {
  readonly root: string;
  readonly name: string;
  readonly maxFiles?: number;
}

export interface BuildLsScriptInput {
  readonly path: string;
  readonly maxFiles?: number;
}

export interface BuildGrepScriptInput {
  readonly root: string;
  readonly text: string;
  readonly maxFiles?: number;
  readonly preview?: boolean;
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
    throw new CfExplorerError("UNSAFE_INPUT", "context must be between 0 and 50.");
  }
  return context;
}

export function buildRootsScript(maxFiles?: number): RemoteScript {
  const max = resolveMaxFiles(maxFiles);
  const rootLines = ROOT_CANDIDATES.map((root) => `emit_root ${quoteRemoteShellArg(root)}`).join("\n");
  return {
    script: [
      "CFX_OP='roots'",
      emitFunctions(),
      rootLines,
      `${rootDiscoveryFind(max)} | sed 's#/[^/]*$##' | head -n ${max.toString()} | while IFS= read -r cfx_root; do emit_root "$cfx_root"; done`,
    ].join("\n"),
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
      emitFunctions(),
      `find "$CFX_ROOT" ${pruneExpression()} -prune -o \\( -type f -o -type d \\) -iname "$CFX_NAME" -print 2>/dev/null | head -n ${max.toString()} | while IFS= read -r cfx_path; do emit_find "$cfx_path"; done`,
    ].join("\n"),
  };
}

export function buildLsScript(input: BuildLsScriptInput): RemoteScript {
  assertSafeRemoteRoot(input.path);
  const max = resolveMaxFiles(input.maxFiles);
  return {
    script: [
      "CFX_OP='ls'",
      `CFX_PATH=${quoteRemoteShellArg(input.path)}`,
      emitLsFunction(),
      "[ -d \"$CFX_PATH\" ] || exit 0",
      `find "$CFX_PATH" -mindepth 1 -maxdepth 1 -print 2>/dev/null | sort | head -n ${max.toString()} | while IFS= read -r cfx_path; do emit_ls "$cfx_path"; done`,
    ].join("\n"),
  };
}

export function buildGrepScript(input: BuildGrepScriptInput): RemoteScript {
  assertSafeRemoteRoot(input.root);
  assertSafeRemoteValue(input.text, "search text");
  const max = resolveMaxFiles(input.maxFiles);
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
      emitFunctions(),
      grepCommand('"$CFX_ROOT"', "$CFX_TEXT", emitHit, max),
    ].join("\n"),
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
  const max = resolveMaxFiles(input.maxFiles);
  const name = input.name?.includes("*") ? input.name : `*${input.name ?? ""}*`;
  return {
    script: input.root === undefined
      ? buildDynamicInspectScript(input.text, name, max)
      : buildSingleRootInspectScript(input.root, input.text, name, max),
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
    "  printf 'CFX\\tLS\\t%s\\t%s\\t%s\\n' \"$cfx_kind\" \"$cfx_name\" \"$cfx_path\"",
    "}",
  ].join("\n");
}

function pruneExpression(): string {
  const paths = NOISY_DIRS.flatMap((dir) => [`-path '*/${dir}'`, `-path '*/${dir}/*'`]);
  return `\\( ${paths.join(" -o ")} \\)`;
}

function buildSingleRootInspectScript(
  root: string,
  text: string,
  name: string,
  max: number,
): string {
  return [
    "CFX_OP='inspect'",
    `CFX_ROOT=${quoteRemoteShellArg(root)}`,
    `CFX_TEXT=${quoteRemoteShellArg(text)}`,
    `CFX_NAME=${quoteRemoteShellArg(name)}`,
    emitFunctions(),
    "inspect_root() {",
    "  cfx_root=\"$1\"",
    "  [ -d \"$cfx_root\" ] || return 0",
    "  emit_root \"$cfx_root\"",
    `  ${findCommand('"$cfx_root"', "$CFX_NAME", max)}`,
    `  ${grepCommand('"$cfx_root"', "$CFX_TEXT", grepEmitHit(false), max)}`,
    "}",
    "inspect_root \"$CFX_ROOT\"",
  ].join("\n");
}

function buildDynamicInspectScript(text: string, name: string, max: number): string {
  const candidateLines = ROOT_CANDIDATES
    .map((root) => `printf '%s\\n' ${quoteRemoteShellArg(root)}`)
    .join("\n");
  return [
    "CFX_OP='inspect'",
    `CFX_TEXT=${quoteRemoteShellArg(text)}`,
    `CFX_NAME=${quoteRemoteShellArg(name)}`,
    emitFunctions(),
    "inspect_root() {",
    "  cfx_root=\"$1\"",
    "  [ -d \"$cfx_root\" ] || return 0",
    "  emit_root \"$cfx_root\"",
    `  ${findCommand('"$cfx_root"', "$CFX_NAME", max)}`,
    `  ${grepCommand('"$cfx_root"', "$CFX_TEXT", grepEmitHit(false), max)}`,
    "}",
    "{",
    candidateLines,
    `${rootDiscoveryFind(max)} | sed 's#/[^/]*$##'`,
    `} | sort -u | head -n ${max.toString()} | while IFS= read -r cfx_root; do inspect_root "$cfx_root"; done`,
  ].join("\n");
}

function rootDiscoveryFind(max: number): string {
  return `find / -maxdepth 4 ${pruneExpression()} -prune -o -type f \\( -name 'package.json' -o -name '*.js' -o -name '*.ts' \\) -print 2>/dev/null | head -n ${(max * 4).toString()}`;
}

function findCommand(rootExpression: string, nameExpression: string, max: number): string {
  return `find ${rootExpression} ${pruneExpression()} -prune -o \\( -type f -o -type d \\) -iname "${nameExpression}" -print 2>/dev/null | head -n ${max.toString()} | while IFS= read -r cfx_path; do emit_find "$cfx_path"; done`;
}

function grepCommand(
  rootExpression: string,
  textExpression: string,
  emitHit: string,
  max: number,
): string {
  return `find ${rootExpression} ${pruneExpression()} -prune -o -type f -print 2>/dev/null | while IFS= read -r cfx_file; do grep -n -I -F -- "${textExpression}" "$cfx_file" 2>/dev/null | while IFS= read -r cfx_hit; do ${emitHit}; done; done | head -n ${max.toString()}`;
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
