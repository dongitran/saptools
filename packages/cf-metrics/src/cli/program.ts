import { attachSelfUpdate, registerSelfUpdateCommand } from "@saptools/core";
import type { AttachSelfUpdateOptions } from "@saptools/core";
import { Command } from "commander";

import { CLI_NAME, CLI_VERSION, ENV_PREFIX, PACKAGE_NAME, saptoolsRootFromEnv } from "../config.js";

import { registerFieldsCommand } from "./commands/fields.js";
import { registerHistoryCommand } from "./commands/history.js";
import { registerMappingCommand } from "./commands/mapping.js";
import { registerNamesCommand } from "./commands/names.js";
import { registerSampleCommand } from "./commands/sample.js";
import { registerSnapshotCommand } from "./commands/snapshot.js";
import { registerTopCommand } from "./commands/top.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerCredentialCommands } from "./credentials.js";
import { printNotice } from "./output.js";
import { registerResultCommands } from "./results.js";

/**
 * Every command first checks npm (at most once an hour) and, when a newer
 * release exists, installs it and re-runs itself on it; notices go through
 * `printNotice` so they share the `cf-metrics:` stderr prefix. The test-only
 * `CF_METRICS_SAPTOOLS_ROOT` relocates the update state along with the other
 * stores. See `@saptools/core` for the policy switches.
 */
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

  const selfUpdate = selfUpdateOptions();
  attachSelfUpdate(program, selfUpdate);

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
  registerSelfUpdateCommand(program, selfUpdate);

  return program;
}
