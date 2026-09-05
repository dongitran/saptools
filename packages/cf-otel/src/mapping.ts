import { CfOtelError } from "./errors.js";
import type { OpenSearchClient } from "./opensearch-client.js";

export interface FieldMapping {
  readonly field: string;
  /** The resolved type — for a field alias, the type of the field it points at, since that is what a query against it actually compares. */
  readonly type: string;
  readonly ignoreAbove?: number;
  /**
   * True when the backing indices report different `ignore_above` caps.
   *
   * Surfaced rather than omitted, and that distinction matters: a `keyword`
   * longer than its cap is stored but never indexed, so it produces no term
   * and cannot match a `term`/`terms` query or appear in a bucket. Divergence
   * therefore means the same value matches on one shard and not another — but
   * a *blank* cap reads as "no cap at all", which is the safe interpretation,
   * exactly inverting the hazard.
   */
  readonly ignoreAboveVaries?: boolean;
  /** Set when `field` is an alias: the concrete path it resolves to, taken from the first index that declared it. */
  readonly aliasOf?: string;
  /** True when indices point the same alias at different targets — surfaced, never used to withhold the type (see {@link findFieldInMapping}). */
  readonly aliasVaries?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk one index entry's own mapping tree for a `.`-separated field path.
 *
 * A flat `_source` key like `span.attributes.url@path` is a single literal
 * field in every *document* (never nested, per §4) — but confirmed against a
 * real Cloud Logging instance's `_mapping` response, the *mapping tree itself*
 * genuinely nests on the `.` segments (`properties.span.properties.attributes
 * .properties["url@path"]`), even though `@` within the last segment never
 * nests further. A single top-level `properties[field]` lookup found nothing
 * for the entire `span.attributes.*`/`resource.attributes.*` family —
 * silently breaking `mapping --field` and `resolveAggregatableField` for
 * exactly the fields §4's keyword-vs-text check exists to cover. Splitting
 * only on `.` and walking each segment's own nested `properties` fixes this
 * while still resolving a plain, undotted field name (`name`, `traceState`)
 * in one step.
 *
 * Only `properties` is descended, never a field's `fields` block, so a path
 * naming a multi-field (`long.keyword`) does not resolve here — an alias onto
 * one degrades to reporting `alias`, which is the documented fallback rather
 * than a wrong answer.
 */
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

/**
 * Every index entry's answer for `field`, in response order, each alias
 * already resolved within the index that declared it.
 *
 * The index *pattern* covers many backing indices, and dynamic mapping can
 * give the same path different types in different ones after an ingest
 * change. A caller that only needs a shape can take the first; a caller whose
 * decision would be unsafe if the indices disagree must compare them all —
 * see {@link findFieldInMapping}.
 */
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
 * A *type* disagreement therefore reports `undefined` — "no reliable type" —
 * which every caller already treats conservatively.
 *
 * Nothing else does. A divergent alias target or `ignore_above` is reported
 * alongside an agreed type rather than instead of it; see the note in the body
 * for why `undefined` is the wrong signal for "agreed, with a caveat".
 */
export function findFieldInMapping(mappingResponse: unknown, field: string): FieldMapping | undefined {
  const lookup = lookUpField(mappingResponse, field);
  return lookup.status === "found" ? lookup.mapping : undefined;
}

/**
 * Why a field has no single type: absent everywhere, or present but mapped
 * inconsistently. `findFieldInMapping` collapses both to `undefined`, which is
 * the right shape for callers that can only act on a type — but reporting a
 * field that exists in every index as "not found" sends the reader hunting for
 * a typo that is not there, so the command layer distinguishes them.
 */
export type FieldLookup =
  | { readonly status: "found"; readonly mapping: FieldMapping }
  | { readonly status: "disagrees"; readonly types: readonly string[] }
  | { readonly status: "absent" };

export function lookUpField(mappingResponse: unknown, field: string): FieldLookup {
  const definitions = findFieldDefinitions(mappingResponse, field);
  const [first] = definitions;
  if (first === undefined || typeof first.definition["type"] !== "string") {
    return { status: "absent" };
  }
  const types = [...new Set(definitions.map((entry) => entry.definition["type"]).filter((type): type is string => typeof type === "string"))];
  if (definitions.some((entry) => entry.definition["type"] !== first.definition["type"])) {
    return { status: "disagrees", types };
  }
  // Neither a divergent alias target nor a divergent `ignore_above` withholds
  // the type. `undefined` here does not mean "be careful" — three callers read
  // it as "this field is absent", and each then does something worse than
  // reporting a type with a caveat: `resolveAndValidateAttrFilters` skips its
  // numeric-type guard entirely (so `>=` on a keyword becomes a silently
  // lexicographic `range`), `assertFieldExists` blames the tenant's collector
  // config, and `mapping --field` reports a field present in every index as
  // not found. A type the indices agree on is exactly what all three need; the
  // divergence rides along as a flag for the human instead.
  const ignoreAbove = first.definition["ignore_above"];
  const capsAgree = definitions.every((entry) => entry.definition["ignore_above"] === ignoreAbove);
  const aliasAgrees = definitions.every((entry) => entry.aliasOf === first.aliasOf);
  return {
    status: "found",
    mapping: {
      field,
      type: first.definition["type"],
      ...(typeof ignoreAbove === "number" && capsAgree ? { ignoreAbove } : {}),
      ...(capsAgree ? {} : { ignoreAboveVaries: true }),
      ...(first.aliasOf === undefined ? {} : { aliasOf: first.aliasOf }),
      ...(aliasAgrees ? {} : { aliasVaries: true }),
    },
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
  const resolved = findFieldDefinitions(mappingResponse, field)[0];
  if (resolved === undefined) {
    throw new CfOtelError(
      "MAPPING_LOOKUP_FAILED",
      `Field "${field}" was not found in the mapping for ${index}`,
    );
  }
  if (resolved.definition["type"] !== "text") {
    return resolved.aliasOf ?? field;
  }
  const subFields = resolved.definition["fields"];
  if (isRecord(subFields) && isRecord(subFields["keyword"])) {
    // The sub-field hangs off the *target*, not off the alias: an alias
    // registers only its own full name, so `<alias>.keyword` is unmapped — and
    // a `terms` aggregation on an unmapped field returns empty buckets with no
    // error, which is precisely the silent failure this function exists to
    // prevent. Name the target when the field reached here through one.
    return `${resolved.aliasOf ?? field}.keyword`;
  }
  const description = resolved.aliasOf === undefined ? "is text-mapped" : `is an alias onto "${resolved.aliasOf}", which is text-mapped`;
  throw new CfOtelError(
    "MAPPING_LOOKUP_FAILED",
    `Field "${field}" ${description} and has no .keyword sub-field to aggregate on.`,
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
  const lookup = lookUpField(await client.getMapping(index), field);
  if (lookup.status === "found") {
    return;
  }
  // A field that exists everywhere but is typed inconsistently is not a
  // collector-configuration problem, and saying so sends the reader to the
  // wrong system entirely.
  if (lookup.status === "disagrees") {
    throw new CfOtelError(
      "MAPPING_LOOKUP_FAILED",
      `"${field}" is mapped inconsistently across ${index} (${lookup.types.join(", ")}), so ${why}. ` +
        "This is a mapping-template difference between backing indices, not a missing field.",
    );
  }
  throw new CfOtelError(
    "MAPPING_LOOKUP_FAILED",
    `"${field}" is not present in ${index}, so ${why}. ` +
      "This tenant's OpenTelemetry collector is not exporting HTTP request headers.",
  );
}
