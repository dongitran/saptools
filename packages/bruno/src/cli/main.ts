import process from "node:process";

import { confirm, select } from "@inquirer/prompts";
import { Command, Option } from "commander";

import { runBruno } from "../commands/run.js";
import { setupApp } from "../commands/setup-app.js";
import { useContext } from "../commands/use.js";
import { promptForAppSelection } from "../prompts/app-search.js";
import { promptForEnvironments } from "../prompts/environment.js";
import { readContext } from "../state/context.js";

function resolveCollectionDir(explicitCollection: string | undefined, explicitRoot: string | undefined): string {
  if (explicitCollection) {
    return explicitCollection;
  }
  if (explicitRoot) {
    return explicitRoot;
  }
  if (process.env["SAPTOOLS_BRUNO_COLLECTION"]) {
    return process.env["SAPTOOLS_BRUNO_COLLECTION"];
  }
  if (process.env["SAPTOOLS_BRUNO_ROOT"]) {
    return process.env["SAPTOOLS_BRUNO_ROOT"];
  }
  return process.cwd();
}

function resolveProgramCollectionDir(program: Command): string {
  const opts = program.opts<{ collection?: string; root?: string }>();
  return resolveCollectionDir(opts.collection, opts.root);
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function registerSetupAppCommand(program: Command): void {
  program
    .command("setup-app")
    .description("Interactively scaffold a bruno app folder and seed __cf_* variables")
    .action(async (): Promise<void> => {
      const result = await setupApp({
        root: resolveProgramCollectionDir(program),
        prompts: {
          selectRegion: async (choices) => await select({ message: "Select region", choices: [...choices] }),
          selectOrg: async (choices) => await select({ message: "Select org", choices: [...choices] }),
          selectSpace: async (choices) => await select({ message: "Select space", choices: [...choices] }),
          selectApp: async (choices) => await promptForAppSelection(choices),
          confirmCreate: async (path) => await confirm({ message: `Create ${path}?`, default: true }),
          selectEnvironments: async (opts) => await promptForEnvironments(opts),
        },
        log: writeLine,
      });
      if (!result.created) {
        writeLine("Aborted.");
        return;
      }
      writeLine(`✔ App folder ready at ${result.appPath}`);
    });
}

async function resolveRunTarget(target: string | undefined): Promise<string> {
  if (target) {
    return target;
  }

  const ctx = await readContext();
  if (!ctx) {
    throw new Error(
      "No target specified and no default context is set. Run `saptools-bruno use <region/org/space/app>` first.",
    );
  }
  return `${ctx.region}/${ctx.org}/${ctx.space}/${ctx.app}`;
}

function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run a bruno request or folder, auto-injecting an XSUAA token")
    .argument("[target]", "Shorthand path (region/org/space/app[/folder/file.bru]) or real path")
    .option("-e, --env <name>", "Environment name (default: context or first)")
    .action(
      async (
        target: string | undefined,
        opts: { env?: string },
      ): Promise<void> => {
        const result = await runBruno({
          root: resolveProgramCollectionDir(program),
          target: await resolveRunTarget(target),
          ...(opts.env ? { environment: opts.env } : {}),
          log: writeLine,
        });
        process.exit(result.code);
      },
    );
}

function registerUseCommand(program: Command): void {
  program
    .command("use")
    .description("Set the default CF context (region/org/space/app) for future `run` calls")
    .argument("<shorthand>", "region/org/space/app")
    .option("--no-verify", "Skip verifying the context against the cached CF structure")
    .action(async (shorthand: string, opts: { verify?: boolean }): Promise<void> => {
      const ctx = await useContext({
        shorthand,
        verify: opts.verify !== false,
      });
      process.stdout.write(`✔ Default context set to ${ctx.region}/${ctx.org}/${ctx.space}/${ctx.app}\n`);
    });
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("saptools-bruno")
    .description("Smart runner for Bruno with CF-aware env metadata and automatic token injection")
    .addOption(new Option("--collection <dir>", "Bruno collection directory (default: SAPTOOLS_BRUNO_COLLECTION or cwd)"))
    .addOption(new Option("--root <dir>", "Legacy alias for --collection").hideHelp());

  registerSetupAppCommand(program);
  registerRunCommand(program);
  registerUseCommand(program);

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}
