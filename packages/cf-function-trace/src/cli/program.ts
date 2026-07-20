import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import type { RecordCliFlags } from "./options.js";

export interface ShowCliFlags {
  readonly changesOnly?: boolean;
  readonly from?: string;
  readonly limit?: string;
  readonly maxOutputBytes?: string;
}

export interface StateCliFlags {
  readonly at: string;
  readonly path?: string;
  readonly maxOutputBytes?: string;
}

export interface DiffCliFlags {
  readonly from: string;
  readonly to: string;
  readonly path?: string;
  readonly maxOutputBytes?: string;
}

export interface RunsCliFlags {
  readonly limit?: string;
  readonly maxOutputBytes?: string;
}

export interface CliCommandHandlers {
  plan(file: string, functionSelector: string, flags: RecordCliFlags): Promise<void>;
  record(file: string, functionSelector: string, flags: RecordCliFlags): Promise<void>;
  show(run: string, flags: ShowCliFlags): Promise<void>;
  state(run: string, flags: StateCliFlags): Promise<void>;
  diff(run: string, flags: DiffCliFlags): Promise<void>;
  runs(flags: RunsCliFlags): Promise<void>;
  purge(run: string): Promise<void>;
}

function readPackageVersion(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(current, "package.json"), "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const name: unknown = Reflect.get(parsed, "name");
        const version: unknown = Reflect.get(parsed, "version");
        if (name === "@saptools/cf-function-trace" && typeof version === "string") {
          return version;
        }
      }
    } catch {
      // Source and bundled entry points live at different depths, so missing candidates are expected.
    }
    current = dirname(current);
  }
  throw new Error("Unable to read @saptools/cf-function-trace package version");
}

function addTargetOptions(command: Command): Command {
  return command
    .option("--port <number>", "Local Node inspector port")
    .option("--host <host>", "Local inspector host", "127.0.0.1")
    .option("--target <index>", "Inspector target index")
    .option("--worker <index>", "Node worker index")
    .option("--region <key>", "Cloud Foundry region key")
    .option("--api-endpoint <url>", "Explicit Cloud Foundry API endpoint")
    .option("--org <name>", "Cloud Foundry org")
    .option("--space <name>", "Cloud Foundry space")
    .option("--app <name>", "Cloud Foundry app")
    .option("--process <name>", "Cloud Foundry process")
    .option("--instance <index>", "Cloud Foundry process instance")
    .option("--node-pid <pid>", "Exact remote Node PID")
    .option("--tunnel-port <number>", "Preferred local port for the CF SSH tunnel")
    .option("--confirm-impact", "Confirm that remote tracing pauses app execution", false);
}

function addTraceLimits(command: Command): Command {
  return command
    .option("--timeout <seconds>", "Overall first-hit and trace timeout", "60")
    .option("--max-steps <count>", "Maximum debugger step commands", "200")
    .option("--max-paused-ms <ms>", "Maximum cumulative pause time", "5000")
    .option("--checkpoint-every <count>", "Full-state checkpoint interval", "25")
    .option("--max-object-depth <depth>", "Maximum captured object depth", "4")
    .option("--max-properties <count>", "Maximum properties captured per object", "100")
    .option("--max-nodes <count>", "Maximum captured object nodes per frame", "1000")
    .option("--max-state-bytes <bytes>", "Maximum estimated captured bytes per frame", "2000000")
    .option("--async-stack-depth <count>", "Async call stack depth requested for async traces", "4");
}

function addPlanningOptions(command: Command): Command {
  return command
    .option("--call-depth <depth>", "App-owned synchronous child depth", "0")
    .option("--app-root <path>", "Absolute runtime application root")
    .option(
      "--match <expr>",
      "Only trace an activation whose entry frame satisfies this JavaScript expression (e.g. 'req.data.id===\"42\"')",
    );
}

function registerPlan(program: Command, handlers: CliCommandHandlers): void {
  const command = program.command("plan <file> <function>")
    .description("Resolve an exact loaded runtime function without arming a breakpoint");
  addPlanningOptions(addTargetOptions(command)).action(async (file: string, selector: string, flags: RecordCliFlags) => {
    await handlers.plan(file, selector, flags);
  });
}

function registerRecord(program: Command, handlers: CliCommandHandlers): void {
  const command = program.command("record <file> <function>")
    .description("Record a bounded, redacted function state timeline");
  addTraceLimits(addPlanningOptions(addTargetOptions(command))).action(
    async (file: string, selector: string, flags: RecordCliFlags) => {
      await handlers.record(file, selector, flags);
    },
  );
}

function registerQueries(program: Command, handlers: CliCommandHandlers): void {
  program.command("show <run>")
    .description("Read a bounded page of trace timeline events")
    .option("--changes-only", "Only include events with changed paths")
    .option("--from <seq>", "First event sequence to consider", "0")
    .option("--limit <count>", "Maximum events in this page", "100")
    .option("--max-output-bytes <bytes>", "Output byte limit", "24000")
    .action(async (run: string, flags: ShowCliFlags) => {
      await handlers.show(run, flags);
    });
  program.command("state <run>")
    .description("Read exact reconstructed state at one event sequence")
    .requiredOption("--at <seq>", "State sequence")
    .option("--path <pointer>", "JSON Pointer path")
    .option("--max-output-bytes <bytes>", "Output byte limit", "24000")
    .action(async (run: string, flags: StateCliFlags) => {
      await handlers.state(run, flags);
    });
  program.command("diff <run>")
    .description("Compare reconstructed state at two exact event sequences")
    .requiredOption("--from <seq>", "Starting state sequence")
    .requiredOption("--to <seq>", "Ending state sequence")
    .option("--path <pointer>", "JSON Pointer path")
    .option("--max-output-bytes <bytes>", "Output byte limit", "24000")
    .action(async (run: string, flags: DiffCliFlags) => {
      await handlers.diff(run, flags);
    });
  program.command("runs")
    .description("List locally retained trace runs")
    .option("--limit <count>", "Maximum run summaries", "20")
    .option("--max-output-bytes <bytes>", "Output byte limit", "24000")
    .action(async (flags: RunsCliFlags) => {
      await handlers.runs(flags);
    });
  program.command("purge <run>")
    .description("Permanently remove one local trace run")
    .action(async (run: string) => {
      await handlers.purge(run);
    });
}

export function createProgram(handlers: CliCommandHandlers): Command {
  const program = new Command()
    .name("cf-function-trace")
    .description("Trace bounded runtime state changes for one loaded Node.js function")
    .version(readPackageVersion());
  registerPlan(program, handlers);
  registerRecord(program, handlers);
  registerQueries(program, handlers);
  return program;
}
