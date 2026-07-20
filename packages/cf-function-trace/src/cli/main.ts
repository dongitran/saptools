import type { Writable } from "node:stream";

import { CommanderError } from "commander";

import { TraceDataError } from "../errors.js";

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
  };
}

function isDisplayExit(error: unknown): boolean {
  return error instanceof CommanderError
    && (error.code === "commander.helpDisplayed" || error.code === "commander.version");
}

function publicError(error: unknown): PublicCliError {
  if (error instanceof TraceDataError) {
    return { error: { code: error.code, message: error.message } };
  }
  if (error instanceof CommanderError) {
    return { error: { code: "COMMAND_USAGE", message: "Invalid command usage." } };
  }
  return { error: { code: "COMMAND_FAILED", message: "The command could not be completed." } };
}

function failureExitCode(error: unknown): number {
  if (error instanceof TraceDataError && error.code === "TRACE_ABORTED") {
    return 130;
  }
  return error instanceof TraceDataError || error instanceof CommanderError ? 2 : 1;
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

export async function runCli(argv: readonly string[], context: RunCliContext): Promise<number> {
  const program = createProgram(context.handlers ?? defaultHandlers(context));
  program.exitOverride();
  program.configureOutput({
    writeOut: (text): void => {
      writeHelp(context.stdout, text);
    },
    writeErr: (): void => undefined,
  });
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
