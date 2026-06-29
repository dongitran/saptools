import process from "node:process";

import { Command } from "commander";

import { lifecycleCommandArgs, runLifecycle, runScale, scaleCommandArgs } from "./cf.js";
import { buildLifecyclePlan, buildScalePlan, parseInstanceCount, parseRestartStrategy, parseSize } from "./plan.js";
import type { LifecycleAction } from "./types.js";

interface AppFlags {
  readonly app?: string;
  readonly dryRun?: boolean;
}

interface StrategyFlags extends AppFlags {
  readonly strategy?: string;
}

interface ScaleFlags extends StrategyFlags {
  readonly instances?: number;
  readonly memory?: string;
  readonly disk?: string;
  readonly restart?: boolean;
}

function requireApp(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("--app is required.");
  }
  return value;
}

function renderCfCommand(args: readonly string[]): string {
  return `cf ${args.join(" ")}`;
}

function writeDryRun(commands: readonly (readonly string[])[]): void {
  process.stdout.write(commands.map(renderCfCommand).join("\n"));
  process.stdout.write("\n");
}

function addAppOption(command: Command): Command {
  return command
    .requiredOption("-a, --app <name>", "CF app name in the currently targeted org and space")
    .option("--dry-run", "Print the cf command(s) without executing them", false);
}

function addRestartStrategyOption(command: Command): Command {
  return command.option("--strategy <default|rolling>", "Restart strategy when a restart is performed", "default");
}

async function runLifecycleCommand(action: LifecycleAction, flags: StrategyFlags): Promise<void> {
  const plan = buildLifecyclePlan(requireApp(flags.app), action, parseRestartStrategy(flags.strategy));
  if (flags.dryRun === true) {
    writeDryRun([lifecycleCommandArgs(plan)]);
    return;
  }
  await runLifecycle(plan);
  process.stdout.write(`✔ ${action} completed for ${plan.appName}\n`);
}

async function runScaleCommand(flags: ScaleFlags): Promise<void> {
  const plan = buildScalePlan({
    appName: requireApp(flags.app),
    ...(flags.instances === undefined ? {} : { instances: flags.instances }),
    ...(flags.memory === undefined ? {} : { memory: flags.memory }),
    ...(flags.disk === undefined ? {} : { disk: flags.disk }),
    restart: flags.restart === true,
    strategy: parseRestartStrategy(flags.strategy),
  });
  if (flags.dryRun === true) {
    writeDryRun(scaleCommandArgs(plan));
    return;
  }
  await runScale(plan);
  const restartNote = plan.restartAfterScale === undefined ? "" : " and restarted";
  process.stdout.write(`✔ Scaled ${plan.appName}${restartNote}\n`);
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("cf-ops")
    .description("Operate SAP BTP Cloud Foundry apps with focused restart and scaling commands")
    .showHelpAfterError();

  addRestartStrategyOption(
    addAppOption(program.command("restart").description("Restart a CF app; use --strategy rolling for zero-downtime restart")),
  ).action(async (flags: StrategyFlags): Promise<void> => {
    await runLifecycleCommand("restart", flags);
  });

  addAppOption(program.command("restage").description("Restage a CF app after buildpack or environment changes"))
    .action(async (flags: AppFlags): Promise<void> => {
      await runLifecycleCommand("restage", flags);
    });

  addAppOption(program.command("start").description("Start a stopped CF app"))
    .action(async (flags: AppFlags): Promise<void> => {
      await runLifecycleCommand("start", flags);
    });

  addAppOption(program.command("stop").description("Stop a running CF app"))
    .action(async (flags: AppFlags): Promise<void> => {
      await runLifecycleCommand("stop", flags);
    });

  addRestartStrategyOption(addAppOption(program.command("scale").description("Scale instances, memory, or disk for a CF app")))
    .option("-i, --instances <count>", "Desired app instance count", parseInstanceCount)
    .option("-m, --memory <size>", "Memory limit such as 512M or 1G", (value: string): string => parseSize(value, "memory"))
    .option("-k, --disk <size>", "Disk quota such as 1G or 2048M", (value: string): string => parseSize(value, "disk"))
    .option("--restart", "Restart after scaling so memory or disk changes take effect immediately", false)
    .action(async (flags: ScaleFlags): Promise<void> => {
      await runScaleCommand(flags);
    });

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
