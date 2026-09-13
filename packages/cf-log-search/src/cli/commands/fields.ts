import type { Command } from "commander";

import { CURATED_FIELDS } from "../../curated-fields.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { FieldsOpts } from "../commandTypes.js";
import { emitRows, parseFormat } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions } from "../shared-options.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenProperties(properties: Record<string, unknown>, prefix: string, rows: { field: string; type: string }[]): void {
  for (const [name, definition] of Object.entries(properties)) {
    if (!isRecord(definition)) {
      continue;
    }
    const path = prefix.length > 0 ? `${prefix}.${name}` : name;
    const type = definition["type"];
    if (typeof type === "string") {
      rows.push({ field: path, type });
    }
    const nestedProperties = definition["properties"];
    if (isRecord(nestedProperties)) {
      flattenProperties(nestedProperties, path, rows);
    }
    const multiFields = definition["fields"];
    if (isRecord(multiFields)) {
      for (const [subName, subDefinition] of Object.entries(multiFields)) {
        if (isRecord(subDefinition) && typeof subDefinition["type"] === "string") {
          rows.push({ field: `${path}.${subName}`, type: subDefinition["type"] });
        }
      }
    }
  }
}

function flattenSingleIndexMapping(mappingResponse: unknown, index: string): readonly { field: string; type: string }[] {
  const indexBlock = isRecord(mappingResponse) ? mappingResponse[index] : undefined;
  const properties = isRecord(indexBlock) && isRecord(indexBlock["mappings"]) ? indexBlock["mappings"]["properties"] : undefined;
  const rows: { field: string; type: string }[] = [];
  if (isRecord(properties)) {
    flattenProperties(properties, "", rows);
  }
  return rows;
}

async function runRawFields(opts: FieldsOpts): Promise<void> {
  if (opts.index === undefined) {
    throw new Error("--raw requires --index <one-concrete-index-name> (e.g. logs-cfsyslog-000053) — a wildcard mapping fetch on this index family returns a 92,000-line response merging 52 generations");
  }
  if (opts.index.includes("*")) {
    throw new Error(`--index "${opts.index}" must name one concrete index, not a wildcard pattern`);
  }
  const index = opts.index;
  const format = parseFormat(opts.format);
  await withOpenSearchClient(opts, async (client) => {
    const mappingResponse = await client.getMapping(index);
    const rows = flattenSingleIndexMapping(mappingResponse, index).map((row) => ({ FIELD: row.field, TYPE: row.type }));
    await emitRows({ command: "fields --raw", format, save: opts.save, rows });
  });
}

async function runCuratedFields(opts: FieldsOpts): Promise<void> {
  const format = parseFormat(opts.format);
  const rows = CURATED_FIELDS.map((field) => ({ FIELD: field.field, TYPE: field.type, APPLIES_TO: field.appliesTo, NOTES: field.notes }));
  await emitRows({ command: "fields", format, save: opts.save, rows });
}

export function registerFieldsCommand(program: Command): void {
  const command = program
    .command("fields")
    .description("list queryable log fields — defaults to a curated, hand-verified reference (no network call); --raw fetches the real mapping for one concrete index")
    .option("--raw", "fetch the real OpenSearch mapping instead of the curated reference (requires --index)", false)
    .option("--index <name>", "one concrete backing index to inspect with --raw, e.g. logs-cfsyslog-000053 (never a wildcard pattern)");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    const opts = command.opts<FieldsOpts>();
    await (opts.raw ? runRawFields(opts) : runCuratedFields(opts));
  });
}
