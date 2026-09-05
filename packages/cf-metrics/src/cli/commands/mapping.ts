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
  /** The resolved type — for a field alias, the type of the field it points at, since that is what a query against it compares. */
  readonly type: string;
  readonly ignoreAbove?: number;
  /** Set when `field` is an alias: the concrete path it resolves to. */
  readonly aliasOf?: string;
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
/** Walk one index entry's own mapping tree for a `.`-separated field path. */
function walkIndexProperties(mappings: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  let properties: unknown = mappings["properties"];
  let fieldDef: Record<string, unknown> | undefined;
  for (const segment of field.split(".")) {
    const node = isRecord(properties) ? properties[segment] : undefined;
    if (!isRecord(node)) {
      return undefined;
    }
    fieldDef = node;
    properties = node["properties"];
  }
  return fieldDef;
}

/** One index's answer for a field: its definition, and the alias target it was reached through. */
interface IndexDefinition {
  readonly definition: Record<string, unknown>;
  readonly aliasOf?: string;
}

/**
 * Resolve a field alias to the definition it points at, within the index that
 * declared it — an alias's target is a path in that same mapping.
 *
 * `metrics-*` maps nine of these (measured live): short names like `app_name`
 * pointing at `resource.attributes.sap@cf@app_name`. Reporting the pointer's
 * own type answers `"alias"`, which is true and useless to someone asking
 * whether the field is safe to aggregate on — the type that governs that is
 * the target's, and OpenSearch resolves the alias in queries and aggregations
 * alike (measured: identical buckets either way).
 *
 * Exactly one hop. OpenSearch requires an alias's target to be a concrete
 * field, never an object or another alias, so a chain is a malformed mapping;
 * following one would also let a self-referential `path` spin forever. A
 * target that is missing, non-string, or itself an alias leaves the alias
 * definition in place — today's answer plus the target name, never less.
 */
function resolveAlias(mappings: Record<string, unknown>, fieldDef: Record<string, unknown>): IndexDefinition {
  if (fieldDef["type"] !== "alias") {
    return { definition: fieldDef };
  }
  const path = fieldDef["path"];
  if (typeof path !== "string") {
    return { definition: fieldDef };
  }
  const target = walkIndexProperties(mappings, path);
  if (target === undefined || target["type"] === "alias") {
    return { definition: fieldDef, aliasOf: path };
  }
  return { definition: target, aliasOf: path };
}

function findFieldDefinitions(mappingResponse: unknown, field: string): IndexDefinition[] {
  if (!isRecord(mappingResponse)) {
    return [];
  }
  const found: IndexDefinition[] = [];
  for (const indexEntry of Object.values(mappingResponse)) {
    if (!isRecord(indexEntry)) {
      continue;
    }
    const mappings = indexEntry["mappings"];
    if (!isRecord(mappings)) {
      continue;
    }
    const fieldDef = walkIndexProperties(mappings, field);
    if (fieldDef !== undefined) {
      found.push(resolveAlias(mappings, fieldDef));
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
/**
 * Why a field has no single answer. The two cases used to be one `undefined`,
 * and `runMapping` reported both as "was not found in the mapping" — untrue,
 * and misleading, for a field that is present in every index and simply
 * mapped inconsistently. That message was introduced with the agreement check
 * itself; separating them is the other half of that fix.
 */
type FieldLookup =
  | { readonly status: "found"; readonly mapping: FieldMapping }
  | { readonly status: "disagrees"; readonly types: readonly string[] }
  | { readonly status: "absent" };

function lookUpField(mappingResponse: unknown, field: string): FieldLookup {
  const definitions = findFieldDefinitions(mappingResponse, field);
  const [first] = definitions;
  if (first === undefined) {
    return { status: "absent" };
  }
  const type = mappedType(first.definition);
  const types = [...new Set(definitions.map((entry) => mappedType(entry.definition)))];
  if (types.length > 1) {
    return { status: "disagrees", types };
  }
  // An alias pointing at different targets in different indices is a real
  // disagreement even when the resolved types coincide.
  if (definitions.some((entry) => entry.aliasOf !== first.aliasOf)) {
    return { status: "disagrees", types: [type] };
  }
  const ignoreAbove = first.definition["ignore_above"];
  // Deliberately not part of the agreement gate: a divergent cap is reported
  // as unknown rather than suppressing a correct type over an advisory column.
  const capsAgree = definitions.every((entry) => entry.definition["ignore_above"] === ignoreAbove);
  return {
    status: "found",
    mapping: {
      field,
      type,
      ...(typeof ignoreAbove === "number" && capsAgree ? { ignoreAbove } : {}),
      ...(first.aliasOf === undefined ? {} : { aliasOf: first.aliasOf }),
    },
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
  const lookup = lookUpField(mappingResponse, name);
  // "ambiguous" rather than "unknown": in a listing the two look alike but mean
  // opposite things — one is a field this version could not read, the other is
  // a field whose backing indices disagree about.
  const type = lookup.status === "found" ? lookup.mapping.type : lookup.status === "disagrees" ? "ambiguous" : "unknown";
  return {
    FIELD: name,
    TYPE: type,
    IGNORE_ABOVE: lookup.status === "found" ? (lookup.mapping.ignoreAbove ?? "") : "",
    // A field alias reports the type of what it points at, since that is what a
    // query against it compares — naming the target keeps that honest, and
    // hands the reader the concrete path to use everywhere else.
    ALIAS_OF: lookup.status === "found" ? (lookup.mapping.aliasOf ?? "") : "",
  };
}

/** The error for a field with no single answer, saying which of the two reasons it is. */
function lookupFailure(field: string, index: string, lookup: FieldLookup): CfMetricsError {
  if (lookup.status === "disagrees") {
    return new CfMetricsError(
      "MAPPING_LOOKUP_FAILED",
      `Field "${field}" is mapped inconsistently across the backing indices of ${index} ` +
        `(${lookup.types.join(", ")}), so no single type is safe to assume for a query spanning them. ` +
        "Narrow the query to one index, or use a field the indices agree on.",
    );
  }
  return new CfMetricsError("MAPPING_LOOKUP_FAILED", `Field "${field}" was not found in the mapping for ${index}`);
}

async function runMapping(opts: MappingOpts): Promise<void> {
  const format = parseFormat(opts.format);
  await withOpenSearchClient(opts, async (client) => {
    const mappingResponse = await client.getMapping(opts.index);
    if (opts.field !== undefined) {
      const lookup = lookUpField(mappingResponse, opts.field);
      if (lookup.status !== "found") {
        throw lookupFailure(opts.field, opts.index, lookup);
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
