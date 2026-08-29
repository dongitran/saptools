import { Command } from "commander";

import { CLI_NAME, CLI_VERSION } from "../config.js";

import { registerCountCommand } from "./commands/count.js";
import { registerDetachedCommand } from "./commands/detached.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerFieldsCommand } from "./commands/fields.js";
import { registerFindCommand } from "./commands/find.js";
import { registerGapsCommand } from "./commands/gaps.js";
import { registerMappingCommand } from "./commands/mapping.js";
import { registerSampleCommand } from "./commands/sample.js";
import { registerSelftimeCommand } from "./commands/selftime.js";
import { registerSpanCommand } from "./commands/span.js";
import { registerSpansCommand } from "./commands/spans.js";
import { registerTopCommand } from "./commands/top.js";
import { registerResultCommands } from "./results.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description(
      "Query and analyze OpenTelemetry trace spans already ingested into SAP Cloud Logging's OpenSearch " +
        "backend. Read-only, post-hoc — never instruments a running process (see cf-inspector/cf-live-trace " +
        "for that) and never mutates application data.",
    )
    .version(CLI_VERSION);

  registerSampleCommand(program);
  registerMappingCommand(program);
  registerFindCommand(program);
  registerTopCommand(program);
  registerCountCommand(program);
  registerSpansCommand(program);
  registerSpanCommand(program);
  registerFieldsCommand(program);
  registerSelftimeCommand(program);
  registerGapsCommand(program);
  registerDetachedCommand(program);
  registerDiffCommand(program);
  registerResultCommands(program);

  return program;
}
