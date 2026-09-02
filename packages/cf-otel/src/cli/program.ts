import { attachSelfUpdate, registerSelfUpdateCommand } from "@saptools/core";
import type { AttachSelfUpdateOptions } from "@saptools/core";
import { Command } from "commander";

import { CLI_NAME, CLI_VERSION, ENV_PREFIX, PACKAGE_NAME } from "../config.js";

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
import { printNotice } from "./output.js";
import { registerResultCommands } from "./results.js";

/** Every command first checks npm (at most once an hour) and re-runs itself on a newer release; see `@saptools/core`. */
const SELF_UPDATE: AttachSelfUpdateOptions = {
  packageName: PACKAGE_NAME,
  currentVersion: CLI_VERSION,
  binName: CLI_NAME,
  envPrefix: ENV_PREFIX,
  notice: printNotice,
};

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
  attachSelfUpdate(program, SELF_UPDATE);

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
  registerSelfUpdateCommand(program, SELF_UPDATE);

  return program;
}
