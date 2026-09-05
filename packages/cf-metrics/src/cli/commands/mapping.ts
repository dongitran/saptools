import type { Command } from "commander";

import { DEFAULT_INDEX_PATTERN } from "../../config.js";
import { CfMetricsError } from "../../errors.js";
import { withOpenSearchClient } from "../client-bootstrap.js";
import type { MappingOpts } from "../commandTypes.js";
import { emitRows, parseFormat } from "../output.js";
import { withCredentialOptions, withFormatOption, withSaveOption, withTargetOptions } from "../shared-options.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface FieldMapping {
  readonly field: string;
  readonly type: string;
  readonly ignoreAbove?: number;
}

/**
 * OpenSearch/Elasticsearch field mappings omit `type` entirely for an object
 * field — `object` is only ever implicit, never written out. Reporting such
 * a field as `"unknown"` (confirmed live for `instrumentationScope`, a real
 * object-typed field on metric documents) reads as a lookup failure rather
 * than a legitimate mapped type; detect the implicit case from the presence
 * of a nested `properties` block instead.
 */
function mappedType(entry: Record<string, unknown>): string {
  const type = entry["type"];
  if (typeof type === "string") {
    return type;
  }
  return isRecord(entry["properties"]) ? "object" : "unknown";
}

/**
 * Every index entry's definition of `field`, in response order, walking
 * nested `properties` one `.`-separated segment at a time.
 *
 * A flat `_source` key like `resource.attributes.sap@cf@app_name` is a single
 * literal key on every *document* (metric documents never nest — see
 * `fields.ts`) — but confirmed live against the real backend, the *mapping
 * tree* for this index pattern still nests on the `.` segments
 * (`properties.resource.properties.attributes.properties["sap@cf@app_name"]`),
 * the same discovery `@saptools/cf-otel` already made for its own span index.
 * A single top-level `properties[field]` lookup found nothing for the entire
 * `resource.*` family — silently breaking `mapping --field` for most of what
 * is worth checking. `@` within one segment never nests further, so splitting
 * only on `.` still resolves a plain, undotted field name in one step,
 * unchanged from before.
 */
function findFieldDefinitions(mappingResponse: unknown, field: string): Record<string, unknown>[] {
  if (!isRecord(mappingResponse)) {
    return [];
  }
  const segments = field.split(".");
  const found: Record<string, unknown>[] = [];
  for (const indexEntry of Object.values(mappingResponse)) {
    if (!isRecord(indexEntry)) {
      continue;
    }
    const mappings = indexEntry["mappings"];
    if (!isRecord(mappings)) {
      continue;
    }
    let properties: unknown = mappings["properties"];
    let fieldDef: Record<string, unknown> | undefined;
    for (const segment of segments) {
      const node = isRecord(properties) ? properties[segment] : undefined;
      if (!isRecord(node)) {
        fieldDef = undefined;
        break;
      }
      fieldDef = node;
      properties = node["properties"];
    }
    if (fieldDef !== undefined) {
      found.push(fieldDef);
    }
  }
  return found;
}

/**
 * The field's mapping, reported only when every backing index that has the
 * field agrees on its (resolved — see `mappedType`) type.
 *
 * Reporting the first index's opinion was safe while this command only
 * reported existence, and unsafe as soon as a caller used the type to decide
 * what terms are legal to send: `metrics-*` spans 40 backing indices
 * (measured live), and a type sampled from one can be wrong for another's
 * shards. Mirrors the identical fix already shipped in `@saptools/cf-otel`'s
 * own `mapping.ts`, after it hit this for real (a stale, first-matched type
 * let an already-mapped field send a term shape a newer shard rejected).
 */
function findFieldInMapping(mappingResponse: unknown, field: string): FieldMapping | undefined {
  const definitions = findFieldDefinitions(mappingResponse, field);
  const [fieldDef] = definitions;
  if (fieldDef === undefined) {
    return undefined;
  }
  const type = mappedType(fieldDef);
  if (definitions.some((definition) => mappedType(definition) !== type)) {
    return undefined;
  }
  const ignoreAbove = fieldDef["ignore_above"];
  return {
    field,
    type,
    ...(typeof ignoreAbove === "number" ? { ignoreAbove } : {}),
  };
}

function listAllFieldNames(mappingResponse: unknown): readonly string[] {
  const names = new Set<string>();
  if (!isRecord(mappingResponse)) {
    return [];
  }
  for (const indexEntry of Object.values(mappingResponse)) {
    if (!isRecord(indexEntry)) {
      continue;
    }
    const mappings = indexEntry["mappings"];
    const properties = isRecord(mappings) ? mappings["properties"] : undefined;
    if (!isRecord(properties)) {
      continue;
    }
    for (const name of Object.keys(properties)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function fieldRow(name: string, mappingResponse: unknown): Record<string, string | number> {
  const found = findFieldInMapping(mappingResponse, name);
  return { FIELD: name, TYPE: found?.type ?? "unknown", IGNORE_ABOVE: found?.ignoreAbove ?? "" };
}

async function runMapping(opts: MappingOpts): Promise<void> {
  const format = parseFormat(opts.format);
  await withOpenSearchClient(opts, async (client) => {
    const mappingResponse = await client.getMapping(opts.index);
    if (opts.field !== undefined) {
      if (findFieldInMapping(mappingResponse, opts.field) === undefined) {
        throw new CfMetricsError(
          "MAPPING_LOOKUP_FAILED",
          `Field "${opts.field}" was not found in the mapping for ${opts.index}`,
        );
      }
      await emitRows({ command: "mapping", format, save: opts.save, rows: [fieldRow(opts.field, mappingResponse)] });
      return;
    }
    await emitRows({
      command: "mapping",
      format,
      save: opts.save,
      rows: listAllFieldNames(mappingResponse).map((name) => fieldRow(name, mappingResponse)),
    });
  });
}

export function registerMappingCommand(program: Command): void {
  const command = program
    .command("mapping")
    .description("field-type discovery — check keyword vs. text before aggregating on any field")
    .option("--index <pattern>", "index pattern to inspect", DEFAULT_INDEX_PATTERN)
    .option("--field <name>", "show just one field's mapped type (omit to list all)");
  withFormatOption(command);
  withSaveOption(command);
  withTargetOptions(command);
  withCredentialOptions(command);
  command.action(async () => {
    await runMapping(command.opts<MappingOpts>());
  });
}
