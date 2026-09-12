/**
 * Field-mapping lookup for the metrics index pattern.
 *
 * Lived inside `cli/commands/mapping.ts` until 0.12.0. Moving it out is not
 * tidying: while it was module-private the only way to observe it was through
 * four rendered CLI columns, so a mutation that made `lookUpField` read every
 * index's `ignore_above` from the first index alone went undetected by the
 * whole suite — and the same privacy is why `mappedType` was never noticed
 * missing from `@saptools/cf-otel`'s copy, where implicit-object fields were
 * still being reported as absent. Both packages now expose the same surface.
 */

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

export interface FieldMapping {
  readonly field: string;
  /** The resolved type — for a field alias, the type of the field it points at, since that is what a query against it compares. */
  readonly type: string;
  readonly ignoreAbove?: number;
  /**
   * True when the backing indices report different `ignore_above` caps.
   *
   * Surfaced rather than omitted: a `keyword` longer than its cap is stored
   * but never indexed, so it produces no term and cannot match a `term` query
   * or appear in a bucket. A *blank* cap reads as "no cap at all", which is
   * the safe interpretation, exactly inverting the hazard.
   */
  readonly ignoreAboveVaries?: boolean;
  /**
   * Set when `field` is an alias: the path it points at.
   *
   * Usable as a concrete field name only when `type` is something other than
   * `alias`. `type === "alias"` is precisely the signal that the target could
   * not be resolved in the mapping — a dangling path, or a chain this
   * deliberately refuses to follow — and naming it there is a lead for the
   * reader, not a field they can query.
   */
  readonly aliasOf?: string;
  /** True when indices point the same alias at different targets — surfaced, never used to withhold the type. */
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
 * A flat `_source` key like `resource.attributes.sap@cf@app_name` is a single
 * literal key on every *document* (metric documents never nest — see
 * `fields.ts`) — but confirmed live against the real backend, the *mapping
 * tree* for this index pattern still nests on the `.` segments
 * (`properties.resource.properties.attributes.properties["sap@cf@app_name"]`),
 * the same discovery `@saptools/cf-otel` already made for its own span index.
 * A single top-level `properties[field]` lookup found nothing for the entire
 * `resource.*` family — silently breaking `mapping --field` for most of what
 * is worth checking. `@` within one segment never nests further, so splitting
 * only on `.` still resolves a plain, undotted field name in one step.
 *
 * A multi-field is the one thing that hangs off a field's own `fields` block
 * rather than under `properties`, and only ever as the last segment — a
 * sub-field cannot itself carry sub-fields. Descending `properties` alone
 * made the tool contradict itself: `metrics-*` really does map
 * `@timestamp.keyword` and `origin.keyword` (measured live, and both return
 * real aggregation buckets), yet `mapping --field @timestamp.keyword`
 * answered "was not found in the mapping" — the exact untrue message the
 * absent/disagrees split was added to stop producing.
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
 * `metrics-*` maps nine of these (measured live): short names like `app_name`
 * pointing at `resource.attributes.sap@cf@app_name`. Reporting the pointer's
 * own type answers `"alias"`, which is true and useless to someone asking
 * whether the field is safe to aggregate on — the type that governs that is
 * the target's, and OpenSearch resolves the alias in queries and aggregations
 * alike (measured: identical buckets and identical hit counts either way).
 *
 * Exactly one hop. OpenSearch requires an alias's target to be a concrete
 * field, never an object or another alias, so a chain is a malformed mapping;
 * following one would also let a self-referential `path` spin forever. A
 * target that is missing, non-string, or itself an alias leaves the alias
 * definition in place — today's answer plus the target name, never less.
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
 * Why a field has no single answer. The two cases used to be one `undefined`,
 * and `runMapping` reported both as "was not found in the mapping" — untrue,
 * and misleading, for a field that is present in every index and simply
 * mapped inconsistently. That message was introduced with the agreement check
 * itself; separating them is the other half of that fix.
 */
export type FieldLookup =
  | { readonly status: "found"; readonly mapping: FieldMapping }
  | { readonly status: "disagrees"; readonly types: readonly string[] }
  | { readonly status: "absent" };

/**
 * The field's answer across every backing index.
 *
 * Reporting the first index's opinion was safe while this command only
 * reported existence, and unsafe as soon as a caller used the type to decide
 * what terms are legal to send: `metrics-*` spans 41 backing indices
 * (measured live), and a type sampled from one can be wrong for another's
 * shards. Mirrors the fix already shipped in `@saptools/cf-otel`'s own
 * `mapping.ts`, after it hit this for real.
 */
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
  // the type: "no answer" makes `mapping --field` call a field present in
  // every index missing, which is the very message the absent/disagrees split
  // below exists to stop producing. An agreed type with a caveat beside it is
  // strictly more useful than silence.
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
 * Top-level keys alone are what the command listed until 0.12.0, and against
 * the live pattern that meant 46 names for 87 leaf fields: `resource` was
 * shown as a dead end while the nine `resource.attributes.sap@cf@*` fields
 * underneath it — the ones actually worth filtering on — appeared nowhere. It
 * was self-inconsistent as well as thin, because `walkIndexProperties`
 * resolves exactly the nested and multi-field paths the listing omitted, so
 * `mapping --field resource.attributes.sap@cf@app_name` worked on a name the
 * command would not tell anyone existed.
 *
 * Containers stay listed: `object` versus `nested` is the difference between
 * a plain filter and one that needs a `nested` query, which a reader wants to
 * see before they build either.
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
