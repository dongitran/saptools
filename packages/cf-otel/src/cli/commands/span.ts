import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN, MAX_SPANS_FETCHED, SPANS_PAGE_SIZE } from "../../config.js";
import { CfOtelError } from "../../errors.js";
import { SPANS_SORT_TIEBREAKER, searchAfterAll } from "../../opensearch-client.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { SpanOpts } from "../commandTypes.js";
import { emitRows, parseFormat, printNotice } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions } from "../shared-options.js";

function validateOptions(spanId: string | undefined, opts: SpanOpts): void {
  if (spanId !== undefined && opts.name !== undefined) {
    throw new CfOtelError("CONFIG", "Pass either a spanId or --name, not both");
  }
  if (spanId === undefined && opts.name === undefined) {
    throw new CfOtelError("CONFIG", "span requires either a spanId or --name <pattern>");
  }
  if (opts.first && opts.all) {
    throw new CfOtelError("CONFIG", "Use only one of --first or --all");
  }
}

async function runSpan(traceId: string, spanId: string | undefined, opts: SpanOpts): Promise<void> {
  validateOptions(spanId, opts);
  const format = parseFormat(opts.format);

  const { docs, truncated } = await withOpenSearchClient(opts, async (client) => {
    if (spanId !== undefined) {
      const response = await client.search(DEFAULT_INDEX_PATTERN, {
        size: 1,
        query: { bool: { filter: [{ term: { traceId } }, { term: { spanId } }] } },
      });
      return { docs: response.hits.map((hit) => hit._source), truncated: false };
    }

    const filter: Record<string, unknown>[] = [{ term: { traceId } }, { wildcard: { name: { value: opts.name ?? "*" } } }];
    if (opts.kind !== undefined) {
      filter.push({ term: { kind: opts.kind } });
    }
    if (!opts.all) {
      const response = await client.search(DEFAULT_INDEX_PATTERN, {
        size: 1,
        query: { bool: { filter } },
        sort: SPANS_SORT_TIEBREAKER,
      });
      return { docs: response.hits.map((hit) => hit._source), truncated: false };
    }
    const paged = await searchAfterAll(client, DEFAULT_INDEX_PATTERN, { query: { bool: { filter } } }, SPANS_PAGE_SIZE, MAX_SPANS_FETCHED);
    return { docs: paged.hits.map((hit) => hit._source), truncated: paged.truncated };
  });

  if (docs.length === 0) {
    throw new CfOtelError("TRACE_NOT_FOUND", `No matching span found in trace "${traceId}"`);
  }
  await emitRows({ command: "span", format, save: opts.save, rows: docs });
  if (truncated) {
    printNotice("results were truncated — narrow --name/--kind or use spans/find instead");
  }
}

export function registerSpanCommand(program: Command): void {
  const command = program
    .command("span <traceId> [spanId]")
    .description("fetch one span's full, unfiltered document, by ID or by name/kind match")
    .option("--name <pattern>", "find by span name (supports * wildcard) when spanId is not known")
    .option("--kind <kind>", "restrict a --name search to one span kind, e.g. SPAN_KIND_SERVER")
    .option("--first", "return only the first match (deterministic, sorted by startTime then spanId)", false)
    .option("--all", "return every match", false);
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async (traceId: string, spanId: string | undefined) => {
    await runSpan(traceId, spanId, command.opts<SpanOpts>());
  });
}
