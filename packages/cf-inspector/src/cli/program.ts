import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import type {
  AttachCommandOptions,
  CheckBreakpointCommandOptions,
  EvalCommandOptions,
  ExceptionCommandOptions,
  ListScriptsCommandOptions,
  ListTargetsCommandOptions,
  LogCommandOptions,
  SnapshotCommandOptions,
  WatchCommandOptions,
} from "./commandTypes.js";
import { handleAttach } from "./commands/attach.js";
import { handleCheckBreakpoint } from "./commands/checkBreakpoint.js";
import { handleEval } from "./commands/eval.js";
import { handleException } from "./commands/exception.js";
import { handleListScripts, handleListTargets } from "./commands/listScripts.js";
import { handleLog } from "./commands/log.js";
import { handleSnapshot } from "./commands/snapshot.js";
import { handleWatch } from "./commands/watch.js";

function applyTargetOptions(
  cmd: Command,
  options: {
    readonly includeTarget?: boolean;
    readonly includeTimeout?: boolean;
    readonly includeWorker?: boolean;
  } = {},
): Command {
  const withEndpointOptions = cmd
    .option("--port <number>", "Local port the inspector or tunnel listens on")
    .option("--host <host>", "Hostname (default: 127.0.0.1)", "127.0.0.1")
    .option("--region <key>", "CF region key (required with --app)")
    .option("--api-endpoint <url>", "CF API endpoint override for --region")
    .option("--org <name>", "CF org name (required with --app)")
    .option("--space <name>", "CF space name (required with --app)")
    .option(
      "--app <name>",
      "CF app name; requires explicit --region/--org/--space (ambient cf target is ignored)",
    );
  const withTargetOption = options.includeTarget === false
    ? withEndpointOptions
    : withEndpointOptions.option(
        "--target <index>",
        "Inspector target index from /json/list (default: 0)",
      );
  const withWorkerOption = options.includeWorker === false
    ? withTargetOption
    : withTargetOption
        .option("--worker <index>", "NodeWorker sub-session index listed by list-targets")
        .option("--worker-id <id>", "Stable NodeWorker workerId listed by list-targets")
        .option("--main-only", "Attach only to the main isolate and ignore workers");
  return options.includeTimeout === false
    ? withWorkerOption
    : withWorkerOption.option("--timeout <seconds>", "Timeout for CF tunnel readiness in seconds (default: 180)");
}

const collectStrings = (value: string, prev: readonly string[] = []): readonly string[] => [
  ...prev,
  value,
];

function readPackageVersion(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(current, "package.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (record["name"] === "@saptools/cf-inspector" && typeof record["version"] === "string") {
          return record["version"];
        }
      }
    } catch {
      // Keep walking toward the package root. The source path and bundled CLI
      // live at different depths, so one failed candidate is expected.
    }
    current = dirname(current);
  }
  throw new Error("Unable to read @saptools/cf-inspector package version");
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();
  program
    .name("cf-inspector")
    .version(readPackageVersion())
    .description("Drive a Node.js inspector from the command line — set breakpoints, capture snapshots, evaluate expressions");

  registerSnapshot(program);
  registerLog(program);
  registerWatch(program);
  registerException(program);
  registerCheckBreakpoint(program);
  registerEval(program);
  registerListScripts(program);
  registerListTargets(program);
  registerAttach(program);

  await program.parseAsync([...argv]);
}

function registerCheckBreakpoint(program: Command): void {
  applyTargetOptions(
    program.command("check-breakpoint").description(
      "Report whether a loaded script can break at a file:line location",
    ),
  )
    .requiredOption("--bp <file:line>", "Source location to check")
    .option("--remote-root <value>", "Path-mapping anchor: literal path or regex:<pattern> / /pattern/flags")
    .option("--no-json", "Print a human-readable result instead of JSON")
    .action(async (opts: CheckBreakpointCommandOptions): Promise<void> => {
      await handleCheckBreakpoint(opts);
    });
}

function registerSnapshot(program: Command): void {
  applyTargetOptions(
    program.command("snapshot").description("Set a breakpoint, wait for it to hit, capture expressions, and resume"),
    { includeTimeout: false },
  )
    .option("--bp <file:line>", "Breakpoint location (repeatable; first hit wins), e.g. src/handler.ts:42", collectStrings, [] as readonly string[])
    .option("--capture <expr,…>", "Top-level comma-separated expressions to evaluate in the paused frame")
    .option("--setup-eval <expr>", "Evaluate a global setup expression before breakpoint setup (repeatable)", collectStrings, [] as readonly string[])
    .option("--timeout <seconds>", "How long to wait for the breakpoint to hit (default: 30)")
    .option("--max-value-length <chars>", "Maximum characters per captured value before truncation (default: 131072)")
    .option("--remote-root <value>", "Path-mapping anchor: literal path or regex:<pattern> / /pattern/flags")
    .option("--condition <expr>", "Only pause when this JS expression evaluates truthy in the paused frame")
    .option("--hit-count <n>", "Only pause after the breakpoint has been hit N or more times")
    .option("--stack-depth <n>", "Walk this many call frames when capturing (default: 1, only top frame)")
    .option("--stack-captures <expr,…>", "Expressions to evaluate on each call frame in the stack")
    .option("--allow-mutation", "Allow mutation-capable captures and native breakpoint conditions to run")
    .option("--include-scopes", "Include expanded paused-frame scopes in the snapshot")
    .option("--no-json", "Print a human-readable summary instead of JSON")
    .option("--quiet", "Suppress progress messages on stderr")
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
    .option("--max-events <n>", "Stop streaming after emitting N log events")
    .option("--hit-count <n>", "Start logging once the line has been hit N or more times")
    .option("--condition <expr>", "Only log when this JS expression evaluates truthy on the inspectee")
    .option("--max-value-length <chars>", "Maximum characters per log value before truncation (default: 4096)")
    .option("--no-json", "Print human-readable lines instead of JSON Lines")
    .action(async (opts: LogCommandOptions): Promise<void> => {
      await handleLog(opts);
    });
}

function registerWatch(program: Command): void {
  applyTargetOptions(
    program.command("watch").description("Stream a snapshot per breakpoint hit (multi-shot watch); resume between hits"),
    { includeTimeout: false },
  )
    .option("--bp <file:line>", "Breakpoint location (repeatable), e.g. src/handler.ts:42", collectStrings, [] as readonly string[])
    .option("--capture <expr,…>", "Top-level comma-separated expressions to evaluate per hit")
    .option("--setup-eval <expr>", "Evaluate a global setup expression before breakpoint setup (repeatable)", collectStrings, [] as readonly string[])
    .option("--condition <expr>", "Only emit hits where this JS expression evaluates truthy")
    .option("--hit-count <n>", "Start emitting after the line has been hit N or more times")
    .option("--remote-root <value>", "Path-mapping anchor: literal path or regex:<pattern> / /pattern/flags")
    .option("--duration <seconds>", "Stop streaming after N seconds (default: run until SIGINT)")
    .option("--max-events <n>", "Stop streaming after emitting N watch events")
    .option("--timeout <seconds>", "How long to wait for the next hit before giving up (default: 30)")
    .option("--max-value-length <chars>", "Maximum characters per captured value before truncation (default: 4096)")
    .option("--stack-depth <n>", "Walk this many call frames per hit (default: 1)")
    .option("--stack-captures <expr,…>", "Expressions to evaluate on each call frame")
    .option("--allow-mutation", "Allow mutation-capable captures and native breakpoint conditions to run")
    .option("--include-scopes", "Include expanded paused-frame scopes per hit")
    .option("--no-json", "Print human-readable lines instead of JSON Lines")
    .action(async (opts: WatchCommandOptions): Promise<void> => {
      await handleWatch(opts);
    });
}

function registerException(program: Command): void {
  applyTargetOptions(
    program.command("exception").description("Pause on a thrown exception, capture the value and frame, then resume"),
    { includeTimeout: false },
  )
    .option("--type <state>", "Pause type: uncaught (default), caught, or all")
    .option("--capture <expr,…>", "Top-level comma-separated expressions to evaluate in the paused frame")
    .option("--remote-root <value>", "Path-mapping anchor: literal path or regex:<pattern> / /pattern/flags")
    .option("--timeout <seconds>", "How long to wait for an exception (default: 30)")
    .option("--max-value-length <chars>", "Maximum characters per captured value before truncation (default: 131072)")
    .option("--stack-depth <n>", "Walk this many call frames when capturing (default: 1)")
    .option("--stack-captures <expr,…>", "Expressions to evaluate on each call frame in the stack")
    .option("--allow-mutation", "Allow mutation-capable capture expressions to run")
    .option("--include-scopes", "Include expanded paused-frame scopes in the snapshot")
    .option("--keep-paused", "Skip Debugger.resume after capture; Node may resume when this CLI disconnects")
    .option("--no-json", "Print a human-readable summary instead of JSON")
    .action(async (opts: ExceptionCommandOptions): Promise<void> => {
      await handleException(opts);
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
    .option("--filter <pattern>", "Only include script URLs matching this pattern")
    .option("--no-json", "Print scriptId<TAB>url instead of JSON")
    .action(async (opts: ListScriptsCommandOptions): Promise<void> => {
      await handleListScripts(opts);
    });
}

function registerListTargets(program: Command): void {
  applyTargetOptions(
    program.command("list-targets").description(
      "List raw /json/list targets and nested workers; use --target or --worker on other commands",
    ),
    { includeTarget: false, includeWorker: false },
  )
    .option(
      "--no-json",
      "Print tab-separated target/worker rows: index, kind, type, title, and URL",
    )
    .action(async (opts: ListTargetsCommandOptions): Promise<void> => {
      await handleListTargets(opts);
    });
}

function registerAttach(program: Command): void {
  applyTargetOptions(
    program.command("attach").description("Connect, fetch the inspector version, and disconnect (smoke-test)"),
    { includeTarget: false, includeWorker: false },
  )
    .option("--no-json", "Print a multi-line summary instead of JSON")
    .action(async (opts: AttachCommandOptions): Promise<void> => {
      await handleAttach(opts);
    });
}
