import process from "node:process";

import { Command } from "commander";

import { registerCommands } from "./commands.js";

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();

  program
    .name("saptools-sharepoint-check")
    .description(
      "Diagnose SharePoint access via Microsoft Graph: auth, drives, folder tree, layout, write probe",
    );

  registerCommands(program);

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}
