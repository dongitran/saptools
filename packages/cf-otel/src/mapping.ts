import { CfOtelError } from "./errors.js";
import type { OpenSearchClient } from "./opensearch-client.js";

export interface FieldMapping {
  readonly field: string;
  /** The resolved type — for a field alias, the type of the field it points at, since that is what a query against it actually compares. */
  readonly type: string;
  readonly ignoreAbove?: number;
  /** Set when `field` is an alias: the concrete path it resolves to. */
  readonly aliasOf?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A flat `_source` key like `span.attributes.url@path` is a single literal
 * field in every *document* (never nested, per §4) — but confirmed against a
 * real Cloud Logging instance's `_mapping` response this session, the
 * *mapping tree itself* genuinely nests on the `.` segments (`properties.span
 * .properties.attributes.properties["url@path"]`), even though `@` within
 * the last segment never nests further. A single top-level `properties[field]`
 * lookup found nothing for the entire `span.attributes.*`/`resource.attributes.*`
 * family — silently breaking `mapping --field` and `resolveAggregatableField`
 * for exactly the fields §4's keyword-vs-text check exists to cover. Splitting
 * only on `.` and walking each segment's own nested `properties` fixes this
 * while still resolving a plain, undotted field name (`name`, `traceState`)
 * in one step, unchanged from before.
 */
function findFieldDefinition(mappingResponse: unknown, field: string): Record<string, unknown> | undefined {
  if (!isRecord(mappingResponse)) {
    return undefined;
  }
  // Alias-resolved, so `resolveAggregatableField` decides `text` vs `keyword`
  // on the field a query would really touch rather than on the pointer to it.
  return findFieldDefinitions(mappingResponse, field)[0]?.definition;
}

/**
 * Every index entry's definition of `field`, in response order.
 *
 * The index *pattern* covers many backing indices, and dynamic mapping can give
 * the same path different types in different ones after an ingest change. A
 * caller that only needs a shape can take the first; a caller whose decision
 * would be unsafe if the indices disagree must compare them all — see
 * {@link findFieldInMapping}.
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
 * Exactly one hop. OpenSearch requires an alias's target to be a concrete
 * field, never an object or another alias, so a chain is a malformed mapping;
 * following one would also let a self-referential `path` spin forever. A
 * target that is missing, non-string, or itself an alias leaves the alias
 * definition in place, which is strictly today's answer plus the target name —
 * never less than the caller had before.
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
 * field agrees on its type.
 *
 * Reporting the first index's opinion was safe while callers only wanted to
 * know whether a field exists, and unsafe as soon as one used the type to
 * decide what terms are legal to send: the query runs against the whole
 * pattern, so a type sampled from one index can be wrong for another's shards.
 * A disagreement therefore reports `undefined` — "no reliable type" — which
 * every caller already treats conservatively.
 */
export function findFieldInMapping(mappingResponse: unknown, field: string): FieldMapping | undefined {
  const definitions = findFieldDefinitions(mappingResponse, field);
  const [first] = definitions;
  if (first === undefined || typeof first.definition["type"] !== "string") {
    return undefined;
  }
  if (definitions.some((entry) => entry.definition["type"] !== first.definition["type"])) {
    return undefined;
  }
  // An alias pointing at different targets in different indices is a real
  // disagreement even when the resolved types happen to coincide — the same
  // "one index's opinion stands in for the pattern" shape the type check above
  // exists to close.
  if (definitions.some((entry) => entry.aliasOf !== first.aliasOf)) {
    return undefined;
  }
  const ignoreAbove = first.definition["ignore_above"];
  // `ignore_above` is deliberately *not* part of the agreement gate: this
  // function's `undefined` means "no usable answer", and withholding a correct
  // type over an advisory cap would suppress what the caller came for. A
  // divergent cap is reported as unknown instead of picking whichever index
  // answered first.
  const capsAgree = definitions.every((entry) => entry.definition["ignore_above"] === ignoreAbove);
  return {
    field,
    type: first.definition["type"],
    ...(typeof ignoreAbove === "number" && capsAgree ? { ignoreAbove } : {}),
    ...(first.aliasOf === undefined ? {} : { aliasOf: first.aliasOf }),
  };
}

export async function getFieldMapping(
  client: OpenSearchClient,
  index: string,
  field: string,
): Promise<FieldMapping | undefined> {
  return findFieldInMapping(await client.getMapping(index), field);
}

/**
 * Try the bare field name for aggregation; only fall back to its `.keyword`
 * multi-field if the bare field is `text`-mapped. A `.keyword` multi-field
 * lives under the text field's own `fields` block in the mapping tree, not as
 * a separate top-level `<field>.keyword` entry — using the wrong lookup here
 * is exactly how a `terms` aggregation silently returns empty buckets on an
 * already-`keyword` field (see the module-level note above).
 */
export async function resolveAggregatableField(
  client: OpenSearchClient,
  index: string,
  field: string,
): Promise<string> {
  const mappingResponse = await client.getMapping(index);
  const fieldDef = findFieldDefinition(mappingResponse, field);
  if (fieldDef === undefined) {
    throw new CfOtelError(
      "MAPPING_LOOKUP_FAILED",
      `Field "${field}" was not found in the mapping for ${index}`,
    );
  }
  if (fieldDef["type"] !== "text") {
    return field;
  }
  const subFields = fieldDef["fields"];
  if (isRecord(subFields) && isRecord(subFields["keyword"])) {
    return `${field}.keyword`;
  }
  throw new CfOtelError(
    "MAPPING_LOOKUP_FAILED",
    `Field "${field}" is text-mapped and has no .keyword sub-field to aggregate on.`,
  );
}

/**
 * Fail loudly when a field a command depends on is absent from the index.
 *
 * A tenant only has the HTTP request-header attributes if its OpenTelemetry
 * collector is configured to export them. Where it is not, a filter on one of
 * them matches nothing and the command reports an empty result at exit 0 —
 * indistinguishable from "that value is not in this window", which is exactly
 * the silent miss these lookups exist to remove. One mapping lookup, shared
 * with any other lookup the same client makes, buys a definite answer.
 */
export async function assertFieldExists(
  client: OpenSearchClient,
  index: string,
  field: string,
  why: string,
): Promise<void> {
  if (await getFieldMapping(client, index, field) !== undefined) {
    return;
  }
  throw new CfOtelError(
    "MAPPING_LOOKUP_FAILED",
    `"${field}" is not present in ${index}, so ${why}. ` +
      "This tenant's OpenTelemetry collector is not exporting HTTP request headers.",
  );
}
