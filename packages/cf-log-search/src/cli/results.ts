import { clearResultSessions, listResultSessions, pruneResultSessions, readResultSession } from "@saptools/core";
import type { Command } from "commander";

import { CLI_NAME, saptoolsRootFromEnv } from "../config.js";
import { formatResult } from "../format.js";

import { parseFormat, print } from "./output.js";
import { withFormatOption } from "./shared-options.js";

function storeOptions(): { readonly cliName: string; readonly saptoolsRoot?: string } {
  const root = saptoolsRootFromEnv();
  return { cliName: CLI_NAME, ...(root === undefined ? {} : { saptoolsRoot: root }) };
}

interface ShowOptions {
  readonly format: string;
}

async function runShow(ref: string, options: ShowOptions): Promise<void> {
  const session = await readResultSession<Record<string, unknown>>(ref, storeOptions());
  print(formatResult(session.rows as Record<string, unknown>[], parseFormat(options.format)));
}

interface ListOptions {
  readonly format: string;
}

async function runList(options: ListOptions): Promise<void> {
  const sessions = await listResultSessions(storeOptions());
  print(
    formatResult(
      sessions.map((session) => ({ REF: session.ref, CREATED_AT: session.createdAt, EXPIRES_AT: session.expiresAt, COMMAND: session.command, ROWS: session.rowCount })),
      parseFormat(options.format),
    ),
  );
}

async function runPrune(): Promise<void> {
  const outcome = await pruneResultSessions(storeOptions());
  print(`removed=${String(outcome.removed)} failed=${String(outcome.failed)} retained=${String(outcome.retainedRefs.length)} stranded_removed=${String(outcome.strandedRemoved)}`);
}

async function runClear(): Promise<void> {
  print(`removed=${String(await clearResultSessions(storeOptions()))}`);
}

export function registerResultCommands(program: Command): void {
  const result = program.command("result").description("inspect or manage saved --save results");

  const show = result.command("show <ref>").description("print a previously saved result by its ref");
  withFormatOption(show);
  show.action(async (ref: string, _options: unknown, command: Command) => {
    await runShow(ref, command.opts<ShowOptions>());
  });

  const list = result.command("list").description("list saved results (metadata only, not their rows)");
  withFormatOption(list);
  list.action(async (_options: unknown, command: Command) => {
    await runList(command.opts<ListOptions>());
  });

  result
    .command("prune")
    .description("remove expired saved results and any stranded temp directory from an interrupted save")
    .action(async () => {
      await runPrune();
    });

  result
    .command("clear")
    .description("remove every saved result")
    .action(async () => {
      await runClear();
    });
}
