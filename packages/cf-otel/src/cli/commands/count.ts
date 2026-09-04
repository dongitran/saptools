import type { Command } from "commander";

import { parseAttrFilter, resolveAndValidateAttrFilters } from "../../attr-filter.js";
import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { CfOtelError } from "../../errors.js";
import { assertFieldExists } from "../../mapping.js";
import { assertTimeBoundsValid, buildSpanBoolQuery, VCAP_REQUEST_ID_FIELD } from "../../query-builder.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { CountOpts } from "../commandTypes.js";
import { assertRequestIdUsable, parseFormat, parseTraceIds, print, printNotice } from "../output.js";
import {
  withAttrOptions,
  withCredentialOptions,
  withFormatOption,
  withNameOption,
  withServiceOption,
  withTargetOptions,
  withTimeRangeOptions,
  withTraceIdsOption,
  withVcapRequestIdOption,
} from "../shared-options.js";

async function runCount(traceId: string | undefined, opts: CountOpts): Promise<void> {
  // Validated (so an invalid value fails clearly, like every other command)
  // but not otherwise used: a bare integer count renders identically in
  // table/json/json-compact/csv, so there's no structural output to switch on.
  parseFormat(opts.format);
  // Fail on a malformed --since/--until here, before the CF login and
  // credential discovery that building the query would otherwise run first.
  assertTimeBoundsValid(opts);
  assertRequestIdUsable(opts.vcapRequestId);
  if (traceId !== undefined && opts.traceIds !== undefined) {
    throw new CfOtelError("CONFIG", "Pass either a positional traceId or --trace-ids, not both");
  }
  const traceIds = parseTraceIds(opts.traceIds) ?? (traceId === undefined ? undefined : [traceId]);
  const attrs = opts.attr.map(parseAttrFilter);
  const count = await withOpenSearchClient(opts, async (client) => {
    if (opts.vcapRequestId !== undefined) {
      await assertFieldExists(client, DEFAULT_INDEX_PATTERN, VCAP_REQUEST_ID_FIELD, "no request id can be resolved");
    }
    const resolvedAttrs = await resolveAndValidateAttrFilters(client, DEFAULT_INDEX_PATTERN, attrs, printNotice);
    const query = buildSpanBoolQuery({
      ...(opts.service === undefined ? {} : { service: opts.service }),
      ...(opts.name === undefined ? {} : { namePattern: opts.name }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
      attrs: resolvedAttrs,
      errorsOnly: opts.errorsOnly,
      ...(opts.vcapRequestId === undefined ? {} : { vcapRequestId: opts.vcapRequestId }),
      ...(traceIds === undefined ? {} : { traceIds }),
    });
    return await client.count(DEFAULT_INDEX_PATTERN, { query });
  });
  print(String(count));
}

export function registerCountCommand(program: Command): void {
  const command = program
    .command("count [traceId]")
    .description(
      "fast existence/frequency check — the trust-but-verify companion to selftime's capped ranked table",
    );
  withServiceOption(command, false);
  withNameOption(command);
  withTimeRangeOptions(command);
  withAttrOptions(command);
  withVcapRequestIdOption(command);
  withTraceIdsOption(command);
  withFormatOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async (traceId: string | undefined) => {
    await runCount(traceId, command.opts<CountOpts>());
  });
}
