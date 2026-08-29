import type { Command } from "commander";

import { listFlatAttributeKeys } from "../../attributes.js";
import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { CfOtelError } from "../../errors.js";
import { SPANS_SORT_TIEBREAKER } from "../../opensearch-client.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { FieldsOpts } from "../commandTypes.js";
import { emitRows, parseFormat, printNotice } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions } from "../shared-options.js";

function readDisplayString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

async function runFields(traceId: string, spanId: string | undefined, opts: FieldsOpts): Promise<void> {
  const format = parseFormat(opts.format);
  if (spanId !== undefined && opts.name !== undefined) {
    throw new CfOtelError("CONFIG", "Pass either a spanId or --name, not both");
  }
  const filter: Record<string, unknown>[] = [{ term: { traceId } }];
  if (spanId !== undefined) {
    filter.push({ term: { spanId } });
  } else if (opts.name !== undefined) {
    filter.push({ wildcard: { name: { value: opts.name } } });
    if (opts.kind !== undefined) {
      filter.push({ term: { kind: opts.kind } });
    }
  }

  const doc = await withOpenSearchClient(opts, async (client) => {
    const response = await client.search(DEFAULT_INDEX_PATTERN, {
      size: 1,
      query: { bool: { filter } },
      sort: SPANS_SORT_TIEBREAKER,
    });
    return response.hits[0];
  });

  if (doc === undefined) {
    throw new CfOtelError("TRACE_NOT_FOUND", `No matching span found in trace "${traceId}"`);
  }
  const keys = listFlatAttributeKeys(doc._source);
  printNotice(
    `${String(keys.length)} flat attribute keys found ` +
      `(sample spanId=${readDisplayString(doc._source["spanId"])}, name=${readDisplayString(doc._source["name"])})`,
  );
  await emitRows({ command: "fields", format, save: opts.save, rows: keys.map((key) => ({ KEY: key })), compactColumn: "KEY" });
}

export function registerFieldsCommand(program: Command): void {
  const command = program
    .command("fields <traceId> [spanId]")
    .description("list every flat attribute key on a sample span, without guessing field names blind");
  command.option("--name <pattern>", "pick the sample span by name (supports * wildcard) instead of an exact spanId");
  command.option("--kind <kind>", "restrict a --name search to one span kind");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async (traceId: string, spanId: string | undefined) => {
    await runFields(traceId, spanId, command.opts<FieldsOpts>());
  });
}
