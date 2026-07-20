import type { Writable } from "node:stream";

import { CommanderError } from "commander";

import { TraceDataError, type ErrorCandidate } from "../errors.js";

import { createDefaultHandlers } from "./handlers.js";
import { writeJsonOutput } from "./output.js";
import { createProgram, type CliCommandHandlers } from "./program.js";
import type { TraceRuntimeRunner } from "./trace-commands.js";

export interface RunCliContext {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly signal?: AbortSignal;
  readonly saptoolsRoot?: string;
  readonly runtimeRunner?: TraceRuntimeRunner;
  readonly handlers?: CliCommandHandlers;
}

interface PublicCliError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly candidates?: readonly ErrorCandidate[];
    readonly runId?: string;
    readonly directory?: string;
  };
}

function isDisplayExit(error: unknown): boolean {
  if (!(error instanceof CommanderError)) {
    return false;
  }
  // "commander.help" is shared by two different outcomes from Commander's own
  // help()/`_dispatchHelpCommand`: the bare `help` subcommand with no target
  // (exitCode 0, text already written through the working writeOut channel)
  // and an internal error-flagged help call, e.g. `help <unknown-target>`
  // (exitCode 1, text routed to the suppressed writeErr and never seen). Only
  // the exitCode-0 case already displayed something useful, so only that one
  // is safe to treat as "handled, nothing more to report" -- the other must
  // still fall through to a real JSON error below.
  return error.code === "commander.helpDisplayed"
    || error.code === "commander.version"
    || (error.code === "commander.help" && error.exitCode === 0);
}

function stringField(error: unknown, field: string): string | undefined {
  return typeof error === "object" && error !== null && typeof Reflect.get(error, field) === "string"
    ? String(Reflect.get(error, field))
    : undefined;
}

interface OperationalError {
  readonly code: string;
  readonly message: string;
}

// CfDebuggerError/CfInspectorError (e.g. SESSION_ALREADY_RUNNING's "stop it
// first with cf-debugger stop" guidance, thrown while opening a CF tunnel
// before a trace run is even created) are structurally identical -- a stable
// `name` tag plus a string `code` -- but cf-debugger is only a transitive
// dependency here (via cf-inspector), so this recognizes them by that `name`
// tag rather than `instanceof`, which would require a new direct dependency
// just to unwrap a code/message pair that is already safe to show.
function operationalError(error: unknown): OperationalError | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  if (error.name !== "CfDebuggerError" && error.name !== "CfInspectorError") {
    return undefined;
  }
  const code = stringField(error, "code");
  return code === undefined ? undefined : { code, message: error.message };
}

function traceDataErrorFields(error: TraceDataError): Omit<PublicCliError["error"], "code" | "message"> {
  const runId = stringField(error, "runId");
  const directory = stringField(error, "directory");
  return {
    ...(error.candidates === undefined ? {} : { candidates: error.candidates }),
    ...(runId === undefined ? {} : { runId }),
    ...(directory === undefined ? {} : { directory }),
  };
}

function publicError(error: unknown): PublicCliError {
  if (error instanceof TraceDataError) {
    return { error: { code: error.code, message: error.message, ...traceDataErrorFields(error) } };
  }
  if (error instanceof CommanderError) {
    // Commander's own message/code (e.g. "error: unknown option '--foo'",
    // commander.unknownOption) are already safe, user-facing CLI-usage text
    // -- surfacing them beats the generic "Invalid command usage." string
    // that previously discarded the one detail (which flag, which option)
    // an agent needs to self-correct.
    return { error: { code: error.code, message: error.message } };
  }
  const operational = operationalError(error);
  if (operational !== undefined) {
    return { error: operational };
  }
  return { error: { code: "COMMAND_FAILED", message: "The command could not be completed." } };
}

function failureExitCode(error: unknown): number {
  if (error instanceof TraceDataError && error.code === "TRACE_ABORTED") {
    return 130;
  }
  if (error instanceof TraceDataError || error instanceof CommanderError || operationalError(error) !== undefined) {
    return 2;
  }
  return 1;
}

function defaultHandlers(context: RunCliContext): CliCommandHandlers {
  return createDefaultHandlers({
    stdout: context.stdout,
    stderr: context.stderr,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.saptoolsRoot === undefined ? {} : { saptoolsRoot: context.saptoolsRoot }),
    ...(context.runtimeRunner === undefined ? {} : { runtimeRunner: context.runtimeRunner }),
  });
}

function writeHelp(stream: Writable, text: string): void {
  try {
    stream.write(text);
  } catch (error: unknown) {
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "EPIPE") {
      throw error;
    }
  }
}

function isBareInvocation(argv: readonly string[]): boolean {
  // argv is the conventional [node, script, ...userArgs] shape (see cli.ts's
  // process.argv), so no user arguments at all means length 2 or less.
  return argv.length <= 2;
}

export async function runCli(argv: readonly string[], context: RunCliContext): Promise<number> {
  const program = createProgram(context.handlers ?? defaultHandlers(context));
  program.exitOverride();
  program.configureOutput({
    writeOut: (text): void => {
      writeHelp(context.stdout, text);
    },
    writeErr: (): void => undefined,
  });
  if (isBareInvocation(argv)) {
    // Commander's own bare-invocation path calls help({error: true}), which
    // routes the command list through the suppressed writeErr above and then
    // throws a generic usage error -- an agent's first exploratory
    // invocation would see neither the command list nor a clean signal, just
    // a content-free exit. Show it through the working writeOut channel
    // instead, with no JSON error alongside it.
    program.outputHelp();
    return 1;
  }
  try {
    await program.parseAsync([...argv]);
    return 0;
  } catch (error: unknown) {
    if (isDisplayExit(error)) {
      return 0;
    }
    await writeJsonOutput(context.stderr, publicError(error), 4096);
    return failureExitCode(error);
  }
}
