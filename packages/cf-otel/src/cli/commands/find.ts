import type { Command } from "commander";

import { parseAttrFilter, resolveAndValidateAttrFilters } from "../../attr-filter.js";
import { DEFAULT_FIND_LIMIT, DEFAULT_INDEX_PATTERN } from "../../config.js";
import { CfOtelError } from "../../errors.js";
import { buildSpanBoolQuery } from "../../query-builder.js";
import { hitToSpan } from "../../span-mapper.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { FindOpts } from "../commandTypes.js";
import { formatDurationNanos } from "../display.js";
import { emitRows, parseFormat, parseTraceIds } from "../output.js";
import {
  withAttrOptions,
  withCredentialOptions,
  withFormatOption,
  withLimitOption,
  withNameOption,
  withSaveOption,
  withServiceOption,
  withTargetOptions,
  withTimeRangeOptions,
  withTraceIdsOption,
} from "../shared-options.js";

function parseSortField(value: string | undefined): "startTime" | "durationInNanos" {
  if (value === undefined || value === "startTime") {
    return "startTime";
  }
  if (value === "durationInNanos") {
    return "durationInNanos";
  }
  throw new CfOtelError("CONFIG", `Invalid --sort "${value}" (expected startTime or durationInNanos)`);
}

function checkLimit(limit: number): void {
  if (limit === 0) {
    // Unlike detached/top/spans/diff (where 0 means "all", safe because those
    // slice an already internally-bounded fetch/aggregation), --limit here
    // maps directly to OpenSearch's own `size`, where 0 means "return zero
    // hits" — the opposite of "all". Reject explicitly rather than silently
    // returning nothing, which would look identical to "no matches at all".
    throw new CfOtelError(
      "CONFIG",
      "--limit 0 would return zero results here (size is sent directly to OpenSearch, unlike detached/top/spans/diff's 0-means-all display slice); pass a positive --limit, or narrow/widen --since/--until instead",
    );
  }
}

async function runFind(opts: FindOpts): Promise<void> {
  checkLimit(opts.limit);
  const format = parseFormat(opts.format);
  const sortField = parseSortField(opts.sort);
  const traceIds = parseTraceIds(opts.traceIds);
  const attrs = opts.attr.map(parseAttrFilter);

  const spans = await withOpenSearchClient(opts, async (client) => {
    const resolvedAttrs = await resolveAndValidateAttrFilters(client, DEFAULT_INDEX_PATTERN, attrs);
    const query = buildSpanBoolQuery({
      service: opts.service,
      ...(opts.name === undefined ? {} : { namePattern: opts.name }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
      attrs: resolvedAttrs,
      errorsOnly: opts.errorsOnly,
      ...(traceIds === undefined ? {} : { traceIds }),
    });
    const response = await client.search(DEFAULT_INDEX_PATTERN, {
      size: opts.limit,
      query,
      sort: [{ [sortField]: "desc" }],
    });
    return response.hits.map(hitToSpan);
  });

  await emitRows({
    command: "find",
    format,
    save: opts.save,
    rows: spans.map((span) => ({
      TRACE_ID: span.traceId,
      NAME: span.name,
      SERVICE: span.serviceName,
      START_TIME: span.startTime,
      DURATION: formatDurationNanos(span.durationInNanos),
      DURATION_NANOS: span.durationInNanos,
    })),
  });
}

export function registerFindCommand(program: Command): void {
  const command = program.command("find").description("locate trace(s) matching criteria");
  withServiceOption(command, true);
  withNameOption(command);
  withTimeRangeOptions(command);
  withAttrOptions(command);
  withTraceIdsOption(command);
  withLimitOption(command, DEFAULT_FIND_LIMIT);
  command.option("--sort <field>", "startTime or durationInNanos", "startTime");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runFind(command.opts<FindOpts>());
  });
}
