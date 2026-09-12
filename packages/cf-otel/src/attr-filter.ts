import { CfOtelError } from "./errors.js";
import { lookUpField } from "./mapping.js";
import type { FieldLookup } from "./mapping.js";
import type { OpenSearchClient } from "./opensearch-client.js";
import type { AttrFilter, AttrOperator } from "./types.js";

const OPERATORS: readonly AttrOperator[] = [">=", "<=", ">", "<", "=", "~"];
// Alternation order matters: at a given match position, regex tries earlier
// alternatives first, so ">=" must be listed before "=" or ">" or it would
// never win — a plain longest-op-first indexOf loop instead picks up the "="
// *inside* ">=" once the ">=" candidate is rejected for an empty key/value.
const OPERATOR_PATTERN = new RegExp(`(${OPERATORS.join("|")})`);

/** Parse one `<key><op><value>` `--attr` expression, e.g. `http@status_code>=400`. */
export function parseAttrFilter(expression: string): AttrFilter {
  const match = OPERATOR_PATTERN.exec(expression);
  if (match !== null) {
    const operator = match[0] as AttrOperator;
    const key = expression.slice(0, match.index);
    const value = expression.slice(match.index + operator.length);
    if (key.length > 0 && value.length > 0) {
      return { key, operator, value };
    }
  }
  throw new CfOtelError(
    "CONFIG",
    `Invalid --attr expression "${expression}"; expected <key><op><value> with one of: ${OPERATORS.join(", ")}`,
  );
}

const NUMERIC_ATTR_OPERATORS: ReadonlySet<AttrOperator> = new Set([">=", "<=", ">", "<"]);
const NUMERIC_MAPPING_TYPES: ReadonlySet<string> = new Set([
  "long",
  "integer",
  "short",
  "byte",
  "double",
  "float",
  "half_float",
  "scaled_float",
  "unsigned_long",
]);

// A bare --attr key like "http@status_code" (this tool's own documented
// shorthand, e.g. `--attr 'http@status_code>=400'`) is not itself a real
// document field — confirmed against a real Cloud Logging instance this
// session, real span/resource attributes are always stored under one of
// these two prefixes. Querying the bare key directly targets a field that
// doesn't exist, which OpenSearch simply never matches — no error, just
// silent, total non-functionality of every bare-key --attr filter. Span is
// checked first since every one of this tool's own --attr examples (http,
// db, net) is a span-level attribute.
const ATTRIBUTE_BAG_PREFIXES: readonly string[] = ["span.attributes.", "resource.attributes."];

/**
 * Types that name a place in the document rather than a value in it.
 *
 * A `term` on either matches nothing and reports no error. `object` only
 * started reaching this point once the lookup learned to report implicit
 * containers instead of calling them absent — before that they fell into the
 * "matches no field" notice, which was wrong about the reason but right about
 * the consequence, so reporting the type without this check quietly removed
 * the only warning the caller got. `nested` never had one: its children live
 * in separate hidden documents, and the parent itself is not a value either.
 * Twelve of these exist on the live span index, and the field listing now
 * prints every one of them as a row a caller can copy straight into `--attr`.
 */
const CONTAINER_MAPPING_TYPES: ReadonlySet<string> = new Set(["object", "nested"]);

async function resolveAttrKey(
  client: OpenSearchClient,
  index: string,
  key: string,
): Promise<{ readonly key: string; readonly lookup: FieldLookup }> {
  if (ATTRIBUTE_BAG_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return { key, lookup: lookUpField(await client.getMapping(index), key) };
  }
  for (const prefix of ATTRIBUTE_BAG_PREFIXES) {
    const candidate = `${prefix}${key}`;
    const lookup = lookUpField(await client.getMapping(index), candidate);
    // "Not absent" owns the key, not "has a usable type". The probe used to
    // ask for a resolved type, so a field the indices typed inconsistently —
    // or, before `mappedType` landed, an object-typed one — read as "not in
    // this bag" and the loop fell through to the bare key, which the comment
    // above establishes is never a real field. The filter then matched
    // nothing at exit 0 and the notice told the caller to check a spelling
    // that was already correct.
    if (lookup.status !== "absent") {
      // Trade-off worth naming: a `disagrees` here also claims the key, so a
      // clean match under `resource.attributes.` would be shadowed. Measured on
      // the live index that cannot happen — the two bags share no key at all,
      // and no field disagrees — and claiming the bag the field really is in
      // beats falling through to a bare name that is never a field.
      return { key: candidate, lookup };
    }
  }
  // Found under neither bag — fall back to the bare key as typed, but look it
  // up too. `status.code`, `kind` and `serviceName` are real top-level fields,
  // and skipping the lookup left them with no resolved type at all, which in
  // turn denied `=` the information it needs. The lookup is free: every
  // `getMapping` on one client is served from the same memoized response.
  return { key, lookup: lookUpField(await client.getMapping(index), key) };
}

/**
 * Resolve every `--attr` key to the real, full document field path it
 * actually names, and — for a numeric comparison (`>=`,`<=`,`>`,`<`) —
 * confirm the resolved field is actually numeric-mapped before it's used to
 * build an OpenSearch `range` query, which silently performs lexicographic
 * string comparison against a non-numeric field instead of erroring
 * (confirmed against a real Cloud Logging instance this session: the exact
 * field from this tool's own headline example, `http@status_code`, is
 * `keyword`-mapped, while a newer-semconv sibling field,
 * `http@response@status_code`, is correctly `integer`). One mapping lookup
 * per attr (not two) — resolution and the numeric-type check share it. This
 * mirrors `resolveAggregatableField`'s existing "check the mapping, fail
 * loudly on a mismatch" pattern for aggregations.
 */
export async function resolveAndValidateAttrFilters(
  client: OpenSearchClient,
  index: string,
  attrs: readonly AttrFilter[],
  onNotice?: (message: string) => void,
): Promise<readonly AttrFilter[]> {
  const resolved: AttrFilter[] = [];
  for (const attr of attrs) {
    const { key, lookup } = await resolveAttrKey(client, index, attr.key);
    if (lookup.status === "disagrees") {
      // A field present in every index but typed inconsistently has no type
      // that is safe to compare against, and saying "matches no field" would
      // send the reader after a typo that is not there.
      if (NUMERIC_ATTR_OPERATORS.has(attr.operator)) {
        throw new CfOtelError(
          "CONFIG",
          `--attr "${key}${attr.operator}${attr.value}" uses a numeric comparison, but "${key}" is mapped inconsistently across the backing indices of ${index} (${lookup.types.join(", ")}), so no single type is safe to compare against — on the non-numeric ones this would silently compare as text. Narrow the query to one index, or filter on a field the indices agree on.`,
        );
      }
      onNotice?.(
        `--attr "${key}" is mapped inconsistently across the backing indices of ${index} (${lookup.types.join(", ")}); ` +
          "this filter may match on some shards and not others. The field exists — this is a mapping-template difference, not a typo.",
      );
      // Deliberately no `mappedType`, so `=` builds a plain `term` rather than
      // the array-rendered disjunction. That looks like a missing case and is
      // not one: with no agreed type the disjunction could be aimed at a
      // numeric index, and a `terms` clause carrying `["404"]` against a `long`
      // is a `query_shard_exception`, not a miss — measured live. A clause that
      // may under-match beats one that turns the whole query into an error.
      resolved.push({ ...attr, key });
      continue;
    }
    const mapping = lookup.status === "found" ? lookup.mapping : undefined;
    // Reachability first, and as a notice rather than an error: these say the
    // clause cannot match whatever the value is, which is worth knowing even
    // when the numeric guard below then rejects the comparison outright.
    if (mapping !== undefined && CONTAINER_MAPPING_TYPES.has(mapping.type)) {
      onNotice?.(
        `--attr "${key}" names ${mapping.type === "object" ? "an" : "a"} ${mapping.type} container, not a field that holds a value; ` +
          "this filter can only return an empty result. Name one of the fields inside it — " +
          `"cf-otel mapping" lists them.`,
      );
    } else if (mapping?.nestedUnder !== undefined) {
      // `events.attributes.exception@type` and its siblings resolve cleanly and
      // then match nothing: a `nested` parent stores its children as separate
      // hidden documents, reachable only through a `nested` query scoped to
      // that path, which no command here builds. Silence would look exactly
      // like "that value never occurred" — and the listing now shows these
      // fields, so a caller can reach this by following the tool's own output.
      onNotice?.(
        `--attr "${key}" is inside the nested "${mapping.nestedUnder}" documents, which a plain filter cannot reach; ` +
          "this clause can only return an empty result. Filter on a top-level field instead.",
      );
    } else if (mapping === undefined) {
      // Not in any of the pattern's indices, so this clause cannot match
      // anything — and an empty result would read exactly like "that value
      // never occurred". Say so rather than let the run look conclusive. A
      // notice, not an error: a field can legitimately be absent from the
      // mapping while still being the key the caller meant.
      onNotice?.(
        `--attr "${key}" matches no field in ${index}; this filter can only return an empty result. ` +
          `Check the spelling with "cf-otel fields <traceId>" or "cf-otel mapping --field ${key}".`,
      );
    }
    if (NUMERIC_ATTR_OPERATORS.has(attr.operator) && mapping !== undefined && !NUMERIC_MAPPING_TYPES.has(mapping.type)) {
      throw new CfOtelError(
        "CONFIG",
        `--attr "${key}${attr.operator}${attr.value}" uses a numeric comparison, but "${key}" is mapped as "${mapping.type}", not a numeric type — this would silently compare as text instead of as numbers. Check with "cf-otel mapping --field ${key}".`,
      );
    }
    // Spread-guarded: `exactOptionalPropertyTypes` rejects an explicit `undefined`.
    resolved.push({ ...attr, key, ...(mapping === undefined ? {} : { mappedType: mapping.type }) });
  }
  return resolved;
}
