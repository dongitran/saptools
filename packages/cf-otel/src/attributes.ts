/**
 * Attribute keys in `otel-v1-apm-span-*` are flat, opaque strings that
 * happen to contain literal `.` and `@` characters (e.g.
 * `span.attributes.http@target`) — they are never nested objects reachable
 * by dotted property access. Every helper here treats a key as one atomic
 * string; none of them ever split on `.` or `@`.
 */

/** List every flat attribute-shaped key present on a span's raw document, sorted. */
export function listFlatAttributeKeys(raw: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(raw).sort();
}

/** Read one flat attribute key verbatim; returns `undefined` if absent. */
export function getFlatAttribute(raw: Readonly<Record<string, unknown>>, key: string): unknown {
  return raw[key];
}

/**
 * Both a pre-stabilization and the current stable OTel semantic-convention
 * name are listed for each concept (e.g. `http@target` alongside `url@path`)
 * — confirmed against real production data this session, where spans from a
 * current OTel SDK/instrumentation version used the newer names
 * (`url@path`/`url@full`/`server@address`/`network@peer@address`) with no
 * `http@target`/`net@peer@*` present at all, which had silently made this
 * list, and therefore `--with-samples`, match nothing on every row.
 */
const IDENTIFYING_ATTRIBUTE_PRIORITY: readonly string[] = [
  "span.attributes.url@path",
  "span.attributes.http@target",
  "span.attributes.url@full",
  "span.attributes.http@url",
  "span.attributes.db@query@text",
  "span.attributes.db@statement",
  "span.attributes.server@address",
  "span.attributes.network@peer@address",
  "span.attributes.net@peer@name",
  "span.attributes.net@peer@ip",
];

export interface IdentifyingAttribute {
  readonly key: string;
  readonly value: unknown;
}

/** Pick one representative attribute that best decodes an ambiguous/truncated span `name`. */
export function pickIdentifyingAttribute(
  raw: Readonly<Record<string, unknown>>,
): IdentifyingAttribute | undefined {
  for (const key of IDENTIFYING_ATTRIBUTE_PRIORITY) {
    if (key in raw) {
      return { key, value: raw[key] };
    }
  }
  return undefined;
}
