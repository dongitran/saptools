import type { Command } from "commander";

import { CfMetricsError } from "../errors.js";
import { formatResult } from "../format.js";
import {
  clearResultSessions,
  listResultSessions,
  pruneResultSessions,
  readResultSession,
  resultStoreOptionsFromEnv,
} from "../result-store.js";

import { parseFormat, print, printNotice } from "./output.js";
import { withFormatOption } from "./shared-options.js";

function parseRowNumber(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CfMetricsError("CONFIG", `Expected a positive row number but received "${value}"`);
  }
  return Number(trimmed);
}

interface ShowOptions {
  readonly format: string;
  readonly row?: number;
}

async function runShow(ref: string, options: ShowOptions): Promise<void> {
  const session = await readResultSession(ref, resultStoreOptionsFromEnv());
  if (options.row === undefined) {
    print(formatResult(session.rows, parseFormat(options.format)));
    return;
  }
  const row = session.rows[options.row - 1];
  if (row === undefined) {
    throw new CfMetricsError("RESULT_NOT_FOUND", `Row ${String(options.row)} does not exist in saved result "${ref}"`);
  }
  print(JSON.stringify(row, null, 2));
}

async function runList(): Promise<void> {
  const summaries = await listResultSessions(resultStoreOptionsFromEnv());
  print(
    formatResult(
      summaries.map((summary) => ({
        REF: summary.ref,
        COMMAND: summary.command,
        ROWS: summary.rowCount,
        CREATED_AT: summary.createdAt,
        EXPIRES_AT: summary.expiresAt,
      })),
      "table",
    ),
  );
}

async function runPrune(): Promise<void> {
  const outcome = await pruneResultSessions(resultStoreOptionsFromEnv());
  print(`removed=${String(outcome.removed)}`);
  // Kept off stdout so `removed=N` stays the single machine-readable line.
  if (outcome.retainedRefs.length > 0) {
    // Name the refs: a retained session is omitted from `result list` and no
    // command removes one, so the ref is the only way a user can find the file.
    printNotice(
      `${String(outcome.retainedRefs.length)} saved result(s) were left in place because this version ` +
        `could not read them: ${outcome.retainedRefs.join(", ")}`,
    );
  }
  if (outcome.failed > 0) {
    printNotice(`${String(outcome.failed)} expired saved result(s) could not be deleted; check directory permissions`);
    // The only machine-readable health signal this store has. Reporting a
    // partial sweep as success meant `if <cli> result prune; then ...` could
    // never detect a store it had failed to clean.
    process.exitCode = 1;
  }
}

async function runClear(): Promise<void> {
  print(`removed=${String(await clearResultSessions(resultStoreOptionsFromEnv()))}`);
}

export function registerResultCommands(program: Command): void {
  const result = program.command("result").description("inspect saved command refs (from --save)");

  const show = result
    .command("show <ref>")
    .description("show a saved result, or one row's full JSON by number")
    .option("--row <n>", "one-based row number", parseRowNumber);
  withFormatOption(show);
  show.action(async (ref: string, _options: unknown, command: Command) => {
    await runShow(ref, command.opts<ShowOptions>());
  });

  result
    .command("list")
    .description("list active saved refs")
    .action(async () => {
      await runList();
    });
  result
    .command("prune")
    .description("remove expired saved refs")
    .action(async () => {
      await runPrune();
    });
  result
    .command("clear")
    .description("remove all saved refs")
    .action(async () => {
      await runClear();
    });
}
