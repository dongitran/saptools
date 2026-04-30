import process from "node:process";

import { Command } from "commander";

import {
  findRemote,
  grepRemote,
  inspectCandidates,
  listInstances,
  roots,
  viewRemote,
} from "./api.js";
import { CfExplorerError } from "./errors.js";
import { enableSsh, prepareSsh, restartApp, sshStatus } from "./lifecycle.js";
import {
  attachExplorerSession,
  getExplorerSessionStatus,
  listExplorerSessions,
  startExplorerSession,
  stopExplorerSession,
} from "./session.js";
import { normalizeTarget, parseNonNegativeInteger, parsePositiveInteger } from "./target.js";
import type {
  DiscoveryOptions,
  ExplorerRuntimeOptions,
  ExplorerTarget,
  FindOptions,
  GrepOptions,
  InspectCandidatesOptions,
  InstanceSelector,
  LifecycleOptions,
  ViewOptions,
} from "./types.js";

interface TargetFlags {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly process?: string;
  readonly instance?: string;
  readonly allInstances?: boolean;
  readonly timeout?: string;
  readonly maxFiles?: string;
  readonly maxBytes?: string;
  readonly json?: boolean;
}

interface FindFlags extends TargetFlags {
  readonly root?: string;
  readonly name?: string;
}

interface GrepFlags extends TargetFlags {
  readonly root?: string;
  readonly text?: string;
  readonly preview?: boolean;
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
}

interface LifecycleFlags extends TargetFlags {
  readonly yes?: boolean;
}

interface SessionFlags extends TargetFlags {
  readonly sessionId?: string;
  readonly all?: boolean;
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

function buildRuntime(flags: TargetFlags): ExplorerRuntimeOptions {
  const timeoutSeconds = parsePositiveInteger(flags.timeout, "--timeout");
  const maxBytes = parsePositiveInteger(flags.maxBytes, "--max-bytes");
  return {
    ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1000 }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

function buildSelector(flags: TargetFlags): InstanceSelector {
  const instance = parseNonNegativeInteger(flags.instance, "--instance");
  return {
    ...(flags.process === undefined ? {} : { process: flags.process }),
    ...(instance === undefined ? {} : { instance }),
    ...(flags.allInstances === true ? { allInstances: true } : {}),
  };
}

function buildDiscovery(flags: TargetFlags): DiscoveryOptions {
  const maxFiles = parsePositiveInteger(flags.maxFiles, "--max-files");
  return {
    target: buildTarget(flags),
    runtime: buildRuntime(flags),
    ...buildSelector(flags),
    ...(maxFiles === undefined ? {} : { maxFiles }),
  };
}

function maxFilesField(flags: TargetFlags): { readonly maxFiles?: number } {
  const maxFiles = parsePositiveInteger(flags.maxFiles, "--max-files");
  return maxFiles === undefined ? {} : { maxFiles };
}

function buildFind(flags: FindFlags): FindOptions {
  return {
    ...buildDiscovery(flags),
    root: requireFlag(flags.root, "--root"),
    name: requireFlag(flags.name, "--name"),
  };
}

function buildGrep(flags: GrepFlags): GrepOptions {
  return {
    ...buildDiscovery(flags),
    root: requireFlag(flags.root, "--root"),
    text: requireFlag(flags.text, "--text"),
    ...(flags.preview === true ? { preview: true } : {}),
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
  };
}

function buildLifecycle(flags: LifecycleFlags): LifecycleOptions {
  return {
    target: buildTarget(flags),
    runtime: buildRuntime(flags),
    ...buildSelector(flags),
    ...(flags.yes === true ? { confirmImpact: true } : {}),
  };
}

function writeOutput(value: unknown, json = true): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  writeHuman(value);
}

function writeHuman(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    process.stdout.write(`${String(value)}\n`);
    return;
  }
  const text = renderHuman(value as Record<string, unknown>);
  if (text === undefined) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function renderHuman(value: Record<string, unknown>): string | undefined {
  if (Array.isArray(value["lines"]) && typeof value["file"] === "string") {
    return renderViewResult(value);
  }
  if (Array.isArray(value["roots"]) && Array.isArray(value["suggestedBreakpoints"])) {
    return renderInspectResult(value);
  }
  if (Array.isArray(value["roots"])) {
    return renderRootsResult(value);
  }
  if (Array.isArray(value["instances"]) && (value["instances"] as unknown[]).every(isInstanceInfoLike)) {
    return renderInstancesResult(value);
  }
  if (Array.isArray(value["matches"])) {
    return renderMatchesResult(value);
  }
  if (Array.isArray(value["sessions"])) {
    return renderSessionList(value);
  }
  if (typeof value["sessionId"] === "string" && typeof value["status"] === "string" && "brokerAlive" in value) {
    return renderSessionStatus(value);
  }
  if (typeof value["status"] === "string" && typeof value["message"] === "string" && "changed" in value) {
    return renderLifecycleResult(value);
  }
  if (typeof value["sessionId"] === "string" && typeof value["status"] === "string") {
    return renderSessionRecord(value);
  }
  return undefined;
}

function isInstanceInfoLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate["index"] === "number" && typeof candidate["state"] === "string";
}

function renderRootsResult(value: Record<string, unknown>): string {
  const roots = value["roots"] as readonly string[];
  if (roots.length === 0) {
    return "No roots discovered.";
  }
  return roots.join("\n");
}

function renderInstancesResult(value: Record<string, unknown>): string {
  const instances = value["instances"] as readonly { index: number; state: string; since?: string }[];
  if (instances.length === 0) {
    return "No instances reported.";
  }
  return instances
    .map((item) => `#${item.index.toString()}\t${item.state}${item.since === undefined ? "" : `\t${item.since}`}`)
    .join("\n");
}

function renderMatchesResult(value: Record<string, unknown>): string {
  const matches = value["matches"] as readonly Record<string, unknown>[];
  if (matches.length === 0) {
    return "No matches.";
  }
  return matches
    .map((match) => {
      const path = typeof match["path"] === "string" ? match["path"] : "";
      const line = match["line"];
      const kind = match["kind"];
      const preview = match["preview"];
      const tag = typeof kind === "string" ? `[${kind}]` : typeof line === "number" ? `:${line.toString()}` : "";
      const previewText = typeof preview === "string" && preview.length > 0 ? `\t${preview}` : "";
      const instance = match["instance"];
      const instancePrefix = typeof instance === "number" ? `#${instance.toString()}\t` : "";
      return `${instancePrefix}${path}${tag}${previewText}`;
    })
    .join("\n");
}

function renderViewResult(value: Record<string, unknown>): string {
  const file = String(value["file"]);
  const lines = value["lines"] as readonly { line: number; text: string }[];
  const header = `# ${file}`;
  const body = lines.map((line) => `${line.line.toString().padStart(5, " ")}  ${line.text}`);
  return [header, ...body].join("\n");
}

function renderInspectResult(value: Record<string, unknown>): string {
  const sections: string[] = [];
  const roots = value["roots"] as readonly string[];
  if (roots.length > 0) {
    sections.push(`Roots:\n${roots.map((root) => `  ${root}`).join("\n")}`);
  }
  const matches = value["contentMatches"] as readonly { path: string; line: number }[];
  if (matches.length > 0) {
    sections.push(`Matches:\n${matches.map((match) => `  ${match.path}:${match.line.toString()}`).join("\n")}`);
  }
  const breakpoints = value["suggestedBreakpoints"] as readonly { bp: string; line: number; confidence: string }[];
  if (breakpoints.length > 0) {
    sections.push(`Suggested breakpoints:\n${breakpoints.map((bp) => `  [${bp.confidence}] ${bp.bp}:${bp.line.toString()}`).join("\n")}`);
  }
  return sections.length === 0 ? "No candidates discovered." : sections.join("\n\n");
}

function renderLifecycleResult(value: Record<string, unknown>): string {
  return `${String(value["status"])}: ${String(value["message"])}`;
}

function renderSessionList(value: Record<string, unknown>): string {
  const sessions = value["sessions"] as readonly Record<string, unknown>[];
  if (sessions.length === 0) {
    return "No persistent sessions.";
  }
  return sessions
    .map((session) => {
      const target = session["target"] as { app?: string } | undefined;
      const appName = typeof target?.app === "string" ? target.app : "?";
      return `${String(session["sessionId"])}\t${String(session["status"])}\t${appName}`;
    })
    .join("\n");
}

function renderSessionStatus(value: Record<string, unknown>): string {
  return [
    `sessionId: ${String(value["sessionId"])}`,
    `status: ${String(value["status"])}`,
    `brokerAlive: ${String(value["brokerAlive"])}`,
    `sshAlive: ${String(value["sshAlive"])}`,
    `socketAlive: ${String(value["socketAlive"])}`,
  ].join("\n");
}

function renderSessionRecord(value: Record<string, unknown>): string {
  return [
    `sessionId: ${String(value["sessionId"])}`,
    `status: ${String(value["status"])}`,
    `brokerPid: ${String(value["brokerPid"])}`,
    `socketPath: ${String(value["socketPath"])}`,
  ].join("\n");
}

function addTargetOptions(command: Command): Command {
  return command
    .requiredOption("--region <key>", "CF region key")
    .requiredOption("--org <name>", "CF org name")
    .requiredOption("--space <name>", "CF space name")
    .requiredOption("--app <name>", "CF app name")
    .option("--process <name>", "CF process name", "web")
    .option("--instance <index>", "CF app instance index")
    .option("--all-instances", "Run supported command on all running instances", false);
}

function addSingleInstanceTargetOptions(command: Command): Command {
  return command
    .requiredOption("--region <key>", "CF region key")
    .requiredOption("--org <name>", "CF org name")
    .requiredOption("--space <name>", "CF space name")
    .requiredOption("--app <name>", "CF app name")
    .option("--process <name>", "CF process name", "web")
    .option("--instance <index>", "CF app instance index");
}

function addCommonOptions(command: Command): Command {
  return addTargetOptions(command)
    .option("--timeout <seconds>", "Timeout in seconds")
    .option("--max-files <count>", "Maximum remote paths to return")
    .option("--max-bytes <bytes>", "Maximum command output bytes")
    .option("--no-json", "Emit human-readable output");
}

function addLifecycleOptions(command: Command): Command {
  return addTargetOptions(command)
    .option("--timeout <seconds>", "Timeout in seconds")
    .option("--yes", "Confirm the lifecycle impact", false)
    .option("--no-json", "Emit human-readable output");
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();
  program.name("cf-explorer").description("Safe Cloud Foundry app file explorer");
  addDiscoveryCommands(program);
  addLifecycleCommands(program);
  addSessionCommands(program);
  await program.parseAsync([...argv]);
}

function addDiscoveryCommands(program: Command): void {
  addCommonOptions(program.command("roots").description("Locate likely app roots"))
    .action(async (flags: TargetFlags): Promise<void> => {
      writeOutput(await roots(buildDiscovery(flags)), flags.json);
    });
  addCommonOptions(program.command("instances").description("List app instances"))
    .action(async (flags: TargetFlags): Promise<void> => {
      writeOutput(await listInstances(buildDiscovery(flags)), flags.json);
    });
  addCommonOptions(program.command("find").description("Search filenames under a root"))
    .requiredOption("--root <path>", "Remote root")
    .requiredOption("--name <pattern>", "File name pattern")
    .action(async (flags: FindFlags): Promise<void> => {
      writeOutput(await findRemote(buildFind(flags)), flags.json);
    });
  addCommonOptions(program.command("grep").description("Search file content under a root"))
    .requiredOption("--root <path>", "Remote root")
    .requiredOption("--text <text>", "Search text")
    .option("--preview", "Include bounded line preview", false)
    .action(async (flags: GrepFlags): Promise<void> => {
      writeOutput(await grepRemote(buildGrep(flags)), flags.json);
    });
  addCommonOptions(program.command("view").description("Read bounded line context from a file"))
    .requiredOption("--file <path>", "Remote file")
    .requiredOption("--line <n>", "Line number")
    .option("--context <n>", "Context lines")
    .action(async (flags: ViewFlags): Promise<void> => {
      writeOutput(await viewRemote(buildView(flags)), flags.json);
    });
  addCommonOptions(program.command("inspect-candidates").description("Find file and line candidates"))
    .requiredOption("--text <text>", "Search text")
    .option("--root <path>", "Remote root")
    .option("--name <pattern>", "File name pattern")
    .action(async (flags: InspectFlags): Promise<void> => {
      writeOutput(await inspectCandidates(buildInspect(flags)), flags.json);
    });
}

function addLifecycleCommands(program: Command): void {
  addLifecycleOptions(program.command("ssh-status").description("Check SSH status"))
    .action(async (flags: LifecycleFlags): Promise<void> => {
      writeOutput(await sshStatus(buildLifecycle(flags)), flags.json);
    });
  addLifecycleOptions(program.command("enable-ssh").description("Enable SSH for the app"))
    .action(async (flags: LifecycleFlags): Promise<void> => {
      writeOutput(await enableSsh(buildLifecycle(flags)), flags.json);
    });
  addLifecycleOptions(program.command("restart").description("Restart the app"))
    .action(async (flags: LifecycleFlags): Promise<void> => {
      writeOutput(await restartApp(buildLifecycle(flags)), flags.json);
    });
  addLifecycleOptions(program.command("prepare-ssh").description("Enable SSH and restart when needed"))
    .action(async (flags: LifecycleFlags): Promise<void> => {
      writeOutput(await prepareSsh(buildLifecycle(flags)), flags.json);
    });
}

function addSessionCommands(program: Command): void {
  const session = program.command("session").description("Manage persistent explorer sessions");
  addSingleInstanceTargetOptions(session.command("start").description("Start a persistent explorer session"))
    .option("--timeout <seconds>", "Startup timeout in seconds")
    .action(async (flags: TargetFlags): Promise<void> => {
      writeOutput(await startExplorerSession({
        target: buildTarget(flags),
        runtime: buildRuntime(flags),
        ...buildSelector(flags),
      }));
    });
  session.command("list").description("List persistent sessions")
    .action(async (): Promise<void> => {
      writeOutput(await listExplorerSessions());
    });
  session.command("status").description("Inspect one persistent session")
    .requiredOption("--session-id <id>", "Session id")
    .action(async (flags: SessionFlags): Promise<void> => {
      writeOutput(await getExplorerSessionStatus(requireFlag(flags.sessionId, "--session-id")));
    });
  session.command("stop").description("Stop one or all persistent sessions")
    .option("--session-id <id>", "Session id")
    .option("--all", "Stop all sessions", false)
    .action(async (flags: SessionFlags): Promise<void> => {
      writeOutput(await stopExplorerSession({
        ...(flags.sessionId === undefined ? {} : { sessionId: flags.sessionId }),
        ...(flags.all === undefined ? {} : { all: flags.all }),
      }));
    });
  session.command("roots").description("Locate roots through an existing session")
    .requiredOption("--session-id <id>", "Session id")
    .option("--max-files <count>", "Maximum remote paths to return")
    .action(async (flags: SessionFlags): Promise<void> => {
      const attached = await attachExplorerSession(requireFlag(flags.sessionId, "--session-id"));
      writeOutput(await attached.roots(maxFilesField(flags)));
    });
  session.command("find").description("Search filenames through an existing session")
    .requiredOption("--session-id <id>", "Session id")
    .requiredOption("--root <path>", "Remote root")
    .requiredOption("--name <pattern>", "File name pattern")
    .option("--max-files <count>", "Maximum remote paths to return")
    .action(async (flags: SessionFlags & FindFlags): Promise<void> => {
      const attached = await attachExplorerSession(requireFlag(flags.sessionId, "--session-id"));
      writeOutput(await attached.find({
        root: requireFlag(flags.root, "--root"),
        name: requireFlag(flags.name, "--name"),
        ...maxFilesField(flags),
      }));
    });
  session.command("grep").description("Search through an existing session")
    .requiredOption("--session-id <id>", "Session id")
    .requiredOption("--root <path>", "Remote root")
    .requiredOption("--text <text>", "Search text")
    .option("--preview", "Include bounded line preview", false)
    .option("--max-files <count>", "Maximum remote paths to return")
    .action(async (flags: SessionFlags & GrepFlags): Promise<void> => {
      const attached = await attachExplorerSession(requireFlag(flags.sessionId, "--session-id"));
      writeOutput(await attached.grep({
        root: requireFlag(flags.root, "--root"),
        text: requireFlag(flags.text, "--text"),
        ...(flags.preview === true ? { preview: true } : {}),
        ...maxFilesField(flags),
      }));
    });
  session.command("view").description("Read line context through an existing session")
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
      }));
    });
  session.command("inspect-candidates").description("Find candidates through an existing session")
    .requiredOption("--session-id <id>", "Session id")
    .requiredOption("--text <text>", "Search text")
    .option("--root <path>", "Remote root")
    .option("--name <pattern>", "File name pattern")
    .option("--max-files <count>", "Maximum remote paths to return")
    .action(async (flags: SessionFlags & InspectFlags): Promise<void> => {
      const attached = await attachExplorerSession(requireFlag(flags.sessionId, "--session-id"));
      writeOutput(await attached.inspectCandidates({
        text: requireFlag(flags.text, "--text"),
        ...(flags.root === undefined ? {} : { root: flags.root }),
        ...(flags.name === undefined ? {} : { name: flags.name }),
        ...maxFilesField(flags),
      }));
    });
}

try {
  await main(process.argv);
} catch (error: unknown) {
  if (error instanceof CfExplorerError) {
    process.stderr.write(`Error [${error.code}]: ${error.message}\n`);
  } else {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
}
