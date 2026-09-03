import { attachSelfUpdate, registerSelfUpdateCommand } from "@saptools/core";
import type { AttachSelfUpdateOptions } from "@saptools/core";
import { Command } from "commander";

import { CLI_NAME, CLI_VERSION, ENV_PREFIX, PACKAGE_NAME } from "../config.js";
import { assertResultStoreWritable, resultStoreOptionsFromEnv } from "../result-store.js";

import type { SaveOpts } from "./commandTypes.js";
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

  // Check the saved-result store before the action runs, for the same reason
  // --since/--until are validated ahead of the network: every --save command's
  // first act is a CF login and credential discovery costing tens of seconds,
  // and a store that cannot be written fails just as surely after them as
  // before. One hook on the root program covers all eleven --save commands, so
  // the check cannot drift out of one of them.
  program.hook("preAction", async (_program, actionCommand) => {
    if (actionCommand.opts<Partial<SaveOpts>>().save === true) {
      await assertResultStoreWritable(resultStoreOptionsFromEnv());
    }
  });

  return program;
}
