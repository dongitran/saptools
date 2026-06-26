import process from "node:process";

import { Command } from "commander";

import { readCurrentCfTarget, requireCurrentCfRegion } from "./cf.js";
import {
  getSession,
  listSessions,
  startDebugger,
  stopAllDebuggers,
  stopDebugger,
} from "./debugger.js";
import type { SessionKey, SessionStatus } from "./types.js";
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

interface StartCommandOptions {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app: string;
  readonly port?: string;
  readonly timeout?: string;
  readonly verbose?: boolean;
}

interface StopCommandOptions {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly sessionId?: string;
  readonly all?: boolean;
}

interface StatusCommandOptions {
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app: string;
}

function logStatus(verbose: boolean, status: SessionStatus, message?: string): void {
  if (verbose) {
    const suffix = message === undefined ? "" : `: ${message}`;
    process.stdout.write(`[cf-debugger] ${status}${suffix}\n`);
  }
}

async function handleStart(opts: StartCommandOptions): Promise<void> {
  const app = readRequiredOption(opts.app, "--app");
  const key = await resolveSessionKey({ ...opts, app });
  const verbose = opts.verbose ?? false;

  const preferredPort = parseOptionalPort(opts.port);
  const tunnelReadyTimeoutMs = parseOptionalTimeout(opts.timeout);

  const abortController = new AbortController();
  const onStartupSignal = (exitCode: number) => (): void => {
    abortController.abort();
    process.stderr.write(`\nAborting startup for ${app}...\n`);
    setTimeout(() => {
      process.exit(exitCode);
    }, 5_000).unref();
  };
  const startupSigint = onStartupSignal(130);
  const startupSigterm = onStartupSignal(143);
  process.on("SIGINT", startupSigint);
  process.on("SIGTERM", startupSigterm);

  let handle;
  try {
    handle = await startDebugger({
      region: key.region,
      org: key.org,
      space: key.space,
      app,
      verbose,
      signal: abortController.signal,
      ...(preferredPort === undefined ? {} : { preferredPort }),
      ...(tunnelReadyTimeoutMs === undefined ? {} : { tunnelReadyTimeoutMs }),
      onStatus: (status, message) => {
        logStatus(verbose, status, message);
      },
    });
  } finally {
    process.off("SIGINT", startupSigint);
    process.off("SIGTERM", startupSigterm);
  }

  process.stdout.write(
    `Debugger ready for ${app} (${key.region}/${key.org}/${key.space}).\n` +
      `  Local port:  ${handle.session.localPort.toString()}\n` +
      `  Remote port: ${handle.session.remotePort.toString()}\n` +
      `  Session id:  ${handle.session.sessionId}\n` +
      `  PID:         ${handle.session.pid.toString()}\n` +
      `Press Ctrl+C to stop.\n`,
  );

  let disposePromise: Promise<void> | undefined;
  const dispose = async (): Promise<void> => {
    disposePromise ??= (async (): Promise<void> => {
      process.stdout.write(`\nStopping debugger for ${app}...\n`);
      try {
        await handle.dispose();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error during stop: ${msg}\n`);
      }
    })();
    await disposePromise;
  };

  process.on("SIGINT", () => {
    void dispose().then(() => {
      process.exit(130);
    });
  });
  process.on("SIGTERM", () => {
    void dispose().then(() => {
      process.exit(143);
    });
  });

  const code = await handle.waitForExit();
  await dispose();
  process.exit(code ?? 0);
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

async function resolveSessionKey(opts: StopCommandOptions): Promise<SessionKey> {
  const app = readRequiredOption(opts.app, "--app");
  const region = optionalText(opts.region);
  const org = optionalText(opts.org);
  const space = optionalText(opts.space);
  if (region !== undefined && org !== undefined && space !== undefined) {
    return {
      region,
      org,
      space,
      app,
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
  };
}

async function resolveOptionalSessionKey(opts: StopCommandOptions): Promise<SessionKey | undefined> {
  if (!hasText(opts.app)) {
    if (hasText(opts.region) || hasText(opts.org) || hasText(opts.space)) {
      readRequiredOption(opts.app, "--app");
    }
    return undefined;
  }
  return await resolveSessionKey(opts);
}

async function handleStop(opts: StopCommandOptions): Promise<void> {
  if (opts.all === true) {
    const count = await stopAllDebuggers();
    process.stdout.write(`Stopped ${count.toString()} session(s).\n`);
    return;
  }
  const key = await resolveOptionalSessionKey(opts);
  const result = await stopDebugger({
    ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
    ...(key === undefined ? {} : { key }),
  });
  if (result === undefined) {
    process.stderr.write("No matching session found.\n");
    process.exit(1);
  }
  process.stdout.write(
    `Stopped session ${result.sessionId} (${result.app}, port ${result.localPort.toString()}).\n`,
  );
}

async function handleList(): Promise<void> {
  const sessions = await listSessions();
  process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
}

async function handleStatus(opts: StatusCommandOptions): Promise<void> {
  const session = await getSession(await resolveSessionKey(opts));
  process.stdout.write(`${JSON.stringify(session ?? null, null, 2)}\n`);
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("cf-debugger")
    .description("Open an SSH debug tunnel to a SAP BTP Cloud Foundry app's Node.js inspector");

  program
    .command("start")
    .description("Open a debug tunnel for one app")
    .option("--region <key>", "CF region key (default: current cf target)")
    .option("--org <name>", "CF org name (default: current cf target)")
    .option("--space <name>", "CF space name (default: current cf target)")
    .requiredOption("--app <name>", "CF app name")
    .option("--port <number>", "Preferred local port (auto-assigned if omitted)")
    .option("--timeout <seconds>", "Tunnel-ready timeout in seconds (default: 180)")
    .option("--verbose", "Print status transitions", false)
    .action(async (opts: StartCommandOptions): Promise<void> => {
      await handleStart(opts);
    });

  program
    .command("stop")
    .description("Stop one session (by key or id) or all sessions with --all")
    .option("--region <key>")
    .option("--org <name>")
    .option("--space <name>")
    .option("--app <name>")
    .option("--session-id <id>")
    .option("--all", "Stop every active session", false)
    .action(async (opts: StopCommandOptions): Promise<void> => {
      await handleStop(opts);
    });

  program
    .command("list")
    .description("Print every active debugger session as JSON")
    .action(async (): Promise<void> => {
      await handleList();
    });

  program
    .command("status")
    .description("Print one session by key as JSON (null if not active)")
    .option("--region <key>")
    .option("--org <name>")
    .option("--space <name>")
    .requiredOption("--app <name>")
    .action(async (opts: StatusCommandOptions): Promise<void> => {
      await handleStatus(opts);
    });

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
