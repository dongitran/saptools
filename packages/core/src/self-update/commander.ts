import type { Command } from "commander";

import { SELF_UPDATE_COMMAND } from "./policy.js";
import { inspectSelfUpdate, runSelfUpdate } from "./run.js";
import type { SelfUpdateOptions, SelfUpdateOutcome, SelfUpdateStatus } from "./run.js";
import { isNewerRelease } from "./semver.js";

export type AttachSelfUpdateOptions = Omit<SelfUpdateOptions, "commandPath" | "manual" | "reexec">;

export interface SelfUpdateCommandOptions extends AttachSelfUpdateOptions {
  /** Where the status lines go; defaults to stdout. */
  readonly print?: (line: string) => void;
}

/** `credential list` for a nested subcommand, `` for the root action. */
export function commandPathOf(command: Command): string {
  const names: string[] = [];
  let current: Command = command;
  while (current.parent !== null) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
}

/**
 * Run the self-updater before every action of `program`. `--help` and
 * `--version` never reach an action, so they never trigger it; the
 * `self-update` command and `skipCommands` are excluded by the policy.
 */
export function attachSelfUpdate(program: Command, options: AttachSelfUpdateOptions): void {
  program.hook("preAction", async (_thisCommand: Command, actionCommand: Command): Promise<void> => {
    await runSelfUpdate({ ...options, commandPath: commandPathOf(actionCommand) });
  });
}

export function formatSelfUpdateStatus(status: SelfUpdateStatus): readonly string[] {
  const latest =
    status.latest ?? (status.checkError === undefined ? "unknown" : `unknown (${status.checkError})`);
  const install = status.location.packageDirectory === undefined ? status.location.detail : `${status.location.kind} ${status.location.packageDirectory}`;
  return [
    `package=${status.packageName}`,
    `installed=${status.installed}`,
    `latest=${latest}`,
    `policy=${status.policy.policy} (${status.policy.reason})`,
    `install=${install}`,
    `writable=${status.location.writable ? "yes" : "no"}`,
    `registry=${status.registryUrl}`,
    `state=${status.statePath}`,
  ];
}

export function describeOutcome(outcome: SelfUpdateOutcome): string {
  switch (outcome.kind) {
    case "current":
      return `current (${outcome.latest} is the newest release)`;
    case "updated":
      return `updated ${outcome.from} -> ${outcome.to}`;
    case "notified":
      return `not installed (${outcome.reason})`;
    case "failed":
      return `failed (${outcome.reason})`;
    case "skipped":
      return `skipped (${outcome.reason})`;
  }
}

async function runSelfUpdateCommand(options: SelfUpdateCommandOptions, checkOnly: boolean): Promise<void> {
  const print =
    options.print ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const status = await inspectSelfUpdate(options);
  for (const line of formatSelfUpdateStatus(status)) {
    print(line);
  }
  if (checkOnly) {
    const verdict = status.latest === undefined ? "unknown" : isNewerRelease(status.latest, status.installed) ? "update-available" : "current";
    print(`result=${verdict}`);
    return;
  }
  const outcome = await runSelfUpdate({ ...options, manual: true, reexec: false });
  print(`result=${describeOutcome(outcome)}`);
  if (outcome.kind === "failed") {
    process.exitCode = 1;
  }
}

/** `<bin> self-update [--check]`: a forced check and install for humans and agents who do not want to wait for the hourly check. */
export function registerSelfUpdateCommand(program: Command, options: SelfUpdateCommandOptions): void {
  program
    .command(SELF_UPDATE_COMMAND)
    .description("check npm for a newer release and install it now; every other command does this automatically (at most once an hour)")
    .option("--check", "report whether a newer release exists without installing it")
    .action(async (flags: { readonly check?: boolean }): Promise<void> => {
      await runSelfUpdateCommand(options, flags.check === true);
    });
}
