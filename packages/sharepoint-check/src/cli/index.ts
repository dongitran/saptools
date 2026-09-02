import process from "node:process";

import { attachSelfUpdate, readPackageMetadata, registerSelfUpdateCommand } from "@saptools/core";
import { Command } from "commander";

import { registerCommands } from "./commands.js";

export async function main(argv: readonly string[]): Promise<void> {
  const { version } = readPackageMetadata(import.meta.url, "@saptools/sharepoint-check");
  // Every command first checks npm (at most once an hour) and re-runs itself on a newer release; see `@saptools/core`.
  const selfUpdate = {
    packageName: "@saptools/sharepoint-check",
    currentVersion: version,
    binName: "saptools-sharepoint-check",
    envPrefix: "SHAREPOINT_CHECK",
  };
  const program = new Command();

  program
    .name("saptools-sharepoint-check")
    .description(
      "Diagnose SharePoint access via Microsoft Graph: auth, drives, folder tree, layout, write probe",
    )
    .version(version);
  attachSelfUpdate(program, selfUpdate);

  registerCommands(program);
  registerSelfUpdateCommand(program, selfUpdate);

  await program.parseAsync([...argv]);
}

try {
  await main(process.argv);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}
