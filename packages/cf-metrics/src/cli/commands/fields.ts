import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { CfMetricsError } from "../../errors.js";
import { buildMetricBoolQuery } from "../../query-builder.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { FieldsOpts } from "../commandTypes.js";
import { emitRows, parseFormat, printNotice } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withServiceOption, withTargetOptions } from "../shared-options.js";

function readDisplayString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

async function runFields(opts: FieldsOpts): Promise<void> {
  const format = parseFormat(opts.format);
  const query = buildMetricBoolQuery({
    ...(opts.service === undefined ? {} : { service: opts.service }),
    ...(opts.name === undefined ? {} : { names: [opts.name] }),
  });

  const doc = await withOpenSearchClient(opts, async (client) => {
    const response = await client.search(DEFAULT_INDEX_PATTERN, {
      size: 1,
      query,
      sort: [{ time: { order: "desc", unmapped_type: "date" } }],
    });
    return response.hits[0];
  });

  if (doc === undefined) {
    throw new CfMetricsError("METRIC_NOT_FOUND", "No matching metric document found for the given filters");
  }
  // Metric documents are already flat (confirmed live: attribute keys like
  // `resource.attributes.sap@cf@app_name` are literal top-level string keys,
  // never nested objects) — no attribute-walking helper needed here, unlike
  // cf-otel's span `fields` command.
  const keys = Object.keys(doc._source).sort();
  printNotice(
    `${String(keys.length)} flat attribute keys found ` +
      `(sample name=${readDisplayString(doc._source["name"])}, kind=${readDisplayString(doc._source["kind"])})`,
  );
  await emitRows({ command: "fields", format, save: opts.save, rows: keys.map((key) => ({ KEY: key })), compactColumn: "KEY" });
}

export function registerFieldsCommand(program: Command): void {
  const command = program
    .command("fields")
    .description("list every flat attribute key on a sample metric document, without guessing field names blind");
  withServiceOption(command, false);
  command.option("--name <metric-name>", "restrict the sample to one metric name");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runFields(command.opts<FieldsOpts>());
  });
}
