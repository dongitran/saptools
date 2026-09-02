import { Command } from "commander";

import { CLI_NAME, CLI_VERSION } from "../config.js";

import { registerFieldsCommand } from "./commands/fields.js";
import { registerHistoryCommand } from "./commands/history.js";
import { registerMappingCommand } from "./commands/mapping.js";
import { registerNamesCommand } from "./commands/names.js";
import { registerSampleCommand } from "./commands/sample.js";
import { registerSnapshotCommand } from "./commands/snapshot.js";
import { registerTopCommand } from "./commands/top.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerCredentialCommands } from "./credentials.js";
import { registerResultCommands } from "./results.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description(
      "Query container CPU/RAM/filesystem and custom OTel metrics already ingested into SAP Cloud Logging's " +
        "OpenSearch backend. Read-only, near-real-time — never instruments a running process (see cf-inspector/" +
        "cf-live-trace for that) and never mutates application data.",
    )
    .version(CLI_VERSION);

  registerSampleCommand(program);
  registerMappingCommand(program);
  registerFieldsCommand(program);
  registerNamesCommand(program);
  registerHistoryCommand(program);
  registerSnapshotCommand(program);
  registerTopCommand(program);
  registerWatchCommand(program);
  registerResultCommands(program);
  registerCredentialCommands(program);

  return program;
}
