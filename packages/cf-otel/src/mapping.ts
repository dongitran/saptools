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
  /**
   * Set when `field` is an alias: the path it points at, from the first index that declared it.
   *
   * Usable as a concrete field name only when `type` is something other than
   * `alias`. `type === "alias"` is exactly the signal that the target could not
   * be resolved — a dangling path, or a chain this refuses to follow — so there
   * it is a lead for the reader, not a field they can query.
   */
  readonly aliasOf?: string;
  /** True when indices point the same alias at different targets — surfaced, never used to withhold the type (see {@link findFieldInMapping}). */
  readonly aliasVaries?: boolean;
  /**
   * Nearest ancestor mapped `nested`, when the field sits inside one.
   *
   * A plain filter or aggregation on such a field matches nothing and reports
   * no error; it needs a `nested` query scoped to this path. Listing these
   * fields without saying so would advertise a silent dead end — see
   * {@link WalkResult.nestedUnder}.
   */
  readonly nestedUnder?: string;
  /** True when the indices disagree about which nested parent the field sits under. */
  readonly nestedVaries?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An own, record-valued property — `Object.hasOwn` so an inherited key like `__proto__` cannot masquerade as a mapped field. */
function ownRecord(container: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(container) || !Object.hasOwn(container, key)) {
    return undefined;
  }
  const value = container[key];
  return isRecord(value) ? value : undefined;
}

/**
 * OpenSearch/Elasticsearch field mappings omit `type` entirely for an object
 * field — `object` is only ever implicit, never written out. Measured against
 * the live span index, twelve container fields are declared that way,
 * `span`, `span.attributes`, `resource` and `resource.attributes` among them,
 * and treating a missing `type` as "no answer" reported every one of them as
 * absent: `mapping --field span` answered "was not found in the mapping" for a
 * field present in all fifteen backing indices, and the listing printed
 * `unknown`, the sentinel reserved for a field this version could not read.
 * `@saptools/cf-metrics` has had this since it hit the same thing on
 * `instrumentationScope`; the port was missed when the rest of the lookup was
 * unified.
 */
function mappedType(entry: Record<string, unknown>): string {
  const type = entry["type"];
  if (typeof type === "string") {
    return type;
  }
  return isRecord(entry["properties"]) ? "object" : "unknown";
}

interface WalkResult {
  readonly definition: Record<string, unknown>;
  /**
   * Nearest ancestor mapped `nested`, when there is one.
   *
   * A `nested` parent stores its children as separate hidden documents, so a
   * plain `term`/`range`/`terms` on a field inside one matches nothing and
   * reports no error — measured live: `buckets.count`, `exemplars.spanId` and
   * `quantiles.value` each return zero buckets with zero shard failures, while
   * an ordinary sibling returns real ones. Reaching them needs a `nested`
   * query scoped to this path, which no command here builds, so the honest
   * answer is to say where the field lives rather than to hide it.
   */
  readonly nestedUnder?: string;
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
 * A multi-field is the one thing that hangs off a field's own `fields` block
 * rather than under `properties`, and only ever as the last segment — a
 * sub-field cannot itself carry sub-fields. Descending `properties` alone made
 * the module contradict itself: `resolveAggregatableField` hands back
 * `description.keyword`, and `mapping --field description.keyword` then
 * answered "was not found in the mapping" for it. The span index really does
 * map six of these (`traceState.keyword`, `derived.*.keyword`), and they
 * aggregate normally.
 */
function walkIndexProperties(mappings: Record<string, unknown>, field: string): WalkResult | undefined {
  const segments = field.split(".");
  let properties: unknown = mappings["properties"];
  let fieldDef: Record<string, unknown> | undefined;
  let nestedUnder: string | undefined;
  let walked = "";
  for (const [index, segment] of segments.entries()) {
    const isLastSegment = index === segments.length - 1;
    const node = ownRecord(properties, segment);
    if (node === undefined) {
      const subField = isLastSegment && fieldDef !== undefined ? ownRecord(fieldDef["fields"], segment) : undefined;
      return subField === undefined ? undefined : { definition: subField, ...(nestedUnder === undefined ? {} : { nestedUnder }) };
    }
    walked = walked === "" ? segment : `${walked}.${segment}`;
    // An ancestor's `nested` type governs its descendants, not its own row —
    // the row for the nested field itself already reports `nested`.
    if (!isLastSegment && node["type"] === "nested") {
      nestedUnder = walked;
    }
    fieldDef = node;
    properties = node["properties"];
  }
  return fieldDef === undefined ? undefined : { definition: fieldDef, ...(nestedUnder === undefined ? {} : { nestedUnder }) };
}

/** One index's answer for a field: its definition, and the alias target it was reached through. */
interface IndexDefinition {
  readonly definition: Record<string, unknown>;
  readonly aliasOf?: string;
  readonly nestedUnder?: string;
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
function resolveAlias(mappings: Record<string, unknown>, walked: WalkResult): IndexDefinition {
  const nested = walked.nestedUnder === undefined ? {} : { nestedUnder: walked.nestedUnder };
  if (walked.definition["type"] !== "alias") {
    return { definition: walked.definition, ...nested };
  }
  const path = walked.definition["path"];
  if (typeof path !== "string") {
    return { definition: walked.definition, ...nested };
  }
  const target = walkIndexProperties(mappings, path);
  if (target === undefined || target.definition["type"] === "alias") {
    return { definition: walked.definition, aliasOf: path, ...nested };
  }
  // The target is what a query against the alias actually compares, so its
  // position in the tree is the one that governs reachability.
  return { definition: target.definition, aliasOf: path, ...(target.nestedUnder === undefined ? {} : { nestedUnder: target.nestedUnder }) };
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
    const walked = walkIndexProperties(mappings, field);
    if (walked !== undefined) {
      found.push(resolveAlias(mappings, walked));
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
  if (first === undefined) {
    return { status: "absent" };
  }
  const type = mappedType(first.definition);
  const types = [...new Set(definitions.map((entry) => mappedType(entry.definition)))];
  if (types.length > 1) {
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
  const nestingAgrees = definitions.every((entry) => entry.nestedUnder === first.nestedUnder);
  return {
    status: "found",
    mapping: {
      field,
      type,
      ...(typeof ignoreAbove === "number" && capsAgree ? { ignoreAbove } : {}),
      ...(capsAgree ? {} : { ignoreAboveVaries: true }),
      ...(first.aliasOf === undefined ? {} : { aliasOf: first.aliasOf }),
      ...(aliasAgrees ? {} : { aliasVaries: true }),
      ...(first.nestedUnder === undefined ? {} : { nestedUnder: first.nestedUnder }),
      ...(nestingAgrees ? {} : { nestedVaries: true }),
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
 *
 * Routed through {@link lookUpField} rather than the first index's opinion.
 * Sampling index `[0]` is the very hazard the rest of this module was
 * rewritten to remove, and here it decided the aggregation target: for a field
 * mapped `text` in one backing index and `keyword` in another, the answer
 * flipped between `<field>.keyword` and `<field>` on nothing but `_mapping`
 * key order, and whichever way it fell the disagreeing indices' shards
 * returned empty buckets with no error.
 */
export async function resolveAggregatableField(
  client: OpenSearchClient,
  index: string,
  field: string,
): Promise<string> {
  const mappingResponse = await client.getMapping(index);
  const lookup = lookUpField(mappingResponse, field);
  if (lookup.status === "absent") {
    throw new CfOtelError(
      "MAPPING_LOOKUP_FAILED",
      `Field "${field}" was not found in the mapping for ${index}`,
    );
  }
  if (lookup.status === "disagrees") {
    throw new CfOtelError(
      "MAPPING_LOOKUP_FAILED",
      `Field "${field}" is mapped inconsistently across the backing indices of ${index} ` +
        `(${lookup.types.join(", ")}), so no single aggregation target is safe: the indices that ` +
        "disagree would contribute empty buckets with no error. Narrow the query to one index.",
    );
  }
  const { type, aliasOf, aliasVaries, nestedUnder } = lookup.mapping;
  // Both of these aggregate to zero buckets with zero shard failures — measured
  // live on `span`, `span.attributes`, `events`, `resource` and `exemplars` —
  // which is exactly the silent answer this function exists to turn into a loud
  // one. Neither was refused before; the lookup only started reporting implicit
  // containers and nested parentage in 0.9.0, so until now there was nothing to
  // refuse them with.
  if (type === "object" || type === "nested") {
    throw new CfOtelError(
      "MAPPING_LOOKUP_FAILED",
      `Field "${field}" is ${type === "object" ? "an" : "a"} ${type} container, not a field that holds a value, so aggregating on it ` +
        "returns empty buckets with no error. Aggregate on one of the fields inside it instead.",
    );
  }
  if (nestedUnder !== undefined) {
    throw new CfOtelError(
      "MAPPING_LOOKUP_FAILED",
      `Field "${field}" is inside the nested "${nestedUnder}" documents, which a plain aggregation cannot reach: ` +
        "it returns empty buckets with no error. Reaching it needs a nested aggregation scoped to that path.",
    );
  }
  if (type !== "text") {
    // Deliberately the field as asked for, not `aliasOf`. OpenSearch resolves
    // an alias in aggregations exactly as it does in queries (measured:
    // identical buckets and hit counts either way), so naming the target buys
    // nothing — while an alias whose target this could not resolve, or one the
    // indices point at inconsistently, would name a field that some index does
    // not map at all, and a `terms` aggregation on an unmapped field returns
    // empty buckets with no error.
    return field;
  }
  if (aliasVaries === true) {
    throw new CfOtelError(
      "MAPPING_LOOKUP_FAILED",
      `Field "${field}" is an alias pointing at different targets across the backing indices of ${index}, ` +
        "so its .keyword sub-field cannot be named safely. Aggregate on the concrete target field instead.",
    );
  }
  // `lookUpField` agrees the type across indices but says nothing about
  // sub-fields, and `fields` is what decides the target: with `text` in both
  // indices and `.keyword` in only one, taking index [0]'s answer flipped
  // between `<field>.keyword` and a "no .keyword sub-field" error on nothing
  // but `_mapping` key order — and the winning branch dropped the other
  // index's shards into empty buckets with no error.
  const definitions = findFieldDefinitions(mappingResponse, field);
  const hasKeyword = (entry: IndexDefinition): boolean => {
    const subFields = entry.definition["fields"];
    return isRecord(subFields) && isRecord(subFields["keyword"]);
  };
  if (definitions.some(hasKeyword) && !definitions.every(hasKeyword)) {
    throw new CfOtelError(
      "MAPPING_LOOKUP_FAILED",
      `Field "${field}" is text-mapped, and only some backing indices of ${index} give it a .keyword sub-field, ` +
        "so no single aggregation target covers them all: the rest would contribute empty buckets with no error.",
    );
  }
  if (definitions.length > 0 && definitions.every(hasKeyword)) {
    // The sub-field hangs off the *target*, not off the alias: an alias
    // registers only its own full name, so `<alias>.keyword` is unmapped — and
    // a `terms` aggregation on an unmapped field returns empty buckets with no
    // error, which is precisely the silent failure this function exists to
    // prevent. Name the target when the field reached here through one.
    return `${aliasOf ?? field}.keyword`;
  }
  const description = aliasOf === undefined ? "is text-mapped" : `is an alias onto "${aliasOf}", which is text-mapped`;
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

/**
 * OpenSearch's own `index.mapping.depth.limit` defaults to 20, so this ceiling
 * is far above any mapping a cluster will serve — it exists so a malformed or
 * hostile `_mapping` cannot turn a listing into an uncaught `RangeError`
 * (measured: ~8,000 levels overflow the stack, and `JSON.parse` happily
 * accepts 25,000). The previous top-level-only listing could not recurse at all.
 */
const MAX_MAPPING_DEPTH = 100;

function collectFieldNames(properties: Record<string, unknown>, prefix: string, into: Set<string>, depth = 0): void {
  if (depth >= MAX_MAPPING_DEPTH) {
    return;
  }
  for (const [key, value] of Object.entries(properties)) {
    if (!isRecord(value)) {
      continue;
    }
    const path = prefix === "" ? key : `${prefix}.${key}`;
    into.add(path);
    const subFields = value["fields"];
    if (isRecord(subFields)) {
      for (const name of Object.keys(subFields)) {
        into.add(`${path}.${name}`);
      }
    }
    const nested = value["properties"];
    if (isRecord(nested)) {
      collectFieldNames(nested, path, into, depth + 1);
    }
  }
}

/**
 * Every field name the mapping declares, container nodes included.
 *
 * Top-level keys alone are what `mapping` listed until 0.9.0, and against the
 * live span index that meant 32 names for 173 leaf fields — 111 of the hidden
 * ones under `span.attributes.` and 15 under `resource.attributes.`, which are
 * precisely the two bags `--attr` resolves a key against. The command whose
 * stated job is field discovery showed none of the fields the package's main
 * filter flag can use, while `walkIndexProperties` resolved every one of them
 * by name — a listing inconsistent with its own lookup.
 *
 * Containers stay listed: `object` versus `nested` is the difference between a
 * plain filter and one that needs a `nested` query.
 */
export function listAllFieldNames(mappingResponse: unknown): readonly string[] {
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
    if (isRecord(properties)) {
      collectFieldNames(properties, "", names);
    }
  }
  return [...names].sort();
}
