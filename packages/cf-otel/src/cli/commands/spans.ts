import type { Command } from "commander";

import { parseAttrFilter, resolveAndValidateAttrFilters } from "../../attr-filter.js";
import { DEFAULT_INDEX_PATTERN, MAX_SPANS_FETCHED, SPANS_PAGE_SIZE } from "../../config.js";
import { CfOtelError } from "../../errors.js";
import type { OutputRow } from "../../format.js";
import { searchAfterAll } from "../../opensearch-client.js";
import { buildSpanBoolQuery } from "../../query-builder.js";
import { hitToSpan } from "../../span-mapper.js";
import type { Span } from "../../types.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { SpansOpts } from "../commandTypes.js";
import { formatDurationNanos } from "../display.js";
import { emitRows, parseFormat, printNotice } from "../output.js";
import {
  withAttrOptions,
  withCredentialOptions,
  withFormatOption,
  withLimitOption,
  withSaveOption,
  withTargetOptions,
} from "../shared-options.js";

const FIELD_COLUMN_BUILDERS: readonly { field: string; build: (span: Span) => OutputRow }[] = [
  { field: "spanId", build: (span) => ({ SPAN_ID: span.spanId }) },
  { field: "parentSpanId", build: (span) => ({ PARENT_SPAN_ID: span.parentSpanId ?? "" }) },
  { field: "name", build: (span) => ({ NAME: span.name }) },
  { field: "kind", build: (span) => ({ KIND: span.kind }) },
  { field: "serviceName", build: (span) => ({ SERVICE: span.serviceName }) },
  { field: "startTime", build: (span) => ({ START_TIME: span.startTime }) },
  {
    field: "durationInNanos",
    build: (span) => ({ DURATION: formatDurationNanos(span.durationInNanos), DURATION_NANOS: span.durationInNanos }),
  },
  { field: "status.code", build: (span) => ({ STATUS_CODE: span.statusCode ?? 0 }) },
];

/**
 * Every displayable field name, and also the default selection. Derived from
 * the column builders rather than written out a second time: the two lists
 * used to be maintained by hand, and because `buildRow` keeps only the
 * builders whose `field` appears in the requested list, any name the builders
 * did not know produced an empty row instead of an error.
 */
const SPAN_FIELD_NAMES: readonly string[] = FIELD_COLUMN_BUILDERS.map((entry) => entry.field);

function buildRow(span: Span, fields: readonly string[]): OutputRow {
  let row: OutputRow = {};
  for (const entry of FIELD_COLUMN_BUILDERS) {
    if (fields.includes(entry.field)) {
      row = { ...row, ...entry.build(span) };
    }
  }
  return row;
}

/**
 * Resolve `--fields`, rejecting names no column builder knows. Without this
 * check an unknown name matched nothing and the command printed a full set of
 * empty rows at exit 0 — and because the name is also forwarded as an
 * OpenSearch `_source` filter, the documents really did come back without it,
 * so there was nothing downstream that could notice.
 */
function parseFieldsOption(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return SPAN_FIELD_NAMES;
  }
  const requested = value.split(",").map((field) => field.trim()).filter((field) => field.length > 0);
  if (requested.length === 0) {
    throw new CfOtelError(
      "CONFIG",
      `--fields "${value}" names no fields; expected a comma-separated subset of: ${SPAN_FIELD_NAMES.join(", ")}`,
    );
  }
  const unknown = requested.filter((field) => !SPAN_FIELD_NAMES.includes(field));
  if (unknown.length > 0) {
    throw new CfOtelError(
      "CONFIG",
      `--fields ${unknown.length === 1 ? "has an unknown field" : "has unknown fields"} ` +
        `${unknown.map((field) => `"${field}"`).join(", ")}; expected a comma-separated subset of: ${SPAN_FIELD_NAMES.join(", ")}`,
    );
  }
  return requested;
}

async function runSpans(traceId: string, opts: SpansOpts): Promise<void> {
  const format = parseFormat(opts.format);
  const attrs = opts.attr.map(parseAttrFilter);
  const fields = parseFieldsOption(opts.fields);
  // traceId/spanId are always fetched regardless of --fields: hitToSpan
  // requires both unconditionally to construct a Span at all, even when the
  // user only wants to *display* a narrower column set via --fields.
  const fetchFields = [...new Set([...fields, "traceId", "spanId"])];

  const { spans, totalHits, truncated } = await withOpenSearchClient(opts, async (client) => {
    const resolvedAttrs = await resolveAndValidateAttrFilters(client, DEFAULT_INDEX_PATTERN, attrs);
    const query = buildSpanBoolQuery({ traceIds: [traceId], attrs: resolvedAttrs, errorsOnly: opts.errorsOnly });
    const paged = await searchAfterAll(client, DEFAULT_INDEX_PATTERN, { query, _source: fetchFields }, SPANS_PAGE_SIZE, MAX_SPANS_FETCHED);
    return { spans: paged.hits.map(hitToSpan), totalHits: paged.totalHits, truncated: paged.truncated };
  });

  // A limit of 0 means "all" (consistent with detached/top), not zero rows.
  const displayed = opts.limit === 0 ? spans : spans.slice(0, opts.limit);
  await emitRows({ command: "spans", format, save: opts.save, rows: displayed.map((span) => buildRow(span, fields)) });

  const omitted = spans.length - displayed.length;
  const truncationNote = truncated ? "truncated" : "not truncated";
  printNotice(
    omitted > 0
      ? `... ${String(omitted)} more (total: ${String(totalHits)}, ${truncationNote})`
      : `total: ${String(totalHits)}, ${truncationNote}`,
  );
}

export function registerSpansCommand(program: Command): void {
  const command = program.command("spans <traceId>").description("fetch every span in one trace");
  command.option("--fields <list>", "comma-separated field list", SPAN_FIELD_NAMES.join(","));
  withAttrOptions(command);
  withLimitOption(command, Number.MAX_SAFE_INTEGER, "maximum rows to display (default: all fetched; 0 also means all)");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async (traceId: string) => {
    await runSpans(traceId, command.opts<SpansOpts>());
  });
}
