import { assertResultStoreWritable, attachSelfUpdate, registerSelfUpdateCommand } from "@saptools/core";
import type { AttachSelfUpdateOptions, ResultStoreOptions } from "@saptools/core";
import { Command } from "commander";

import { CLI_NAME, CLI_VERSION, ENV_PREFIX, PACKAGE_NAME, saptoolsRootFromEnv } from "../config.js";

import type { SaveOpts } from "./commandTypes.js";
import { registerAppsCommand } from "./commands/apps.js";
import { registerCountCommand } from "./commands/count.js";
import { registerErrorsCommand } from "./commands/errors.js";
import { registerFieldsCommand } from "./commands/fields.js";
import { registerLatencyCommand } from "./commands/latency.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerSourcesCommand } from "./commands/sources.js";
import { registerTopRoutesCommand } from "./commands/top-routes.js";
import { registerCredentialCommands } from "./credentials.js";
import { printNotice } from "./output.js";
import { registerResultCommands } from "./results.js";

function selfUpdateOptions(): AttachSelfUpdateOptions {
  const root = saptoolsRootFromEnv();
  return {
    packageName: PACKAGE_NAME,
    currentVersion: CLI_VERSION,
    binName: CLI_NAME,
    envPrefix: ENV_PREFIX,
    notice: printNotice,
    ...(root === undefined ? {} : { saptoolsRoot: root }),
  };
}

function resultStoreOptions(): ResultStoreOptions {
  const root = saptoolsRootFromEnv();
  return { cliName: CLI_NAME, ...(root === undefined ? {} : { saptoolsRoot: root }) };
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description(
      "Historical full-text and structured search over SAP BTP Cloud Foundry application logs already ingested " +
        "into SAP Cloud Logging's OpenSearch backend (logs-cfsyslog-*). Read-only. Complements cf-logs, which is " +
        "bounded by Cloud Foundry's short-lived loggregator buffer and cannot search history.",
    )
    .version(CLI_VERSION);

  const selfUpdate = selfUpdateOptions();
  attachSelfUpdate(program, selfUpdate);

  registerSearchCommand(program);
  registerCountCommand(program);
  registerFieldsCommand(program);
  registerAppsCommand(program);
  registerSourcesCommand(program);
  registerErrorsCommand(program);
  registerLatencyCommand(program);
  registerTopRoutesCommand(program);
  registerResultCommands(program);
  registerCredentialCommands(program);
  registerSelfUpdateCommand(program, selfUpdate);

  // Ported from @saptools/cf-otel's identical hook: every --save command's
  // first act is target resolution + credential discovery (tens of seconds
  // on a real tenant), so a saved-result store that cannot be written should
  // fail before paying for that, not after. `@saptools/core` shipped
  // `assertResultStoreWritable` in Phase 0 for exactly this — cf-metrics
  // never adopted it (Phase 0 was a behavior-preserving refactor, and this
  // is new behavior), but this package has no such constraint. One hook on
  // the root program covers search/fields/apps/sources (this phase's only
  // --save commands) so the check cannot drift out of one of them.
  program.hook("preAction", async (_program, actionCommand) => {
    if (actionCommand.opts<Partial<SaveOpts>>().save === true) {
      await assertResultStoreWritable(resultStoreOptions());
    }
  });

  return program;
}
