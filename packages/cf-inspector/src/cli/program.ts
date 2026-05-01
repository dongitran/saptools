import { Command } from "commander";

import type {
  AttachCommandOptions,
  EvalCommandOptions,
  ListScriptsCommandOptions,
  LogCommandOptions,
  SnapshotCommandOptions,
} from "./commandTypes.js";
import { handleAttach } from "./commands/attach.js";
import { handleEval } from "./commands/eval.js";
import { handleListScripts } from "./commands/listScripts.js";
import { handleLog } from "./commands/log.js";
import { handleSnapshot } from "./commands/snapshot.js";

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

  registerSnapshot(program);
  registerLog(program);
  registerEval(program);
  registerListScripts(program);
  registerAttach(program);

  await program.parseAsync([...argv]);
}

function registerSnapshot(program: Command): void {
  const collectStrings = (value: string, prev: readonly string[] = []): readonly string[] => [
    ...prev,
    value,
  ];
  applyTargetOptions(
    program.command("snapshot").description("Set a breakpoint, wait for it to hit, capture expressions, and resume"),
  )
    .option("--bp <file:line>", "Breakpoint location (repeatable; first hit wins), e.g. src/handler.ts:42", collectStrings, [] as readonly string[])
    .option("--capture <expr,…>", "Top-level comma-separated expressions to evaluate in the paused frame")
    .option("--timeout <seconds>", "How long to wait for the breakpoint to hit (default: 30)")
    .option("--max-value-length <chars>", "Maximum characters per captured value before truncation (default: 4096)")
    .option("--remote-root <value>", "Path-mapping anchor: literal path or regex:<pattern> / /pattern/flags")
    .option("--condition <expr>", "Only pause when this JS expression evaluates truthy in the paused frame")
    .option("--include-scopes", "Include expanded paused-frame scopes in the snapshot")
    .option("--no-json", "Print a human-readable summary instead of JSON")
    .option("--keep-paused", "Skip Debugger.resume after capture; Node may resume when this CLI disconnects")
    .option("--fail-on-unmatched-pause", "Fail immediately if the target pauses somewhere else")
    .action(async (opts: SnapshotCommandOptions): Promise<void> => {
      await handleSnapshot(opts);
    });
}

function registerLog(program: Command): void {
  applyTargetOptions(
    program.command("log").description("Stream a non-pausing logpoint: log an expression each time a line executes"),
  )
    .requiredOption("--at <file:line>", "Logpoint location, e.g. src/handler.ts:42")
    .requiredOption("--expr <expression>", "JavaScript expression to log on each hit")
    .option("--remote-root <value>", "Path-mapping anchor: literal path or regex:<pattern> / /pattern/flags")
    .option("--duration <seconds>", "Stop streaming after N seconds (default: run until SIGINT)")
    .option("--no-json", "Print human-readable lines instead of JSON Lines")
    .action(async (opts: LogCommandOptions): Promise<void> => {
      await handleLog(opts);
    });
}

function registerEval(program: Command): void {
  applyTargetOptions(
    program.command("eval").description("Evaluate an expression against the global Runtime"),
  )
    .requiredOption("--expr <expression>", "JavaScript expression to evaluate")
    .option("--no-json", "Print only the resulting value, not the full CDP envelope")
    .action(async (opts: EvalCommandOptions): Promise<void> => {
      await handleEval(opts);
    });
}

function registerListScripts(program: Command): void {
  applyTargetOptions(
    program.command("list-scripts").description("Print the scripts the V8 instance currently knows about"),
  )
    .option("--no-json", "Print scriptId<TAB>url instead of JSON")
    .action(async (opts: ListScriptsCommandOptions): Promise<void> => {
      await handleListScripts(opts);
    });
}

function registerAttach(program: Command): void {
  applyTargetOptions(
    program.command("attach").description("Connect, fetch the inspector version, and disconnect (smoke-test)"),
  )
    .option("--no-json", "Print a multi-line summary instead of JSON")
    .action(async (opts: AttachCommandOptions): Promise<void> => {
      await handleAttach(opts);
    });
}
