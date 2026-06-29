import process from "node:process";

import { Command } from "commander";

import { registerCommands } from "./commands.js";

export async function main(argv: readonly string[]): Promise<void> {
  const program = new Command();
  program
    .name("saptools-sharepoint-excel")
    .description("Create, read, and update SharePoint-hosted Excel workbooks");
  registerCommands(program);
  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
