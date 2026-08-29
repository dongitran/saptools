import { CfOtelError } from "./errors.js";
import { getFieldMapping } from "./mapping.js";
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

async function resolveAttrKey(
  client: OpenSearchClient,
  index: string,
  key: string,
): Promise<{ readonly key: string; readonly mapping: Awaited<ReturnType<typeof getFieldMapping>> }> {
  if (ATTRIBUTE_BAG_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return { key, mapping: await getFieldMapping(client, index, key) };
  }
  for (const prefix of ATTRIBUTE_BAG_PREFIXES) {
    const candidate = `${prefix}${key}`;
    const mapping = await getFieldMapping(client, index, candidate);
    if (mapping !== undefined) {
      return { key: candidate, mapping };
    }
  }
  // Found under neither bag — fall back to the bare key as typed (e.g. a
  // genuinely top-level field, or a dynamically-unmapped attribute that
  // legitimately doesn't appear in the mapping at all).
  return { key, mapping: undefined };
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
): Promise<readonly AttrFilter[]> {
  const resolved: AttrFilter[] = [];
  for (const attr of attrs) {
    const { key, mapping } = await resolveAttrKey(client, index, attr.key);
    if (NUMERIC_ATTR_OPERATORS.has(attr.operator) && mapping !== undefined && !NUMERIC_MAPPING_TYPES.has(mapping.type)) {
      throw new CfOtelError(
        "CONFIG",
        `--attr "${key}${attr.operator}${attr.value}" uses a numeric comparison, but "${key}" is mapped as "${mapping.type}", not a numeric type — this would silently compare as text instead of as numbers. Check with "cf-otel mapping --field ${key}".`,
      );
    }
    resolved.push({ ...attr, key });
  }
  return resolved;
}
