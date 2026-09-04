// A minimal in-memory stand-in for the SAP Cloud Logging OpenSearch Dashboards
// console-proxy (see src/opensearch-client.ts). It understands just enough of
// the query DSL (bool/filter with term/terms/range/wildcard, sort +
// search_after pagination, and a `by_trace` terms aggregation with
// min/max/top_hits sub-aggs) to serve the real CLI end to end.

import { createServer } from "node:http";

export const FAKE_USERNAME = "fake-dashboards-user";
export const FAKE_PASSWORD = "fake-dashboards-password";
const INDEX_ALIAS = "otel-v1-apm-span-000001";

type SourceDoc = Record<string, unknown>;

interface Doc {
  readonly _id: string;
  readonly _source: SourceDoc;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildDataset(): readonly Doc[] {
  const docs: Doc[] = [];
  let seq = 0;
  function addSpan(source: SourceDoc): void {
    seq += 1;
    docs.push({ _id: `doc-${String(seq)}`, _source: source });
  }

  // A small trace for selftime/gaps-style tests: root (1s) -> 2x child-a (300ms each).
  addSpan({
    traceId: "trace-small",
    spanId: "root",
    name: "root-op",
    kind: "SPAN_KIND_SERVER",
    serviceName: "service-a",
    startTime: "2026-08-28T03:00:00.000000000Z",
    durationInNanos: 1_000_000_000,
    status: { code: 1 },
  });
  addSpan({
    traceId: "trace-small",
    spanId: "child-1",
    parentSpanId: "root",
    name: "child-a",
    kind: "SPAN_KIND_CLIENT",
    serviceName: "service-a",
    startTime: "2026-08-28T03:00:00.100000000Z",
    durationInNanos: 300_000_000,
    status: { code: 1 },
  });
  addSpan({
    traceId: "trace-small",
    spanId: "child-2",
    parentSpanId: "root",
    name: "child-a",
    kind: "SPAN_KIND_CLIENT",
    serviceName: "service-a",
    startTime: "2026-08-28T03:00:00.500000000Z",
    durationInNanos: 300_000_000,
    status: { code: 2 },
    "span.attributes.http@status_code": "500",
    "span.attributes.http@target": "/widgets",
  });

  // A findable trace on a different service for sample/find.
  addSpan({
    traceId: "trace-findable",
    spanId: "findable-root",
    name: "BatchProcessingService - handle SyncBatchAction",
    kind: "SPAN_KIND_SERVER",
    serviceName: "service-b",
    startTime: "2026-08-28T04:00:00.000000000Z",
    durationInNanos: 5_000_000_000,
    status: { code: 1 },
    // Stored exactly as a real Cloud Logging instance stores an array-valued
    // attribute: the JSON array rendered to text, brackets and quotes included.
    "span.attributes.http@request@header@x-vcap-request-id": '["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]',
  });

  // A big trace (>10000 spans) to exercise search_after pagination end to end.
  const bigTraceId = "trace-big";
  addSpan({
    traceId: bigTraceId,
    spanId: "big-root",
    name: "big-root",
    kind: "SPAN_KIND_SERVER",
    serviceName: "service-c",
    startTime: "2026-08-28T05:00:00.000000000Z",
    durationInNanos: 20_000_000_000,
    status: { code: 1 },
  });
  const BIG_SPAN_COUNT = 10_050;
  for (let i = 0; i < BIG_SPAN_COUNT; i += 1) {
    addSpan({
      traceId: bigTraceId,
      spanId: `big-child-${String(i)}`,
      parentSpanId: "big-root",
      name: "big-child",
      kind: "SPAN_KIND_INTERNAL",
      serviceName: "service-c",
      startTime: `2026-08-28T05:00:00.${String(i).padStart(9, "0")}Z`,
      durationInNanos: 1_000_000,
      status: { code: 1 },
    });
  }

  // Two traces on a fresh, otherwise-unused service, overlapping in time, so
  // `detached` has a real candidate to find end to end — on its own service
  // so it can't shift any existing exact span-count assertion on service-a/b/c.
  addSpan({
    traceId: "trace-detached-ref",
    spanId: "detached-ref-root",
    name: "detached-ref-root",
    kind: "SPAN_KIND_SERVER",
    serviceName: "service-d",
    startTime: "2026-08-28T06:00:00.000000000Z",
    durationInNanos: 1_000_000_000,
    status: { code: 1 },
  });
  addSpan({
    traceId: "trace-detached-candidate",
    spanId: "detached-candidate-root",
    name: "detached-candidate-root",
    kind: "SPAN_KIND_SERVER",
    serviceName: "service-d",
    startTime: "2026-08-28T06:00:00.200000000Z",
    durationInNanos: 50_000_000,
    status: { code: 1 },
  });

  return docs;
}

const DATASET = buildDataset();

function getField(source: SourceDoc, field: string): unknown {
  if (field in source) {
    return source[field];
  }
  const dotIndex = field.indexOf(".");
  if (dotIndex > 0) {
    const outer = source[field.slice(0, dotIndex)];
    if (isRecord(outer)) {
      return outer[field.slice(dotIndex + 1)];
    }
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
}

function firstEntry(value: unknown): readonly [string, unknown] | undefined {
  return isRecord(value) ? Object.entries(value)[0] : undefined;
}

function asDisplayString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function matchesClause(source: SourceDoc, clause: Record<string, unknown>): boolean {
  if (clause["match_all"] !== undefined) {
    return true;
  }
  const term = firstEntry(clause["term"]);
  if (term !== undefined) {
    return getField(source, term[0]) === term[1];
  }
  const terms = firstEntry(clause["terms"]);
  if (terms !== undefined) {
    const [field, values] = terms;
    return Array.isArray(values) && values.includes(getField(source, field));
  }
  const range = firstEntry(clause["range"]);
  if (range !== undefined) {
    const [field, spec] = range;
    const value = getField(source, field);
    if (isRecord(spec)) {
      const gte = spec["gte"];
      const lte = spec["lte"];
      const gt = spec["gt"];
      const lt = spec["lt"];
      if (gte !== undefined && !((value as string | number) >= (gte as string | number))) {
        return false;
      }
      if (lte !== undefined && !((value as string | number) <= (lte as string | number))) {
        return false;
      }
      if (gt !== undefined && !((value as string | number) > (gt as string | number))) {
        return false;
      }
      if (lt !== undefined && !((value as string | number) < (lt as string | number))) {
        return false;
      }
    }
    return true;
  }
  const wildcard = firstEntry(clause["wildcard"]);
  if (wildcard !== undefined) {
    const [field, spec] = wildcard;
    const pattern = typeof spec === "string" ? spec : isRecord(spec) && typeof spec["value"] === "string" ? spec["value"] : "*";
    return wildcardToRegExp(pattern).test(asDisplayString(getField(source, field)));
  }
  return true;
}

function asClauseArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function matchesQuery(source: SourceDoc, query: unknown): boolean {
  if (!isRecord(query) || query["match_all"] !== undefined) {
    return true;
  }
  if (isRecord(query["bool"])) {
    const bool = query["bool"];
    const clauses = [...asClauseArray(bool["filter"]), ...asClauseArray(bool["must"])];
    const notClauses = asClauseArray(bool["must_not"]);
    return clauses.every((clause) => matchesClause(source, clause)) && notClauses.every((clause) => !matchesClause(source, clause));
  }
  return matchesClause(source, query);
}

interface SortedEntry {
  readonly doc: Doc;
  readonly key: readonly unknown[];
}

function sortKeyFor(doc: Doc, sortSpec: readonly Record<string, unknown>[]): readonly unknown[] {
  return sortSpec.map((entry) => {
    const first = firstEntry(entry);
    if (first === undefined) {
      return undefined;
    }
    return first[0] === "_id" ? doc._id : getField(doc._source, first[0]);
  });
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) {
    return 0;
  }
  return (a as string | number) < (b as string | number) ? -1 : 1;
}

function applySort(docs: readonly Doc[], sortSpec: readonly Record<string, unknown>[]): SortedEntry[] {
  const withKeys: SortedEntry[] = docs.map((doc) => ({ doc, key: sortKeyFor(doc, sortSpec) }));
  withKeys.sort((a, b) => {
    for (const [index, entry] of sortSpec.entries()) {
      const direction = firstEntry(entry)?.[1];
      let cmp = compareValues(a.key[index], b.key[index]);
      if (direction === "desc") {
        cmp = -cmp;
      }
      if (cmp !== 0) {
        return cmp;
      }
    }
    return 0;
  });
  return withKeys;
}

interface AggregationBucket {
  docCount: number;
  minStart: string | undefined;
  maxDuration: number;
  firstDoc: Doc | undefined;
}

// Real OpenSearch `_source` filtering also supports dot-path projection into
// nested objects (e.g. "status.code" pulling just that sub-field out of a
// nested `status` object); this fake only projects exact top-level keys,
// which is enough to catch a command that forgets to request a field it
// unconditionally needs (e.g. traceId/spanId), the class of bug this exists
// to catch, without reimplementing full ES/OS source-filtering semantics.
function projectSource(source: SourceDoc, sourceFields: unknown): SourceDoc {
  if (!Array.isArray(sourceFields)) {
    return source;
  }
  const allowed = new Set(sourceFields.filter((field): field is string => typeof field === "string"));
  const projected: SourceDoc = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key)) {
      projected[key] = value;
    }
  }
  return projected;
}

function handleSearch(body: Record<string, unknown>): unknown {
  const matches = DATASET.filter((doc) => matchesQuery(doc._source, body["query"]));
  const size = typeof body["size"] === "number" ? body["size"] : 10;

  const aggs = body["aggs"];
  if (isRecord(aggs) && isRecord(aggs["by_trace"])) {
    const byTrace = new Map<string, AggregationBucket>();
    for (const doc of matches) {
      const traceId = String(doc._source["traceId"]);
      const startTime = String(doc._source["startTime"]);
      const duration = typeof doc._source["durationInNanos"] === "number" ? doc._source["durationInNanos"] : 0;
      const bucket = byTrace.get(traceId) ?? { docCount: 0, minStart: undefined, maxDuration: 0, firstDoc: undefined };
      bucket.docCount += 1;
      if (bucket.minStart === undefined || startTime < bucket.minStart) {
        bucket.minStart = startTime;
      }
      bucket.maxDuration = Math.max(bucket.maxDuration, duration);
      if (bucket.firstDoc === undefined || startTime < String(bucket.firstDoc._source["startTime"])) {
        bucket.firstDoc = doc;
      }
      byTrace.set(traceId, bucket);
    }
    const buckets = [...byTrace.entries()].map(([traceId, bucket]) => ({
      key: traceId,
      doc_count: bucket.docCount,
      min_start: { value_as_string: bucket.minStart },
      max_duration: { value: bucket.maxDuration },
      first_hit: { hits: { hits: [{ _source: bucket.firstDoc?._source ?? {} }] } },
    }));
    return { hits: { total: { value: matches.length }, hits: [] }, aggregations: { by_trace: { buckets } } };
  }

  if (size === 0) {
    return { hits: { total: { value: matches.length }, hits: [] } };
  }

  const sortSpec = asClauseArray(body["sort"]);
  const sorted = sortSpec.length > 0 ? applySort(matches, sortSpec) : matches.map((doc) => ({ doc, key: [] }));
  let startIndex = 0;
  const searchAfter = body["search_after"];
  if (searchAfter !== undefined) {
    const cursor = JSON.stringify(searchAfter);
    const foundIndex = sorted.findIndex((entry) => JSON.stringify(entry.key) === cursor);
    startIndex = foundIndex === -1 ? 0 : foundIndex + 1;
  }
  const page = sorted.slice(startIndex, startIndex + size);
  return {
    hits: {
      total: { value: matches.length },
      hits: page.map((entry) => ({
        _id: entry.doc._id,
        _source: projectSource(entry.doc._source, body["_source"]),
        sort: entry.key,
      })),
    },
  };
}

function handleCount(body: Record<string, unknown>): unknown {
  const matches = DATASET.filter((doc) => matchesQuery(doc._source, body["query"]));
  return { count: matches.length };
}

function handleMapping(): unknown {
  const properties = {
    name: { type: "keyword", ignore_above: 1024 },
    serviceName: { type: "keyword", ignore_above: 256 },
    traceId: { type: "keyword" },
    spanId: { type: "keyword" },
    parentSpanId: { type: "keyword" },
    kind: { type: "keyword" },
    startTime: { type: "date" },
    durationInNanos: { type: "long" },
    "status.code": { type: "long" },
    // A real Cloud Logging mapping nests on the "." segments even though the
    // document keys are flat, so an attribute lookup has to walk the tree. The
    // `=` operator reads the resolved type from here to decide whether the
    // array-rendered encoding is safe to send.
    span: {
      properties: {
        attributes: {
          properties: {
            "http@request@header@x-vcap-request-id": { type: "keyword", ignore_above: 2048 },
            "http@status_code": { type: "keyword", ignore_above: 256 },
            "http@response@status_code": { type: "integer" },
          },
        },
      },
    },
  };
  return { [INDEX_ALIAS]: { mappings: { properties } } };
}

export interface FakeOpenSearch {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** Start the fake OpenSearch Dashboards console-proxy server on an ephemeral port. */
export async function startFakeOpenSearch(): Promise<FakeOpenSearch> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/console/proxy" || req.method !== "POST") {
      res.writeHead(404).end("not found");
      return;
    }
    const expectedAuth = `Basic ${Buffer.from(`${FAKE_USERNAME}:${FAKE_PASSWORD}`).toString("base64")}`;
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    if (req.headers["osd-xsrf"] !== "true") {
      res.writeHead(400).end("missing osd-xsrf header");
      return;
    }
    const path = url.searchParams.get("path") ?? "";
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body: unknown = raw.length > 0 ? JSON.parse(raw) : {};
      const requestBody = isRecord(body) ? body : {};
      let result: unknown;
      if (path.endsWith("_count")) {
        result = handleCount(requestBody);
      } else if (path.endsWith("_mapping")) {
        result = handleMapping();
      } else {
        result = handleSearch(requestBody);
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    });
  });
  return await new Promise<FakeOpenSearch>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        close: async () => { await new Promise<void>((done) => server.close(() => { done(); })); },
      });
    });
  });
}
