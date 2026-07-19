import process from "node:process";

import { Command } from "commander";

import { readCurrentCfTarget, requireCurrentCfRegion } from "./cf.js";
import { resolveNodeTarget } from "./cloud-foundry/node-process.js";
import {
  getSession,
  listSessions,
  startDebugger,
  stopAllDebuggers,
  stopDebugger,
} from "./debugger.js";
import type { ResolvedSessionKey, SessionStatus } from "./types.js";
import { CfDebuggerError } from "./types.js";

function readRequiredOption(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    process.stderr.write(`Missing required option ${flag}\n`);
    process.exit(1);
  }
  return value;
}

function parseOptionalPort(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65_535) {
    process.stderr.write(`Invalid port: ${raw}\n`);
    process.exit(1);
  }
  return port;
}

function parseOptionalTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const seconds = Number.parseInt(raw, 10);
  if (Number.isNaN(seconds) || seconds <= 0) {
    process.stderr.write(`Invalid timeout: ${raw}\n`);
    process.exit(1);
  }
  return seconds * 1000;
}

function parseOptionalInteger(
  raw: string | undefined,
  label: string,
  minimum: number,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new CfDebuggerError("UNSAFE_INPUT", `${label} must be an integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new CfDebuggerError(
      "UNSAFE_INPUT",
      `${label} must be at least ${minimum.toString()} and within the safe integer range.`,
    );
  }
  return value;
}

interface TargetCommandOptions {
  readonly process?: string;
  readonly instance?: string;
}

interface StartCommandOptions extends TargetCommandOptions {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly port?: string;
  readonly timeout?: string;
  readonly nodePid?: string;
  readonly verbose?: boolean;
}

interface StopCommandOptions extends TargetCommandOptions {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly sessionId?: string;
  readonly all?: boolean;
}

interface StatusCommandOptions extends TargetCommandOptions {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
}

function logStatus(verbose: boolean, status: SessionStatus, message?: string): void {
  if (verbose) {
    const suffix = message === undefined ? "" : `: ${message}`;
    process.stdout.write(`[cf-debugger] ${status}${suffix}\n`);
  }
}

function mergeSelector<T extends { region?: string; org?: string; space?: string; app?: string }>(selector: string | undefined, opts: T): T {
  if (selector === undefined) {
    return opts;
  }
  const parts = selector.split("/");
  if (parts.length === 4) {
    return { ...opts, region: opts.region ?? parts[0], org: opts.org ?? parts[1], space: opts.space ?? parts[2], app: opts.app ?? parts[3] };
  }
  if (parts.length === 1) {
    return { ...opts, app: opts.app ?? parts[0] };
  }
  throw new CfDebuggerError("UNSAFE_INPUT", "Invalid app selector format. Expected <app> or <region>/<org>/<space>/<app>.");
}

interface StartupAbort {
  readonly signal: AbortSignal;
  dispose(): void;
}

function startupAbort(app: string): StartupAbort {
  const controller = new AbortController();
  const handler = (exitCode: number) => (): void => {
    controller.abort();
    process.stderr.write(`\nAborting startup for ${app}...\n`);
    setTimeout(() => { process.exit(exitCode); }, 5_000).unref();
  };
  const onSigint = handler(130);
  const onSigterm = handler(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    signal: controller.signal,
    dispose: (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

function writeReady(
  app: string,
  key: ResolvedSessionKey,
  handle: Awaited<ReturnType<typeof startDebugger>>,
): void {
  process.stdout.write(
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

function handleDisposer(
  app: string,
  handle: Awaited<ReturnType<typeof startDebugger>>,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return async (): Promise<void> => {
    pending ??= (async (): Promise<void> => {
      process.stdout.write(`\nStopping debugger for ${app}...\n`);
      try {
        await handle.dispose();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error during stop: ${message}\n`);
      }
    })();
    await pending;
  };
}

async function waitForHandle(
  app: string,
  handle: Awaited<ReturnType<typeof startDebugger>>,
): Promise<void> {
  const dispose = handleDisposer(app, handle);
  const stop = (exitCode: number) => (): void => {
    void dispose().then(() => { process.exit(exitCode); });
  };
  process.on("SIGINT", stop(130));
  process.on("SIGTERM", stop(143));
  const code = await handle.waitForExit();
  await dispose();
  process.exit(code ?? 0);
}

async function handleStart(selector: string | undefined, rawOpts: StartCommandOptions): Promise<void> {
  const opts = mergeSelector(selector, rawOpts);
  const app = readRequiredOption(opts.app, "--app or selector");
  const key = await resolveSessionKey({ ...opts, app });
  const verbose = opts.verbose ?? false;

  const preferredPort = parseOptionalPort(opts.port);
  const tunnelReadyTimeoutMs = parseOptionalTimeout(opts.timeout);
  const nodePid = parseOptionalInteger(opts.nodePid, "nodePid", 1);

  const abort = startupAbort(app);

  let handle;
  try {
    handle = await startDebugger({
      region: key.region,
      org: key.org,
      space: key.space,
      app,
      process: key.process,
      instance: key.instance,
      verbose,
      signal: abort.signal,
      ...(preferredPort === undefined ? {} : { preferredPort }),
      ...(tunnelReadyTimeoutMs === undefined ? {} : { tunnelReadyTimeoutMs }),
      ...(nodePid === undefined ? {} : { nodePid }),
      onStatus: (status, message) => {
        logStatus(verbose, status, message);
      },
    });
  } finally {
    abort.dispose();
  }
  writeReady(app, key, handle);
  await waitForHandle(app, handle);
}

function hasText(value: string | undefined): boolean {
  return optionalText(value) !== undefined;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function currentCfOptions(): { readonly command?: string } | undefined {
  const command = process.env["CF_DEBUGGER_CF_BIN"];
  return command === undefined ? undefined : { command };
}

async function resolveSessionKey(opts: StopCommandOptions): Promise<ResolvedSessionKey> {
  const app = readRequiredOption(opts.app, "--app or selector");
  const region = optionalText(opts.region);
  const org = optionalText(opts.org);
  const space = optionalText(opts.space);
  const processName = opts.process;
  const instance = parseOptionalInteger(opts.instance, "instance", 0);
  const target = resolveNodeTarget({
    ...(processName === undefined ? {} : { process: processName }),
    ...(instance === undefined ? {} : { instance }),
  });
  if (region !== undefined && org !== undefined && space !== undefined) {
    return {
      region,
      org,
      space,
      app,
      process: target.process,
      instance: target.instance,
    };
  }

  const current = await readCurrentCfTarget(currentCfOptions()).catch((error: unknown) => {
    throw new CfDebuggerError(
      "CF_TARGET_FAILED",
      "No current CF target found. Run `cf target -o <org> -s <space>` or pass --region/--org/--space.",
      error instanceof Error ? error.message : String(error),
    );
  });
  if (current === undefined) {
    throw new CfDebuggerError(
      "CF_TARGET_FAILED",
      "No current CF target found. Run `cf target -o <org> -s <space>` or pass --region/--org/--space.",
    );
  }

  return {
    region: region ?? requireCurrentCfRegion(current),
    org: org ?? current.org,
    space: space ?? current.space,
    app,
    process: target.process,
    instance: target.instance,
  };
}

async function resolveOptionalSessionKey(
  opts: StopCommandOptions,
): Promise<ResolvedSessionKey | undefined> {
  if (!hasText(opts.app)) {
    if (hasText(opts.region) || hasText(opts.org) || hasText(opts.space)) {
      readRequiredOption(opts.app, "--app");
    }
    return undefined;
  }
  return await resolveSessionKey(opts);
}

async function handleStop(selector: string | undefined, rawOpts: StopCommandOptions): Promise<void> {
  const opts = mergeSelector(selector, rawOpts);
  if (opts.all === true) {
    const count = await stopAllDebuggers();
    process.stdout.write(`Stop requested for ${count.toString()} session(s).\n`);
    return;
  }
  const key = await resolveOptionalSessionKey(opts);
  const result = await stopDebugger({
    ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
    ...(key === undefined ? {} : { key }),
  });
  if (result === undefined) {
    process.stderr.write(
      "No matching session found. Use `cf-debugger list` and pass --session-id or " +
        "region/org/space/app if the current CF target differs.\n",
    );
    process.exit(1);
  }
  if (result.pending) {
    process.stdout.write(
      `Stop requested for session ${result.sessionId} ` +
        `(${result.app}, startup phase ${result.status}).\n`,
    );
    return;
  }
  if (result.stale) {
    process.stdout.write(
      `Removed stale session ${result.sessionId} (${result.app}, port ${result.localPort.toString()}).\n`,
    );
    return;
  }
  process.stdout.write(
    `Stopped session ${result.sessionId} (${result.app}, port ${result.localPort.toString()}).\n`,
  );
}

async function handleList(): Promise<void> {
  const sessions = await listSessions();
  process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
}

async function handleStatus(selector: string | undefined, rawOpts: StatusCommandOptions): Promise<void> {
  const opts = mergeSelector(selector, rawOpts);
  const session = await getSession(await resolveSessionKey(opts));
  process.stdout.write(`${JSON.stringify(session ?? null, null, 2)}\n`);
}

function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Open a debug tunnel for one app")
    .argument("[selector]", "Optional app selector: `<app>` or `region/org/space/app`")
    .option("--region <key>", "CF region key (default: current cf target)")
    .option("--org <name>", "CF org name (default: current cf target)")
    .option("--space <name>", "CF space name (default: current cf target)")
    .option("--app <name>", "CF app name")
    .option("--process <name>", "CF process name", "web")
    .option("-i, --instance <index>", "CF process instance index", "0")
    .option("--node-pid <pid>", "Explicit remote Node.js PID")
    .option("--port <number>", "Preferred local port (auto-assigned if omitted)")
    .option("--timeout <seconds>", "Tunnel-ready timeout in seconds (default: 180)")
    .option("--verbose", "Print status transitions", false)
    .action(async (selector: string | undefined, opts: StartCommandOptions): Promise<void> => {
      await handleStart(selector, opts);
    });
}

function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop one session (by key or id) or all sessions with --all")
    .argument("[selector]", "Optional app selector: `<app>` or `region/org/space/app`")
    .option("--region <key>")
    .option("--org <name>")
    .option("--space <name>")
    .option("--app <name>")
    .option("--process <name>", "CF process name", "web")
    .option("-i, --instance <index>", "CF process instance index", "0")
    .option("--session-id <id>")
    .option("--all", "Stop every active session", false)
    .action(async (selector: string | undefined, opts: StopCommandOptions): Promise<void> => {
      await handleStop(selector, opts);
    });
}

function registerReadCommands(program: Command): void {
  program
    .command("list")
    .description("Print every active debugger session as JSON")
    .action(async (): Promise<void> => {
      await handleList();
    });

  program
    .command("status")
    .description("Print one session by key as JSON (null if not active)")
    .argument("[selector]", "Optional app selector: `<app>` or `region/org/space/app`")
    .option("--region <key>")
    .option("--org <name>")
    .option("--space <name>")
    .option("--app <name>")
    .option("--process <name>", "CF process name", "web")
    .option("-i, --instance <index>", "CF process instance index", "0")
    .action(async (selector: string | undefined, opts: StatusCommandOptions): Promise<void> => {
      await handleStatus(selector, opts);
    });
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command()
    .name("cf-debugger")
    .description("Open an SSH debug tunnel to a SAP BTP Cloud Foundry app's Node.js inspector");
  registerStartCommand(program);
  registerStopCommand(program);
  registerReadCommands(program);

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (err: unknown) {
  if (err instanceof CfDebuggerError) {
    if (err.code === "ABORTED") {
      process.stderr.write(`Aborted: ${err.message}\n`);
      process.exit(130);
    }
    process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
  }
  process.exit(1);
}
