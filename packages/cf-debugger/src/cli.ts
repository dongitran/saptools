#!/usr/bin/env node

import nodeProcess from "node:process";

import { attachSelfUpdate, registerSelfUpdateCommand } from "@saptools/core";
import { Command } from "commander";

import { readCurrentCfTarget, requireCurrentCfRegion } from "./cf.js";
import type { CurrentCfTargetReadOptions } from "./cf.js";
import {
  CLEANUP_FAILURE_EXIT_CODE,
  cliErrorExitCode,
  hasTunnelTerminationFailure,
  stopAllExitCode,
} from "./cli-errors.js";
import {
  parseOptionalInteger,
  parseSeconds,
  readRequiredOption,
} from "./cli-input.js";
import {
  DEFAULT_NODE_INSPECTOR_PORT,
  resolveNodeTarget,
} from "./cloud-foundry/node-process.js";
import { runDoctor } from "./debug-session/doctor.js";
import { getDebuggerHandleTunnelError } from "./debug-session/lifecycle.js";
import { startDebuggerWithinDeadline } from "./debug-session/start.js";
import {
  createStartupDeadline,
  remainingStartupMs,
  resolveStartupTimeoutMs,
  startupTimeoutError,
} from "./debug-session/startup-deadline.js";
import {
  getSession,
  listSessions,
  stopAllDebuggers,
  stopDebugger,
} from "./debugger.js";
import { readPackageVersion } from "./package-version.js";
import { validateApiEndpointOverride } from "./regions.js";
import { parseRestartEnvironment } from "./restart-policy.js";
import type {
  DebuggerHandle,
  ResolvedSessionKey,
  SessionStatus,
  StartDebuggerOptions,
} from "./types.js";
import { CfDebuggerError } from "./types.js";

interface TargetCommandOptions {
  readonly process?: string;
  readonly instance?: string;
  readonly nodePid?: string;
  readonly apiEndpoint?: string;
}

interface StartCommandOptions extends TargetCommandOptions {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly port?: string;
  readonly remotePort?: string;
  readonly timeout?: string;
  readonly startupTimeout?: string;
  readonly allowSshEnableRestart?: boolean;
  readonly sshEnableRestart?: boolean;
  readonly verbose?: boolean;
}

interface StopCommandOptions extends TargetCommandOptions {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly sessionId?: string;
  readonly all?: boolean;
  readonly force?: boolean;
}

type StatusCommandOptions = Omit<StopCommandOptions, "all" | "force">;
const STOP_SCOPE_OPTION_NAMES = [
  "apiEndpoint",
  "app",
  "instance",
  "nodePid",
  "org",
  "process",
  "region",
  "sessionId",
  "space",
] as const;

function logStatus(verbose: boolean, status: SessionStatus, message?: string): void {
  if (!verbose) {
    return;
  }
  const suffix = message === undefined ? "" : `: ${message}`;
  nodeProcess.stdout.write(`[cf-debugger] ${status}${suffix}\n`);
}

function mergeSelector<
  T extends { region?: string; org?: string; space?: string; app?: string },
>(selector: string | undefined, options: T): T {
  if (selector === undefined) {
    return options;
  }
  const parts = selector.split("/");
  if (parts.length === 1 && parts[0]?.length !== 0) {
    return { ...options, app: options.app ?? parts[0] };
  }
  if (parts.length === 4 && parts.every((part) => part.length > 0)) {
    return {
      ...options,
      region: options.region ?? parts[0],
      org: options.org ?? parts[1],
      space: options.space ?? parts[2],
      app: options.app ?? parts[3],
    };
  }
  throw new CfDebuggerError(
    "UNSAFE_INPUT",
    "Invalid app selector. Expected <app> or non-empty <region>/<org>/<space>/<app> segments.",
  );
}

interface StartupAbort {
  readonly signal: AbortSignal;
  requestedExitCode(): number | undefined;
  dispose(): void;
}

function startupAbort(app: string): StartupAbort {
  const controller = new AbortController();
  let requestedExitCode: number | undefined;
  const handler = (exitCode: number) => (): void => {
    requestedExitCode ??= exitCode;
    controller.abort();
    nodeProcess.stderr.write(`\nAborting startup for ${app}...\n`);
  };
  const onSigint = handler(130);
  const onSigterm = handler(143);
  nodeProcess.on("SIGINT", onSigint);
  nodeProcess.on("SIGTERM", onSigterm);
  return {
    signal: controller.signal,
    requestedExitCode: (): number | undefined => requestedExitCode,
    dispose: (): void => {
      nodeProcess.off("SIGINT", onSigint);
      nodeProcess.off("SIGTERM", onSigterm);
    },
  };
}

function writeReady(
  app: string,
  key: ResolvedSessionKey,
  handle: DebuggerHandle,
): void {
  nodeProcess.stdout.write(
    `Debugger ready for ${app} (${key.region}/${key.org}/${key.space}).\n` +
      `  Process:     ${key.process}\n` +
      `  Instance:    ${key.instance.toString()}\n` +
      `  Local port:  ${handle.session.localPort.toString()}\n` +
      `  Remote port: ${handle.session.remotePort.toString()}\n` +
      `  Session id:  ${handle.session.sessionId}\n` +
      `  Tunnel PID:  ${handle.session.pid.toString()}\n` +
      `  Node PID:    ${handle.session.remoteNodePid?.toString() ?? "unknown"}\n` +
      "Press Ctrl+C to stop.\n",
  );
}

function writeCleanupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  nodeProcess.stderr.write(`Error during stop: ${message}\n`);
}

async function waitForHandle(
  app: string,
  handle: DebuggerHandle,
): Promise<void> {
  let pendingDispose: Promise<void> | undefined;
  let requestedExitCode: number | undefined;
  const dispose = (): Promise<void> => {
    pendingDispose ??= (async (): Promise<void> => {
      nodeProcess.stdout.write(`\nStopping debugger for ${app}...\n`);
      await handle.dispose();
    })();
    return pendingDispose;
  };
  const stop = (exitCode: number) => (): void => {
    requestedExitCode = exitCode;
    void dispose()
      .catch((error: unknown) => {
        writeCleanupError(error);
        nodeProcess.exit(CLEANUP_FAILURE_EXIT_CODE);
      });
  };
  nodeProcess.on("SIGINT", stop(130));
  nodeProcess.on("SIGTERM", stop(143));
  const code = await handle.waitForExit();
  const tunnelError = getDebuggerHandleTunnelError(handle);
  if (tunnelError !== undefined) {
    nodeProcess.stderr.write(
      `Error [${tunnelError.code}]: ${tunnelError.message}\n`,
    );
    if (tunnelError.stderr !== undefined && tunnelError.stderr.trim().length > 0) {
      nodeProcess.stderr.write(`[cf-debugger transport]\n${tunnelError.stderr.trim()}\n`);
    }
  }
  try {
    await dispose();
  } catch (error: unknown) {
    writeCleanupError(error);
    nodeProcess.exit(CLEANUP_FAILURE_EXIT_CODE);
  }
  nodeProcess.exit(requestedExitCode ?? code ?? 0);
}

function buildStartOptions(
  options: StartCommandOptions,
  key: ResolvedSessionKey,
  app: string,
  signal: AbortSignal,
  startupTimeoutMs: number,
): StartDebuggerOptions {
  const preferredPort = parseOptionalInteger(options.port, "port", 1, 65_535);
  const remotePort = parseOptionalInteger(options.remotePort, "remotePort", 1, 65_535);
  const nodePid = parseOptionalInteger(options.nodePid, "nodePid", 1);
  const tunnelReadyTimeoutMs = parseSeconds(options.timeout, "timeout");
  const restartEnvironment = parseRestartEnvironment(
    nodeProcess.env["CF_DEBUGGER_ALLOW_RESTART"],
  );
  const allowSshEnableRestart =
    options.sshEnableRestart !== false &&
    restartEnvironment !== "forbid" &&
    (options.allowSshEnableRestart === true || restartEnvironment === "allow");
  return {
    region: key.region,
    org: key.org,
    space: key.space,
    app,
    process: key.process,
    instance: key.instance,
    signal,
    allowSshEnableRestart,
    ...(options.apiEndpoint === undefined ? {} : { apiEndpoint: options.apiEndpoint }),
    ...(preferredPort === undefined ? {} : { preferredPort }),
    ...(remotePort === undefined ? {} : { remotePort }),
    ...(nodePid === undefined ? {} : { nodePid }),
    ...(tunnelReadyTimeoutMs === undefined ? {} : { tunnelReadyTimeoutMs }),
    startupTimeoutMs,
  };
}

function deadlineTimedOut(
  deadline: ReturnType<typeof createStartupDeadline>,
): boolean {
  return remainingStartupMs(deadline.expiresAt) === 0 ||
    (
      deadline.signal.reason instanceof CfDebuggerError &&
      deadline.signal.reason.code === "STARTUP_TIMEOUT"
    );
}

function validateStartEndpoint(options: StartCommandOptions): StartCommandOptions {
  return options.apiEndpoint === undefined
    ? options
    : {
        ...options,
        apiEndpoint: validateApiEndpointOverride(options.apiEndpoint),
      };
}

async function handleStart(
  selector: string | undefined,
  rawOptions: StartCommandOptions,
): Promise<void> {
  const options = validateStartEndpoint(mergeSelector(selector, rawOptions));
  const app = readRequiredOption(options.app, "--app or selector");
  const verbose = options.verbose ?? false;
  const startupTimeoutMs = resolveStartupTimeoutMs(
    parseSeconds(options.startupTimeout, "startupTimeout"),
  );
  const abort = startupAbort(app);
  const deadline = createStartupDeadline(startupTimeoutMs, abort.signal);
  let handle;
  let phase = "current CF target discovery";
  let key: ResolvedSessionKey;
  try {
    key = await resolveSessionKey({ ...options, app }, deadline.signal);
    if (deadlineTimedOut(deadline)) {
      throw startupTimeoutError(startupTimeoutMs, phase);
    }
    phase = "startup";
    handle = await startDebuggerWithinDeadline({
      ...buildStartOptions(options, key, app, deadline.signal, startupTimeoutMs),
      verbose,
      onStatus: (status, message): void => {
        logStatus(verbose, status, message);
      },
    }, deadline);
  } catch (error: unknown) {
    const normalized = deadlineTimedOut(deadline) &&
      !(error instanceof CfDebuggerError && error.code === "STARTUP_TIMEOUT")
      ? startupTimeoutError(startupTimeoutMs, phase)
      : error;
    const exitCode = abort.requestedExitCode();
    if (exitCode !== undefined && typeof normalized === "object" && normalized !== null) {
      Reflect.set(normalized, "cliExitCode", exitCode);
    }
    throw normalized;
  } finally {
    deadline.dispose();
    abort.dispose();
  }
  writeReady(app, key, handle);
  await waitForHandle(app, handle);
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function currentCfOptions(signal?: AbortSignal): CurrentCfTargetReadOptions | undefined {
  const command = nodeProcess.env["CF_DEBUGGER_CF_BIN"];
  if (command === undefined && signal === undefined) {
    return undefined;
  }
  return {
    ...(command === undefined ? {} : { command }),
    ...(signal === undefined ? {} : { signal }),
  };
}

interface ResolvedCfScope {
  readonly region: string;
  readonly org: string;
  readonly space: string;
}

function currentTargetReadError(error: unknown): CfDebuggerError {
  return new CfDebuggerError(
    "CF_TARGET_FAILED",
    "No current CF target. Run `cf target -o <org> -s <space>` or pass --region/--org/--space.",
    error instanceof Error ? error.message : String(error),
  );
}

function missingCurrentTargetError(): CfDebuggerError {
  return new CfDebuggerError(
    "CF_TARGET_FAILED",
    "No current CF target. Run `cf target -o <org> -s <space>` or pass --region/--org/--space.",
  );
}

async function resolveCfScope(
  region: string | undefined,
  org: string | undefined,
  space: string | undefined,
  signal?: AbortSignal,
): Promise<ResolvedCfScope> {
  if (region !== undefined && org !== undefined && space !== undefined) {
    return { region, org, space };
  }
  const current = await readCurrentCfTarget(currentCfOptions(signal)).catch((error: unknown) => {
    if (
      error instanceof CfDebuggerError &&
      (error.code === "ABORTED" || error.code === "STARTUP_TIMEOUT")
    ) {
      throw error;
    }
    throw currentTargetReadError(error);
  });
  if (current === undefined) {
    throw missingCurrentTargetError();
  }
  return {
    region: region ?? requireCurrentCfRegion(current),
    org: org ?? current.org,
    space: space ?? current.space,
  };
}

async function resolveSessionKey(
  options: StopCommandOptions,
  signal?: AbortSignal,
): Promise<ResolvedSessionKey> {
  const app = readRequiredOption(options.app, "--app or selector");
  const region = optionalText(options.region);
  const org = optionalText(options.org);
  const space = optionalText(options.space);
  const nodePid = parseOptionalInteger(options.nodePid, "nodePid", 1);
  const instance = parseOptionalInteger(options.instance, "instance", 0);
  const target = resolveNodeTarget({
    ...(options.process === undefined ? {} : { process: options.process }),
    ...(instance === undefined ? {} : { instance }),
    ...(nodePid === undefined ? {} : { nodePid }),
  });
  const scope = await resolveCfScope(region, org, space, signal);
  return {
    ...scope,
    app,
    process: target.process,
    instance: target.instance,
    ...(options.apiEndpoint === undefined ? {} : { apiEndpoint: options.apiEndpoint }),
    ...(target.nodePid === undefined ? {} : { nodePid: target.nodePid }),
  };
}

async function resolveOptionalSessionKey(
  options: StopCommandOptions,
): Promise<ResolvedSessionKey | undefined> {
  if (optionalText(options.app) === undefined) {
    if (
      optionalText(options.region) !== undefined ||
      optionalText(options.org) !== undefined ||
      optionalText(options.space) !== undefined
    ) {
      readRequiredOption(options.app, "--app or selector");
    }
    return undefined;
  }
  return await resolveSessionKey(options);
}

function writeStopResult(result: Awaited<ReturnType<typeof stopDebugger>>): void {
  if (result === undefined) {
    return;
  }
  if (result.warning !== undefined) {
    nodeProcess.stderr.write(`[cf-debugger] warning: ${result.warning}\n`);
  }
  if (result.pending) {
    nodeProcess.stdout.write(
      `Stop requested for session ${result.sessionId} (${result.app}, phase ${result.status}).\n`,
    );
  } else if (result.stale) {
    nodeProcess.stdout.write(
      `Removed ${result.forced ? "forced " : ""}stale session ${result.sessionId} ` +
        `(${result.app}, port ${result.localPort.toString()}).\n`,
    );
  } else {
    nodeProcess.stdout.write(
      `Stopped session ${result.sessionId} (${result.app}, port ${result.localPort.toString()}).\n`,
    );
  }
}

function rejectScopedStopAll(
  selector: string | undefined,
  options: StopCommandOptions,
  command: Command,
): void {
  if (
    options.all === true &&
    (
      selector !== undefined ||
      STOP_SCOPE_OPTION_NAMES.some((name) => command.getOptionValueSource(name) === "cli")
    )
  ) {
    throw new CfDebuggerError(
      "UNSAFE_INPUT",
      "--all cannot be combined with a selector, --session-id, or target selector options.",
    );
  }
}

async function handleStopAll(force: boolean): Promise<void> {
  const summary = await stopAllDebuggers(force);
  for (const outcome of summary.outcomes) {
    if (outcome.error === undefined) {
      writeStopResult(outcome.result);
    } else {
      nodeProcess.stderr.write(
        `Failed ${outcome.sessionId} (${outcome.app}): ${outcome.error.message}\n`,
      );
    }
  }
  nodeProcess.stdout.write(
    `Stop summary: ${summary.stopped.toString()} stopped, ${summary.forced.toString()} forced, ` +
      `${summary.stale.toString()} stale, ` +
      `${summary.pending.toString()} pending, ${summary.failed.toString()} failed.\n`,
  );
  const exitCode = stopAllExitCode(
    summary.outcomes.flatMap((outcome) =>
      outcome.error === undefined ? [] : [outcome.error]),
  );
  if (exitCode !== undefined) {
    nodeProcess.exitCode = exitCode;
  }
}

async function handleStop(
  selector: string | undefined,
  rawOptions: StopCommandOptions,
  command: Command,
): Promise<void> {
  rejectScopedStopAll(selector, rawOptions, command);
  const options = mergeSelector(selector, rawOptions);
  if (options.all === true) {
    await handleStopAll(options.force === true);
    return;
  }
  const key = await resolveOptionalSessionKey(options);
  const result = await stopDebugger({
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(key === undefined ? {} : { key }),
    force: options.force === true,
  });
  if (result === undefined) {
    throw new CfDebuggerError(
      "SESSION_NOT_FOUND",
      "No matching session. Use `cf-debugger list` and pass --session-id or an exact key.",
    );
  }
  writeStopResult(result);
}

async function handleList(): Promise<void> {
  nodeProcess.stdout.write(`${JSON.stringify(await listSessions(), null, 2)}\n`);
}

async function handleStatus(
  selector: string | undefined,
  rawOptions: StatusCommandOptions,
): Promise<void> {
  const options = mergeSelector(selector, rawOptions);
  const session = options.sessionId === undefined
    ? await getSession(await resolveSessionKey(options))
    : (await listSessions()).find((candidate) => candidate.sessionId === options.sessionId);
  nodeProcess.stdout.write(`${JSON.stringify(session ?? null, null, 2)}\n`);
}

async function handleDoctor(cleanup: boolean): Promise<void> {
  const report = await runDoctor({ cleanup });
  nodeProcess.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Open a debug tunnel for one app")
    .argument("[selector]", "Optional <app> or <region>/<org>/<space>/<app>")
    .option("--region <key>", "CF region key (default: current cf target)")
    .option("--api-endpoint <url>", "Absolute HTTPS CF API endpoint override")
    .option("--org <name>", "CF org (default: current cf target)")
    .option("--space <name>", "CF space (default: current cf target)")
    .option("--app <name>", "CF app name")
    .option("--process <name>", "CF process name", "web")
    .option("-i, --instance <index>", "CF process instance", "0")
    .option("--node-pid <pid>", "Explicit remote Node.js PID")
    .option("--port <number>", "Preferred local port")
    .option(
      "--remote-port <number>",
      "Port where cf-debugger looks for an existing remote inspector",
      DEFAULT_NODE_INSPECTOR_PORT.toString(),
    )
    .option("--timeout <seconds>", "Tunnel/inspector readiness timeout", "180")
    .option("--startup-timeout <seconds>", "Overall startup deadline", "300")
    .option(
      "--allow-ssh-enable-restart",
      "Allow app-level SSH enablement and an app restart (opt-in)",
    )
    .option(
      "--no-ssh-enable-restart",
      "Forbid app-level SSH enablement and restart, overriding flag/environment",
    )
    .option("--verbose", "Print status transitions and tunnel diagnostics", false)
    .action(async (selector: string | undefined, options: StartCommandOptions): Promise<void> => {
      await handleStart(selector, options);
    });
}

function addKeyOptions(command: Command): Command {
  return command
    .option("--region <key>")
    .option("--api-endpoint <url>", "Exact API endpoint selector")
    .option("--org <name>")
    .option("--space <name>")
    .option("--app <name>")
    .option("--process <name>", "CF process name", "web")
    .option("-i, --instance <index>", "CF process instance", "0")
    .option("--node-pid <pid>", "Exact remote Node PID selector");
}

function registerStopCommand(program: Command): void {
  addKeyOptions(
    program
      .command("stop")
      .description("Stop one session by exact key/id, or every session with --all")
      .argument("[selector]", "Optional <app> or <region>/<org>/<space>/<app>"),
  )
    .option("--session-id <id>")
    .option(
      "--all",
      "Attempt every active session; cannot be combined with session selectors",
      false,
    )
    .option(
      "--force",
      "Forget unverifiable state first; best-effort remove its exact owned CF home; " +
        "never signal an unverified process",
      false,
    )
    .action(
      async (
        selector: string | undefined,
        options: StopCommandOptions,
        command: Command,
      ): Promise<void> => {
        await handleStop(selector, options, command);
      },
    );
}

function registerReadCommands(program: Command): void {
  program
    .command("list")
    .description("Print every active debugger session as JSON")
    .action(async (): Promise<void> => {
      await handleList();
    });
  addKeyOptions(
    program
      .command("status")
      .description("Print one exact session as JSON; null only when no session matches")
      .argument("[selector]", "Optional <app> or <region>/<org>/<space>/<app>"),
  )
    .option("--session-id <id>", "Exact session ID selector")
    .action(async (selector: string | undefined, options: StatusCommandOptions): Promise<void> => {
    await handleStatus(selector, options);
  });
  program
    .command("doctor")
    .description("Report session health, orphan homes/ports, temp files, and legacy credentials")
    .option("--cleanup", "Remove only safe orphan v2 homes and stale v2 temp/lock files", false)
    .action(async (options: { readonly cleanup?: boolean }): Promise<void> => {
      await handleDoctor(options.cleanup === true);
    });
}

export async function main(argv: readonly string[]): Promise<void> {
  const version = readPackageVersion();
  // Every command first checks npm (at most once an hour) and re-runs itself on a newer release; see `@saptools/core`.
  const selfUpdate = { packageName: "@saptools/cf-debugger", currentVersion: version, binName: "cf-debugger", envPrefix: "CF_DEBUGGER" };
  const program = new Command()
    .name("cf-debugger")
    .description("Open an SSH debug tunnel to a SAP BTP Cloud Foundry Node.js inspector")
    .version(version);
  attachSelfUpdate(program, selfUpdate);
  registerStartCommand(program);
  registerStopCommand(program);
  registerReadCommands(program);
  registerSelfUpdateCommand(program, selfUpdate);
  await program.parseAsync([...argv]);
}

function writeTopLevelError(error: unknown): void {
  if (error instanceof CfDebuggerError) {
    if (error.code === "ABORTED") {
      nodeProcess.stderr.write(`Aborted: ${error.message}\n`);
      nodeProcess.exit(cliErrorExitCode(error));
    }
    nodeProcess.stderr.write(`Error [${error.code}]: ${error.message}\n`);
    if (error.stderr !== undefined && error.stderr.trim().length > 0) {
      nodeProcess.stderr.write(`[cf-debugger transport]\n${error.stderr.trim()}\n`);
    }
    nodeProcess.exit(cliErrorExitCode(error));
  }
  if (hasTunnelTerminationFailure(error)) {
    const message = error instanceof Error ? error.message : String(error);
    nodeProcess.stderr.write(`Error during cleanup: ${message}\n`);
    nodeProcess.exit(CLEANUP_FAILURE_EXIT_CODE);
  }
  const message = error instanceof Error ? error.message : String(error);
  nodeProcess.stderr.write(`Error: ${message}\n`);
  nodeProcess.exit(cliErrorExitCode(error));
}

try {
  await main(nodeProcess.argv);
} catch (error: unknown) {
  writeTopLevelError(error);
}
