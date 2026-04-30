import process from "node:process";

import { Command } from "commander";

import {
  connectInspector,
  evaluateGlobal,
  fetchInspectorVersion,
  listScripts,
  resume,
  setBreakpoint,
  validateExpression,
  waitForPause,
} from "./inspector.js";
import type { InspectorSession } from "./inspector.js";
import { streamLogpoint } from "./logpoint.js";
import type { LogpointEvent } from "./logpoint.js";
import { parseBreakpointSpec, parseRemoteRoot } from "./pathMapper.js";
import { captureSnapshot } from "./snapshot.js";
import { openCfTunnel } from "./tunnel.js";
import { CfInspectorError } from "./types.js";
import type { BreakpointHandle, SnapshotResult } from "./types.js";

const DEFAULT_BREAKPOINT_TIMEOUT_SEC = 30;
const DEFAULT_CF_TIMEOUT_SEC = 60;

interface PortTarget {
  readonly kind: "port";
  readonly port: number;
  readonly host: string;
}

interface CfTarget {
  readonly kind: "cf";
  readonly region: string;
  readonly org: string;
  readonly space: string;
  readonly app: string;
  readonly cfTimeoutMs: number;
}

type Target = PortTarget | CfTarget;

interface SharedTargetOptions {
  readonly port?: string;
  readonly host?: string;
  readonly region?: string;
  readonly org?: string;
  readonly space?: string;
  readonly app?: string;
  readonly cfTimeout?: string;
}

interface SnapshotCommandOptions extends SharedTargetOptions {
  readonly bp: readonly string[];
  readonly capture?: string;
  readonly timeout?: string;
  readonly remoteRoot?: string;
  readonly condition?: string;
  readonly json: boolean;
  readonly keepPaused?: boolean;
}

interface EvalCommandOptions extends SharedTargetOptions {
  readonly expr: string;
  readonly json: boolean;
}

interface ListScriptsCommandOptions extends SharedTargetOptions {
  readonly json: boolean;
}

interface LogCommandOptions extends SharedTargetOptions {
  readonly at: string;
  readonly expr: string;
  readonly remoteRoot?: string;
  readonly duration?: string;
  readonly json: boolean;
}

interface AttachCommandOptions extends SharedTargetOptions {
  readonly json: boolean;
}

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0 || value.toString() !== raw.trim()) {
    throw new CfInspectorError("INVALID_ARGUMENT", `Invalid ${label}: "${raw}" — expected a positive integer`);
  }
  return value;
}

function resolveTarget(opts: SharedTargetOptions): Target {
  const port = parsePositiveInt(opts.port, "--port");
  if (port !== undefined) {
    return { kind: "port", port, host: opts.host ?? "127.0.0.1" };
  }
  if (
    opts.region !== undefined &&
    opts.org !== undefined &&
    opts.space !== undefined &&
    opts.app !== undefined
  ) {
    const cfTimeoutSec = parsePositiveInt(opts.cfTimeout, "--cf-timeout") ?? DEFAULT_CF_TIMEOUT_SEC;
    return {
      kind: "cf",
      region: opts.region,
      org: opts.org,
      space: opts.space,
      app: opts.app,
      cfTimeoutMs: cfTimeoutSec * 1000,
    };
  }
  throw new CfInspectorError(
    "MISSING_TARGET",
    "Provide either --port (and optionally --host) or all of --region, --org, --space, --app.",
  );
}

interface ResolvedTunnel {
  readonly port: number;
  readonly host: string;
  readonly dispose: () => Promise<void>;
}

async function openTarget(target: Target): Promise<ResolvedTunnel> {
  if (target.kind === "port") {
    return {
      port: target.port,
      host: target.host,
      dispose: (): Promise<void> => Promise.resolve(),
    };
  }
  const tunnel = await openCfTunnel({
    region: target.region,
    org: target.org,
    space: target.space,
    app: target.app,
    tunnelReadyTimeoutMs: target.cfTimeoutMs,
  });
  return {
    port: tunnel.localPort,
    host: "127.0.0.1",
    dispose: async (): Promise<void> => {
      await tunnel.dispose();
    },
  };
}

function parseCaptureList(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(",")
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

async function withSession<T>(
  target: Target,
  fn: (session: InspectorSession, port: number) => Promise<T>,
): Promise<T> {
  const tunnel = await openTarget(target);
  let session: InspectorSession | undefined;
  try {
    session = await connectInspector({ port: tunnel.port, host: tunnel.host });
    return await fn(session, tunnel.port);
  } finally {
    if (session) {
      await session.dispose();
    }
    await tunnel.dispose();
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * V8's `Debugger.setBreakpointByUrl` happily returns a breakpointId even when
 * the file:line did not match any loaded script — `resolvedLocations` is then
 * empty and the breakpoint will silently never fire. Surface a stderr warning
 * (not an error: source maps may resolve later if the script loads) so users
 * can spot a typo in --bp without staring at a BREAKPOINT_NOT_HIT timeout.
 */
function warnOnUnboundBreakpoints(handles: readonly BreakpointHandle[]): void {
  for (const handle of handles) {
    if (handle.resolvedLocations.length === 0) {
      process.stderr.write(
        `[cf-inspector] warning: breakpoint ${handle.file}:${handle.line.toString()} ` +
          `did not bind to any loaded script. Check the path or pass --remote-root. ` +
          `Use 'list-scripts' to inspect what V8 currently has loaded.\n`,
      );
    }
  }
}

function writeHumanSnapshot(snapshot: SnapshotResult): void {
  const lines: string[] = [];
  lines.push(`Snapshot @ ${snapshot.capturedAt}`, `  reason:  ${snapshot.reason}`);
  // Skip the raw CDP breakpoint IDs in human output — the frame line below
  // already shows file:line, and the IDs include the verbose internal urlRegex.
  if (snapshot.topFrame) {
    const frame = snapshot.topFrame;
    const fnName = frame.functionName.length === 0 ? "(anonymous)" : frame.functionName;
    const sourceUrl = frame.url !== undefined && frame.url.length > 0 ? frame.url : "(unknown)";
    lines.push(
      `  frame:   ${fnName} ${sourceUrl}:${frame.line.toString()}:${frame.column.toString()}`,
    );
    for (const scope of frame.scopes) {
      lines.push(`  scope ${scope.type} (${scope.variables.length.toString()} vars):`);
      for (const variable of scope.variables) {
        lines.push(`    ${variable.name} = ${variable.value}`);
      }
    }
  }
  if (snapshot.captures.length > 0) {
    lines.push("  captures:");
    for (const capture of snapshot.captures) {
      const detail = capture.error ?? capture.value ?? "undefined";
      lines.push(`    ${capture.expression} = ${detail}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function handleSnapshot(opts: SnapshotCommandOptions): Promise<void> {
  const target = resolveTarget(opts);
  if (opts.bp.length === 0) {
    throw new CfInspectorError(
      "INVALID_BREAKPOINT",
      "At least one --bp <file:line> is required.",
    );
  }
  const breakpoints = opts.bp.map((spec) => parseBreakpointSpec(spec));
  const remoteRoot = parseRemoteRoot(opts.remoteRoot);
  const captures = parseCaptureList(opts.capture);
  const timeoutSec = parsePositiveInt(opts.timeout, "--timeout") ?? DEFAULT_BREAKPOINT_TIMEOUT_SEC;
  const timeoutMs = timeoutSec * 1000;
  const condition = opts.condition !== undefined && opts.condition.trim().length > 0
    ? opts.condition.trim()
    : undefined;

  const result = await withSession(target, async (session): Promise<SnapshotResult> => {
    if (condition !== undefined) {
      await validateExpression(session, condition);
    }
    const handles = await Promise.all(
      breakpoints.map((bp) =>
        setBreakpoint(session, {
          file: bp.file,
          line: bp.line,
          remoteRoot,
          ...(condition === undefined ? {} : { condition }),
        }),
      ),
    );
    warnOnUnboundBreakpoints(handles);
    const breakpointIds = handles.map((h) => h.breakpointId);
    const pause = await waitForPause(session, { timeoutMs, breakpointIds });
    const snapshot = await captureSnapshot(session, pause, { captures });
    if (opts.keepPaused !== true) {
      try {
        await resume(session);
      } catch {
        // best-effort
      }
    }
    return snapshot;
  });

  if (opts.json) {
    writeJson(result);
  } else {
    writeHumanSnapshot(result);
  }
}

async function handleEval(opts: EvalCommandOptions): Promise<void> {
  const target = resolveTarget(opts);
  const result = await withSession(target, async (session) => {
    return await evaluateGlobal(session, opts.expr);
  });
  if (opts.json) {
    writeJson(result);
    return;
  }
  if (result.exceptionDetails !== undefined) {
    const detail =
      typeof result.exceptionDetails.exception?.description === "string"
        ? result.exceptionDetails.exception.description
        : (typeof result.exceptionDetails.text === "string" ? result.exceptionDetails.text : "evaluation failed");
    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
    return;
  }
  const inner = result.result;
  if (inner === undefined) {
    process.stdout.write("\n");
    return;
  }
  if (typeof inner.value === "string") {
    process.stdout.write(`${inner.value}\n`);
    return;
  }
  if (typeof inner.description === "string") {
    process.stdout.write(`${inner.description}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(inner.value)}\n`);
}

function writeLogEvent(event: LogpointEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (event.error !== undefined) {
    process.stdout.write(`[${event.ts}] ${event.at} !err ${event.error}\n`);
    return;
  }
  process.stdout.write(`[${event.ts}] ${event.at} ${event.value ?? ""}\n`);
}

async function handleLog(opts: LogCommandOptions): Promise<void> {
  const target = resolveTarget(opts);
  const location = parseBreakpointSpec(opts.at);
  const remoteRoot = parseRemoteRoot(opts.remoteRoot);
  const durationSec = parsePositiveInt(opts.duration, "--duration");
  const expression = opts.expr.trim();
  if (expression.length === 0) {
    throw new CfInspectorError("INVALID_BREAKPOINT", "--expr must not be empty");
  }

  const abort = new AbortController();
  const onSig = (): void => {
    abort.abort();
  };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  try {
    await withSession(target, async (session) => {
      await validateExpression(session, expression);
      const result = await streamLogpoint(session, {
        location,
        expression,
        remoteRoot,
        ...(durationSec === undefined ? {} : { durationMs: durationSec * 1000 }),
        signal: abort.signal,
        onEvent: (event) => {
          writeLogEvent(event, opts.json);
        },
        onBreakpointSet: (handle) => {
          warnOnUnboundBreakpoints([handle]);
        },
      });
      if (opts.json) {
        process.stderr.write(
          `${JSON.stringify({ stopped: result.stoppedReason, emitted: result.emitted })}\n`,
        );
      } else {
        process.stderr.write(
          `Stopped (${result.stoppedReason}); emitted ${result.emitted.toString()} log ${result.emitted === 1 ? "entry" : "entries"}.\n`,
        );
      }
    });
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
}

async function handleListScripts(opts: ListScriptsCommandOptions): Promise<void> {
  const target = resolveTarget(opts);
  const scripts = await withSession(target, (session) => Promise.resolve(listScripts(session)));
  if (opts.json) {
    writeJson(scripts);
    return;
  }
  for (const script of scripts) {
    process.stdout.write(`${script.scriptId}\t${script.url}\n`);
  }
}

async function handleAttach(opts: AttachCommandOptions): Promise<void> {
  const target = resolveTarget(opts);
  const tunnel = await openTarget(target);
  try {
    const version = await fetchInspectorVersion(tunnel.host, tunnel.port, 5_000);
    if (opts.json) {
      writeJson({ host: tunnel.host, port: tunnel.port, ...version });
      return;
    }
    process.stdout.write(
      `Connected to ${tunnel.host}:${tunnel.port.toString()}\n` +
        `  Browser: ${version.browser}\n` +
        `  Protocol: ${version.protocolVersion}\n`,
    );
  } finally {
    await tunnel.dispose();
  }
}

function applyTargetOptions(cmd: Command): Command {
  return cmd
    .option("--port <number>", "Local port the inspector or tunnel listens on")
    .option("--host <host>", "Hostname (default: 127.0.0.1)", "127.0.0.1")
    .option("--region <key>", "CF region key (e.g. eu10)")
    .option("--org <name>", "CF org name")
    .option("--space <name>", "CF space name")
    .option("--app <name>", "CF app name")
    .option("--cf-timeout <seconds>", "Timeout for CF tunnel readiness in seconds");
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();
  program
    .name("cf-inspector")
    .description("Drive a Node.js inspector from the command line — set breakpoints, capture snapshots, evaluate expressions");

  const collectStrings = (value: string, prev: readonly string[] = []): readonly string[] => [
    ...prev,
    value,
  ];

  applyTargetOptions(
    program
      .command("snapshot")
      .description("Set a breakpoint, wait for it to hit, capture the scope, and resume"),
  )
    .option(
      "--bp <file:line>",
      "Breakpoint location (repeatable; first hit wins), e.g. src/handler.ts:42",
      collectStrings,
      [] as readonly string[],
    )
    .option("--capture <expr,…>", "Comma-separated expressions to evaluate in the paused frame")
    .option("--timeout <seconds>", "How long to wait for the breakpoint to hit (default: 30)")
    .option("--remote-root <value>", "Path-mapping anchor: literal path or regex:<pattern> / /pattern/flags")
    .option(
      "--condition <expr>",
      "Only pause when this JS expression evaluates truthy in the paused frame",
    )
    .option("--no-json", "Print a human-readable summary instead of JSON")
    .option("--keep-paused", "Skip the auto-resume after capture")
    .action(async (opts: SnapshotCommandOptions): Promise<void> => {
      await handleSnapshot(opts);
    });

  applyTargetOptions(
    program
      .command("log")
      .description("Stream a non-pausing logpoint: log an expression each time a line executes"),
  )
    .requiredOption("--at <file:line>", "Logpoint location, e.g. src/handler.ts:42")
    .requiredOption("--expr <expression>", "JavaScript expression to log on each hit")
    .option("--remote-root <value>", "Path-mapping anchor: literal path or regex:<pattern> / /pattern/flags")
    .option("--duration <seconds>", "Stop streaming after N seconds (default: run until SIGINT)")
    .option("--no-json", "Print human-readable lines instead of JSON Lines")
    .action(async (opts: LogCommandOptions): Promise<void> => {
      await handleLog(opts);
    });

  applyTargetOptions(
    program
      .command("eval")
      .description("Evaluate an expression against the global Runtime"),
  )
    .requiredOption("--expr <expression>", "JavaScript expression to evaluate")
    .option("--no-json", "Print only the resulting value, not the full CDP envelope")
    .action(async (opts: EvalCommandOptions): Promise<void> => {
      await handleEval(opts);
    });

  applyTargetOptions(
    program
      .command("list-scripts")
      .description("Print the scripts the V8 instance currently knows about"),
  )
    .option("--no-json", "Print scriptId<TAB>url instead of JSON")
    .action(async (opts: ListScriptsCommandOptions): Promise<void> => {
      await handleListScripts(opts);
    });

  applyTargetOptions(
    program
      .command("attach")
      .description("Connect, fetch the inspector version, and disconnect (smoke-test)"),
  )
    .option("--no-json", "Print a multi-line summary instead of JSON")
    .action(async (opts: AttachCommandOptions): Promise<void> => {
      await handleAttach(opts);
    });

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (err: unknown) {
  if (err instanceof CfInspectorError) {
    process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
    if (err.detail !== undefined) {
      process.stderr.write(`  detail: ${err.detail}\n`);
    }
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
