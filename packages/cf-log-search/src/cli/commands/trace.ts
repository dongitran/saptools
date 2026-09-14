import type { OpenSearchClient } from "@saptools/core";
import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN, OTEL_SPANS_INDEX_PATTERN } from "../../config.js";
import { mapHitToLogRow } from "../../row-mapper.js";
import type { LogRow } from "../../types.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { TraceOpts } from "../commandTypes.js";
import { emitRows, parseFormat, printNotice } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions } from "../shared-options.js";

/** `vcap_request_id` is a per-hop id — in practice this rarely matches more than one or two documents; bounded generously in case an app's logging framework does echo it onto several lines. */
const TRACE_LOG_LIMIT = 50;
const SPAN_LIMIT = 200;

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

interface SpanSummary {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly startTime: string;
  readonly serviceName: string;
}

function mapHitToSpanSummary(source: Record<string, unknown>): SpanSummary {
  return {
    traceId: readString(source, "traceId"),
    spanId: readString(source, "spanId"),
    name: readString(source, "name"),
    startTime: readString(source, "startTime"),
    serviceName: readString(source, "serviceName"),
  };
}

/**
 * Joins on the RTR row's own `traceId` (already gated by `resolveTraceId` in
 * `row-mapper.ts`), never on `vcap_request_id` — verified live 2026-09-12
 * (see the design doc §8) that a `vcap_request_id` → span-attribute join is
 * both encoding-fragile (the array-valued-attribute quirk) and
 * kind-fragile (only SPAN_KIND_SERVER spans carry the attribute at all),
 * while a direct `traceId` term match is a plain top-level keyword field on
 * both sides and was confirmed to work reliably once ingestion lag (also
 * verified live, ~a few minutes) has passed.
 */
async function fetchCorrelatedSpans(
  client: OpenSearchClient,
  traceId: string,
): Promise<readonly SpanSummary[]> {
  const response = await client.search(OTEL_SPANS_INDEX_PATTERN, {
    size: SPAN_LIMIT,
    query: { term: { traceId } },
    sort: [{ startTime: "asc" }],
  });
  return response.hits.map((hit) => mapHitToSpanSummary(hit._source));
}

function logRowToOutputRow(row: LogRow): Record<string, unknown> {
  return {
    KIND: "log",
    TIMESTAMP: row.timestamp,
    SOURCE_TYPE: row.sourceType,
    APP: row.appName,
    LEVEL: row.level,
    MESSAGE: row.message,
    STATUS: row.responseStatus ?? "",
    TRACE_ID: row.traceId,
    SPAN_ID: "",
    SPAN_NAME: "",
  };
}

function spanToOutputRow(span: SpanSummary): Record<string, unknown> {
  return {
    KIND: "span",
    TIMESTAMP: span.startTime,
    SOURCE_TYPE: "",
    APP: span.serviceName,
    LEVEL: "",
    MESSAGE: "",
    STATUS: "",
    TRACE_ID: span.traceId,
    SPAN_ID: span.spanId,
    SPAN_NAME: span.name,
  };
}

async function runTrace(vcapRequestId: string, opts: TraceOpts): Promise<void> {
  const format = parseFormat(opts.format);
  await withOpenSearchClient(opts, async (client) => {
    const logResponse = await client.search(DEFAULT_INDEX_PATTERN, {
      size: TRACE_LOG_LIMIT,
      query: { term: { "vcap_request_id.keyword": vcapRequestId } },
      sort: [{ "@timestamp": "asc" }],
    });
    const logRows = logResponse.hits.map((hit) => mapHitToLogRow({ id: hit._id, source: hit._source }));

    if (logRows.length === 0) {
      printNotice(`no logs-cfsyslog-* document has vcap_request_id "${vcapRequestId}" — check the id, or that it falls within this instance's current retention window.`);
    }

    const outputRows: Record<string, unknown>[] = logRows.map(logRowToOutputRow);

    if (opts.withSpan) {
      const rtrRow = logRows.find((row) => row.traceId.length > 0);
      if (rtrRow === undefined) {
        if (logRows.length > 0) {
          printNotice("no RTR row with a real trace id was found among the matched log rows — --with-span has nothing to join on (only RTR rows carry a usable trace id; see the SKILL.md's trace_id note).");
        }
      } else {
        const spans = await fetchCorrelatedSpans(client, rtrRow.traceId);
        if (spans.length === 0) {
          printNotice(`no span found for trace id ${rtrRow.traceId} yet — spans can lag log ingestion by a few minutes (verified live); retry shortly, or this request may not have been sampled/traced.`);
        }
        outputRows.push(...spans.map(spanToOutputRow));
      }
    }

    await emitRows({ command: "trace", format, save: opts.save, rows: outputRows });
  });
}

export function registerTraceCommand(program: Command): void {
  const command = program
    .command("trace <vcap-request-id>")
    .description("every logs-cfsyslog-* document sharing one exact per-hop request id, optionally joined to its OTel trace")
    .option("--with-span", "also fetch the correlated spans from otel-v1-apm-span-* (joins on the matched RTR row's own trace id — see SKILL.md)", false);
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async (vcapRequestId: string, _options: unknown, cmd: Command) => {
    await runTrace(vcapRequestId, cmd.opts<TraceOpts>());
  });
}
