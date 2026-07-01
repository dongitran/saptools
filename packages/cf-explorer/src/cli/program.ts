import process from "node:process";

import {
  readCurrentCfTarget,
  requireCurrentCfRegionKey,
  type CfExecContext,
  type CurrentCfTarget,
} from "@saptools/cf-sync";
import { Command } from "commander";

import { normalizeTarget, parseNonNegativeInteger, parsePositiveInteger } from "../cf/target.js";
import { CfExplorerError } from "../core/errors.js";
import { secondsToTimerMs } from "../core/limits.js";
import type {
  DiscoveryOptions,
  ExplorerRuntimeOptions,
  ExplorerTarget,
  FindOptions,
  GrepOptions,
  InspectCandidatesOptions,
  InstanceSelector,
  LsOptions,
  ViewOptions,
} from "../core/types.js";
import {
  findRemote,
  grepRemote,
  inspectCandidates,
  listInstances,
  lsRemote,
  roots,
  viewRemote,
} from "../discovery/api.js";
import {
  attachExplorerSession,
  getExplorerSessionStatus,
  listExplorerSessions,
  startExplorerSession,
  stopExplorerSession,
} from "../session/client.js";

import { writeOutput } from "./render.js";

interface TargetFlags {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly process?: string;
  readonly instance?: string;
  readonly timeout?: string;
  readonly maxFiles?: string;
  readonly maxBytes?: string;
  readonly maxMatches?: string;
  readonly json?: boolean;
  readonly followSymlinks?: boolean;
}

interface FindFlags extends TargetFlags {
  readonly root?: string;
  readonly name?: string;
}

interface LsFlags extends TargetFlags {
  readonly path?: string;
  readonly pattern?: string;
}

interface GrepFlags extends TargetFlags {
  readonly root?: string;
  readonly text?: string;
  readonly preview?: boolean;
  readonly includeFiles?: boolean;
}

interface ViewFlags extends TargetFlags {
  readonly file?: string;
  readonly line?: string;
  readonly context?: string;
}

interface InspectFlags extends TargetFlags {
  readonly root?: string;
  readonly text?: string;
  readonly name?: string;
  readonly includeFiles?: boolean;
}

interface SessionFlags extends TargetFlags {
  readonly sessionId?: string;
  readonly all?: boolean;
}

interface SessionStartFlags extends TargetFlags {
  readonly idleTimeout?: string;
  readonly maxLifetime?: string;
}

function requireFlag(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    throw new CfExplorerError("UNSAFE_INPUT", `${label} is required.`);
  }
  return trimmed;
}

function buildTarget(flags: TargetFlags): ExplorerTarget {
  return normalizeTarget({
    region: requireFlag(flags.region, "--region"),
    org: requireFlag(flags.org, "--org"),
    space: requireFlag(flags.space, "--space"),
    app: requireFlag(flags.app, "--app"),
  });
}

function currentCfContext(): CfExecContext | undefined {
  const command = process.env["CF_EXPLORER_CF_BIN"];
  return command === undefined ? undefined : { command };
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function needsCurrentTarget(flags: TargetFlags): boolean {
  return !hasText(flags.region) || !hasText(flags.org) || !hasText(flags.space);
}

function currentRegionKey(current: CurrentCfTarget): string {
  try {
    return requireCurrentCfRegionKey(current, "Pass --region explicitly.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CfExplorerError("UNKNOWN_REGION", message);
  }
}

async function resolveTargetFlags<T extends TargetFlags>(flags: T): Promise<T> {
  requireFlag(flags.app, "--app");
  if (!needsCurrentTarget(flags)) {
    return flags;
  }

  const current = await readCurrentCfTarget(currentCfContext()).catch((error: unknown) => {
    throw new CfExplorerError(
      "UNSAFE_INPUT",
      "No current CF target found. Run `cf target -o <org> -s <space>` or pass --region/--org/--space.",
      error instanceof Error ? error.message : String(error),
    );
  });
  if (current === undefined) {
    throw new CfExplorerError(
      "UNSAFE_INPUT",
      "No current CF target found. Run `cf target -o <org> -s <space>` or pass --region/--org/--space.",
    );
  }

  return {
    ...flags,
    region: hasText(flags.region) ? flags.region : currentRegionKey(current),
    org: hasText(flags.org) ? flags.org : current.orgName,
    space: hasText(flags.space) ? flags.space : current.spaceName,
  };
}

function buildRuntime(flags: TargetFlags): ExplorerRuntimeOptions {
  const timeoutSeconds = parsePositiveInteger(flags.timeout, "--timeout");
  const maxBytes = parsePositiveInteger(flags.maxBytes, "--max-bytes");
  return {
    ...(timeoutSeconds === undefined ? {} : { timeoutMs: secondsToTimerMs(timeoutSeconds, "--timeout") }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

function buildSelector(flags: TargetFlags): InstanceSelector {
  const instance = parseNonNegativeInteger(flags.instance, "--instance");
  return {
    ...(flags.process === undefined ? {} : { process: flags.process }),
    ...(instance === undefined ? {} : { instance }),
  };
}

function buildDiscovery(flags: TargetFlags): DiscoveryOptions {
  const maxFiles = parsePositiveInteger(flags.maxFiles, "--max-files");
  return {
    target: buildTarget(flags),
    runtime: buildRuntime(flags),
    ...buildSelector(flags),
    ...(maxFiles === undefined ? {} : { maxFiles }),
    ...(flags.followSymlinks === true ? { followSymlinks: true } : {}),
  };
}

function maxFilesField(flags: TargetFlags): { readonly maxFiles?: number } {
  const maxFiles = parsePositiveInteger(flags.maxFiles, "--max-files");
  return maxFiles === undefined ? {} : { maxFiles };
}

function maxMatchesField(flags: TargetFlags): { readonly maxMatches?: number } {
  const maxMatches = parsePositiveInteger(flags.maxMatches, "--max-matches");
  return maxMatches === undefined ? {} : { maxMatches };
}

function followSymlinksField(flags: TargetFlags): { readonly followSymlinks?: true } {
  return flags.followSymlinks === true ? { followSymlinks: true } : {};
}

function sessionLimitFields(flags: TargetFlags): {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
} {
  const timeoutSeconds = parsePositiveInteger(flags.timeout, "--timeout");
  const maxBytes = parsePositiveInteger(flags.maxBytes, "--max-bytes");
  return {
    ...(timeoutSeconds === undefined ? {} : { timeoutMs: secondsToTimerMs(timeoutSeconds, "--timeout") }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

function buildFind(flags: FindFlags): FindOptions {
  return {
    ...buildDiscovery(flags),
    root: requireFlag(flags.root, "--root"),
    name: requireFlag(flags.name, "--name"),
  };
}

function buildLs(flags: LsFlags): LsOptions {
  return {
    ...buildDiscovery(flags),
    path: requireFlag(flags.path, "--path"),
    ...(flags.pattern === undefined ? {} : { pattern: flags.pattern }),
  };
}

function buildGrep(flags: GrepFlags): GrepOptions {
  return {
    ...buildDiscovery(flags),
    root: requireFlag(flags.root, "--root"),
    text: requireFlag(flags.text, "--text"),
    ...(flags.preview === true ? { preview: true } : {}),
    ...(flags.includeFiles === true ? { includeFiles: true } : {}),
    ...maxMatchesField(flags),
  };
}

function buildView(flags: ViewFlags): ViewOptions {
  const context = parseNonNegativeInteger(flags.context, "--context");
  return {
    ...buildDiscovery(flags),
    file: requireFlag(flags.file, "--file"),
    line: parsePositiveInteger(requireFlag(flags.line, "--line"), "--line") ?? 1,
    ...(context === undefined ? {} : { context }),
  };
}

function buildInspect(flags: InspectFlags): InspectCandidatesOptions {
  return {
    ...buildDiscovery(flags),
    text: requireFlag(flags.text, "--text"),
    ...(flags.root === undefined ? {} : { root: flags.root }),
    ...(flags.name === undefined ? {} : { name: flags.name }),
    ...(flags.includeFiles === true ? { includeFiles: true } : {}),
    ...maxMatchesField(flags),
  };
}

function parseSecondsAsMilliseconds(value: string | undefined, label: string): number | undefined {
  const seconds = parsePositiveInteger(value, label);
  return seconds === undefined ? undefined : secondsToTimerMs(seconds, label);
}

function addTargetOptions(command: Command): Command {
  return command
    .option("--region <key>", "CF region key (default: current cf target)")
    .option("--org <name>", "CF org name (default: current cf target)")
    .option("--space <name>", "CF space name (default: current cf target)")
    .requiredOption("--app <name>", "CF app name")
    .option("--process <name>", "CF process name", "web")
    .option("--instance <index>", "CF app instance index");
}

function addSingleInstanceTargetOptions(command: Command): Command {
  return command
    .option("--region <key>", "CF region key (default: current cf target)")
    .option("--org <name>", "CF org name (default: current cf target)")
    .option("--space <name>", "CF space name (default: current cf target)")
    .requiredOption("--app <name>", "CF app name")
    .option("--process <name>", "CF process name", "web")
    .option("--instance <index>", "CF app instance index");
}

function addCommonOptions(command: Command): Command {
  return addOutputOptions(addTargetOptions(command)
    .option("--timeout <seconds>", "Timeout in seconds")
    .option("--max-files <count>", "Maximum remote paths to return")
    .option("--max-bytes <bytes>", "Maximum command output bytes")
    .option("--follow-symlinks", "Follow symlinked directories during remote find operations", false));
}

function addOutputOptions(command: Command): Command {
  return command
    .option("--json", "Emit structured JSON output (default)", true)
    .option("--no-json", "Emit human-readable output");
}

function addSessionReadOptions(command: Command): Command {
  return addOutputOptions(command)
    .option("--timeout <seconds>", "Per-request timeout in seconds")
    .option("--max-bytes <bytes>", "Maximum command output bytes")
    .option("--follow-symlinks", "Follow symlinked directories during remote find operations", false);
}

export async function runProgram(argv: readonly string[], version: string): Promise<void> {
  const program = new Command();
  program
    .name("cf-explorer")
    .description("Safe Cloud Foundry app file explorer")
    .version(version);
  addDiscoveryCommands(program);
  addSessionCommands(program);
  await program.parseAsync([...argv]);
}

function addDiscoveryCommands(program: Command): void {
  addCommonOptions(program.command("roots").description("Locate likely app roots"))
    .action(async (flags: TargetFlags): Promise<void> => {
      writeOutput(await roots(buildDiscovery(await resolveTargetFlags(flags))), flags.json);
    });
  addCommonOptions(program.command("instances").description("List app instances"))
    .action(async (flags: TargetFlags): Promise<void> => {
      writeOutput(await listInstances(buildDiscovery(await resolveTargetFlags(flags))), flags.json);
    });
  addCommonOptions(program.command("ls").description("List direct children under a remote path"))
    .requiredOption("--path <path>", "Remote directory path")
    .option("--pattern <pattern>", "Filter entries by shell name pattern")
    .action(async (flags: LsFlags): Promise<void> => {
      writeOutput(await lsRemote(buildLs(await resolveTargetFlags(flags))), flags.json);
    });
  addCommonOptions(program.command("find").description("Search filenames under a root"))
    .requiredOption("--root <path>", "Remote root")
    .requiredOption("--name <pattern>", "File name pattern")
    .action(async (flags: FindFlags): Promise<void> => {
      writeOutput(await findRemote(buildFind(await resolveTargetFlags(flags))), flags.json);
    });
  addCommonOptions(program.command("grep").description("Search file content under a root"))
    .requiredOption("--root <path>", "Remote root")
    .requiredOption("--text <text>", "Search text")
    .option("--preview", "Include bounded line preview", false)
    .option("--include-files", "Accepted for inspect-candidates parity; grep output remains content matches", false)
    .option("--max-matches <count>", "Maximum content matches to return")
    .action(async (flags: GrepFlags): Promise<void> => {
      writeOutput(await grepRemote(buildGrep(await resolveTargetFlags(flags))), flags.json);
    });
  addCommonOptions(program.command("view").description("Read bounded line context from a file"))
    .requiredOption("--file <path>", "Remote file")
    .requiredOption("--line <n>", "Line number")
    .option("--context <n>", "Context lines")
    .action(async (flags: ViewFlags): Promise<void> => {
      writeOutput(await viewRemote(buildView(await resolveTargetFlags(flags))), flags.json);
    });
  addCommonOptions(program.command("inspect-candidates").description("Find file and line candidates"))
    .requiredOption("--text <text>", "Search text")
    .option("--root <path>", "Remote root")
    .option("--name <pattern>", "File name pattern")
    .option("--include-files", "Include file candidate list in JSON output", false)
    .option("--max-matches <count>", "Maximum content matches to return")
    .action(async (flags: InspectFlags): Promise<void> => {
      writeOutput(await inspectCandidates(buildInspect(await resolveTargetFlags(flags))), flags.json);
    });
}

function addSessionCommands(program: Command): void {
  const session = program.command("session").description("Manage persistent explorer sessions");
  addSessionManagementCommands(session);
  addSessionDiscoveryCommands(session);
}

function addSessionManagementCommands(session: Command): void {
  addSessionStartCommand(session);
  addOutputOptions(session.command("list").description("List persistent sessions"))
    .action(async (flags: SessionFlags): Promise<void> => {
      writeOutput(await listExplorerSessions(), flags.json);
    });
  addOutputOptions(session.command("status").description("Inspect one persistent session"))
    .requiredOption("--session-id <id>", "Session id")
    .action(async (flags: SessionFlags): Promise<void> => {
      writeOutput(await getExplorerSessionStatus(requireFlag(flags.sessionId, "--session-id")), flags.json);
    });
  addOutputOptions(session.command("stop").description("Stop one or all persistent sessions"))
    .option("--session-id <id>", "Session id")
    .option("--all", "Stop all sessions", false)
    .action(async (flags: SessionFlags): Promise<void> => {
      writeOutput(await stopExplorerSession({
        ...(flags.sessionId === undefined ? {} : { sessionId: flags.sessionId }),
        ...(flags.all === undefined ? {} : { all: flags.all }),
      }), flags.json);
    });
}

function addSessionStartCommand(session: Command): void {
  addOutputOptions(addSingleInstanceTargetOptions(session.command("start").description("Start a persistent explorer session")))
    .option("--timeout <seconds>", "Startup timeout in seconds")
    .option("--idle-timeout <seconds>", "Idle timeout in seconds")
    .option("--max-lifetime <seconds>", "Maximum session lifetime in seconds")
    .action(async (flags: SessionStartFlags): Promise<void> => {
      const resolved = await resolveTargetFlags(flags);
      const idleTimeoutMs = parseSecondsAsMilliseconds(flags.idleTimeout, "--idle-timeout");
      const maxLifetimeMs = parseSecondsAsMilliseconds(flags.maxLifetime, "--max-lifetime");
      writeOutput(await startExplorerSession({
        target: buildTarget(resolved),
        runtime: buildRuntime(resolved),
        ...buildSelector(resolved),
        ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
        ...(maxLifetimeMs === undefined ? {} : { maxLifetimeMs }),
      }), flags.json);
    });
}

function addSessionDiscoveryCommands(session: Command): void {
  addSessionRootsCommand(session);
  addSessionLsCommand(session);
  addSessionFindCommand(session);
  addSessionGrepCommand(session);
  addSessionViewCommand(session);
  addSessionInspectCommand(session);
}

function addSessionRootsCommand(session: Command): void {
  addSessionReadOptions(session.command("roots").description("Locate roots through an existing session"))
    .requiredOption("--session-id <id>", "Session id")
    .option("--max-files <count>", "Maximum remote paths to return")
    .action(async (flags: SessionFlags): Promise<void> => {
      const attached = await attachExplorerSession(requireFlag(flags.sessionId, "--session-id"));
      writeOutput(await attached.roots({ ...maxFilesField(flags), ...sessionLimitFields(flags) }), flags.json);
    });
}

function addSessionLsCommand(session: Command): void {
  addSessionReadOptions(session.command("ls").description("List direct children through an existing session"))
    .requiredOption("--session-id <id>", "Session id")
    .requiredOption("--path <path>", "Remote directory path")
    .option("--pattern <pattern>", "Filter entries by shell name pattern")
    .option("--max-files <count>", "Maximum remote paths to return")
    .action(async (flags: SessionFlags & LsFlags): Promise<void> => {
      const attached = await attachExplorerSession(requireFlag(flags.sessionId, "--session-id"));
      writeOutput(await attached.ls({
        path: requireFlag(flags.path, "--path"),
        ...(flags.pattern === undefined ? {} : { pattern: flags.pattern }),
        ...followSymlinksField(flags),
        ...maxFilesField(flags),
        ...sessionLimitFields(flags),
      }), flags.json);
    });
}

function addSessionFindCommand(session: Command): void {
  addSessionReadOptions(session.command("find").description("Search filenames through an existing session"))
    .requiredOption("--session-id <id>", "Session id")
    .requiredOption("--root <path>", "Remote root")
    .requiredOption("--name <pattern>", "File name pattern")
    .option("--max-files <count>", "Maximum remote paths to return")
    .action(async (flags: SessionFlags & FindFlags): Promise<void> => {
      const attached = await attachExplorerSession(requireFlag(flags.sessionId, "--session-id"));
      writeOutput(await attached.find({
        root: requireFlag(flags.root, "--root"),
        name: requireFlag(flags.name, "--name"),
        ...followSymlinksField(flags),
        ...maxFilesField(flags),
        ...sessionLimitFields(flags),
      }), flags.json);
    });
}

function addSessionGrepCommand(session: Command): void {
  addSessionReadOptions(session.command("grep").description("Search through an existing session"))
    .requiredOption("--session-id <id>", "Session id")
    .requiredOption("--root <path>", "Remote root")
    .requiredOption("--text <text>", "Search text")
    .option("--preview", "Include bounded line preview", false)
    .option("--include-files", "Accepted for inspect-candidates parity; grep output remains content matches", false)
    .option("--max-matches <count>", "Maximum content matches to return")
    .option("--max-files <count>", "Maximum remote paths to return")
    .action(async (flags: SessionFlags & GrepFlags): Promise<void> => {
      const attached = await attachExplorerSession(requireFlag(flags.sessionId, "--session-id"));
      writeOutput(await attached.grep({
        root: requireFlag(flags.root, "--root"),
        text: requireFlag(flags.text, "--text"),
        ...(flags.preview === true ? { preview: true } : {}),
        ...(flags.includeFiles === true ? { includeFiles: true } : {}),
        ...maxMatchesField(flags),
        ...maxFilesField(flags),
        ...followSymlinksField(flags),
        ...sessionLimitFields(flags),
      }), flags.json);
    });
}

function addSessionViewCommand(session: Command): void {
  addSessionReadOptions(session.command("view").description("Read line context through an existing session"))
    .requiredOption("--session-id <id>", "Session id")
    .requiredOption("--file <path>", "Remote file")
    .requiredOption("--line <n>", "Line number")
    .option("--context <n>", "Context lines")
    .action(async (flags: SessionFlags & ViewFlags): Promise<void> => {
      const attached = await attachExplorerSession(requireFlag(flags.sessionId, "--session-id"));
      const context = parseNonNegativeInteger(flags.context, "--context");
      writeOutput(await attached.view({
        file: requireFlag(flags.file, "--file"),
        line: parsePositiveInteger(requireFlag(flags.line, "--line"), "--line") ?? 1,
        ...(context === undefined ? {} : { context }),
        ...sessionLimitFields(flags),
      }), flags.json);
    });
}

function addSessionInspectCommand(session: Command): void {
  addSessionReadOptions(session.command("inspect-candidates").description("Find candidates through an existing session"))
    .requiredOption("--session-id <id>", "Session id")
    .requiredOption("--text <text>", "Search text")
    .option("--root <path>", "Remote root")
    .option("--name <pattern>", "File name pattern")
    .option("--max-files <count>", "Maximum remote paths to return when --include-files is used")
    .option("--include-files", "Include file candidate list in JSON output", false)
    .option("--max-matches <count>", "Maximum content matches to return")
    .action(async (flags: SessionFlags & InspectFlags): Promise<void> => {
      const attached = await attachExplorerSession(requireFlag(flags.sessionId, "--session-id"));
      writeOutput(await attached.inspectCandidates({
        text: requireFlag(flags.text, "--text"),
        ...(flags.root === undefined ? {} : { root: flags.root }),
        ...(flags.name === undefined ? {} : { name: flags.name }),
        ...(flags.includeFiles === true ? { includeFiles: true } : {}),
        ...maxMatchesField(flags),
        ...maxFilesField(flags),
        ...followSymlinksField(flags),
        ...sessionLimitFields(flags),
      }), flags.json);
    });
}
