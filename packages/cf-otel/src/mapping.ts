import { CfOtelError } from "./errors.js";
import type { OpenSearchClient } from "./opensearch-client.js";

export interface FieldMapping {
  readonly field: string;
  readonly type: string;
  readonly ignoreAbove?: number;
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
  const segments = field.split(".");
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
      return fieldDef;
    }
  }
  return undefined;
}

export function findFieldInMapping(mappingResponse: unknown, field: string): FieldMapping | undefined {
  const fieldDef = findFieldDefinition(mappingResponse, field);
  if (fieldDef === undefined || typeof fieldDef["type"] !== "string") {
    return undefined;
  }
  const ignoreAbove = fieldDef["ignore_above"];
  return {
    field,
    type: fieldDef["type"],
    ...(typeof ignoreAbove === "number" ? { ignoreAbove } : {}),
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
