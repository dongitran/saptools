// A minimal in-memory stand-in for the SAP Cloud Logging OpenSearch Dashboards
// console-proxy (see src/opensearch-client.ts), shaped for cf-metrics' actual
// query surface: bool/filter with term/terms/range, sort with
// `unmapped_type: "date"`, and a small generic aggregation executor covering
// `terms` (with explicit `order` on a sub-agg — this is the one real
// production behavior worth exercising end to end, not just unit-mocked: a
// `terms` agg defaults to `_count` bucket ordering, and cf-metrics' `top`
// command depends on its explicit `order` clause actually being honored),
// `date_histogram` (with `fixed_interval`), `avg`/`min`/`max`/`sum` metric
// aggs, and `top_hits`. No `search_after` support needed — none of
// cf-metrics' 9 commands page past a single `_search` window.

import { createServer } from "node:http";

export const FAKE_USERNAME = "fake-dashboards-user";
export const FAKE_PASSWORD = "fake-dashboards-password";
const INDEX_ALIAS = "metrics-otel-v1-000001";

type SourceDoc = Record<string, unknown>;

interface Doc {
  readonly _id: string;
  readonly _source: SourceDoc;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const APP_FIELD = "resource.attributes.sap@cf@app_name";

function gauge(id: string, service: string, name: string, unit: string, time: string, value: number): Doc {
  return { _id: id, _source: { name, kind: "GAUGE", value, unit, time, [APP_FIELD]: service, serviceName: service } };
}

function sumDoc(
  id: string,
  service: string,
  name: string,
  unit: string,
  time: string,
  value: number,
  temporality: "AGGREGATION_TEMPORALITY_DELTA" | "AGGREGATION_TEMPORALITY_CUMULATIVE",
): Doc {
  return {
    _id: id,
    _source: { name, kind: "SUM", value, unit, time, aggregationTemporality: temporality, [APP_FIELD]: service, serviceName: service },
  };
}

function histogramDoc(id: string, service: string, time: string, count: number, sum: number): Doc {
  return {
    _id: id,
    _source: {
      name: "http.server.duration",
      kind: "HISTOGRAM",
      count,
      sum,
      unit: "ms",
      time,
      explicitBounds: [0, 5, 10, 25, 50, 100],
      bucketCounts: [0, count, 0, 0, 0, 0],
      description: "Measures the duration of inbound HTTP requests.",
      [APP_FIELD]: service,
      serviceName: service,
    },
  };
}

function buildDataset(): readonly Doc[] {
  const docs: Doc[] = [];
  let seq = 0;
  function push(doc: Doc): void {
    seq += 1;
    docs.push({ ...doc, _id: `doc-${String(seq)}` });
  }

  // demo-app: two 10-minute buckets (09:00-09:10, 09:10-09:20) for `history`.
  push(gauge("", "demo-app", "container.cpu.usage", "1", "2026-08-28T09:01:00.000Z", 0.05));
  push(gauge("", "demo-app", "container.cpu.usage", "1", "2026-08-28T09:05:00.000Z", 0.06));
  push(gauge("", "demo-app", "container.cpu.usage", "1", "2026-08-28T09:12:00.000Z", 0.15));
  push(gauge("", "demo-app", "container.cpu.usage", "1", "2026-08-28T09:16:00.000Z", 0.17));

  push(gauge("", "demo-app", "container.memory.usage", "By", "2026-08-28T09:01:00.000Z", 400_000_000));
  push(gauge("", "demo-app", "container.memory.usage", "By", "2026-08-28T09:05:00.000Z", 420_000_000));
  push(gauge("", "demo-app", "container.memory.usage", "By", "2026-08-28T09:12:00.000Z", 1_500_000_000));

  push(sumDoc("", "demo-app", "queue.incoming_messages", "each", "2026-08-28T09:01:00.000Z", 5, "AGGREGATION_TEMPORALITY_DELTA"));
  push(sumDoc("", "demo-app", "queue.incoming_messages", "each", "2026-08-28T09:03:00.000Z", 3, "AGGREGATION_TEMPORALITY_DELTA"));
  push(sumDoc("", "demo-app", "queue.incoming_messages", "each", "2026-08-28T09:12:00.000Z", 10, "AGGREGATION_TEMPORALITY_DELTA"));

  // A SUM metric whose latest point reports cumulative temporality, purely to
  // exercise cf-metrics' warning path (see src/kind.ts's isCumulativeTemporality).
  push(sumDoc("", "demo-app", "queue.legacy_counter", "each", "2026-08-28T09:01:00.000Z", 100, "AGGREGATION_TEMPORALITY_CUMULATIVE"));
  push(sumDoc("", "demo-app", "queue.legacy_counter", "each", "2026-08-28T09:10:00.000Z", 140, "AGGREGATION_TEMPORALITY_CUMULATIVE"));

  push(histogramDoc("", "demo-app", "2026-08-28T09:02:00.000Z", 2, 1.5));
  push(histogramDoc("", "demo-app", "2026-08-28T09:04:00.000Z", 3, 2.5));
  push(histogramDoc("", "demo-app", "2026-08-28T09:13:00.000Z", 1, 0.5));

  // `top`: loud-app has FEWER docs but a much higher average — only correct
  // with the code's explicit `order: {avg_value: "desc"}`; the terms agg's
  // own default (`_count` desc) would wrongly rank quiet-app first.
  for (let i = 0; i < 5; i += 1) {
    push(gauge("", "quiet-app", "container.memory.usage", "By", `2026-08-28T09:0${String(i)}:00.000Z`, 100_000_000));
  }
  push(gauge("", "loud-app", "container.memory.usage", "By", "2026-08-28T09:01:00.000Z", 900_000_000));
  push(gauge("", "loud-app", "container.memory.usage", "By", "2026-08-28T09:02:00.000Z", 950_000_000));

  // `top` on a HISTOGRAM metric: fast-app has many fast requests (low avg),
  // slow-app has few slow ones (high avg) — only correct if ranking derives
  // avg from sum/count instead of an avg/max agg on the nonexistent `value`
  // field HISTOGRAM documents don't carry.
  for (let i = 0; i < 4; i += 1) {
    push(histogramDoc("", "fast-app", `2026-08-28T09:0${String(i)}:00.000Z`, 10, 1));
  }
  push(histogramDoc("", "slow-app", "2026-08-28T09:01:00.000Z", 2, 40));

  // Reproduces the real Cloud Foundry data shape that motivated `--unit`:
  // `container.cpu.usage` is published as TWO series under one name, telling
  // them apart only by `unit`. `unit="1"` is a fraction of the app's CPU
  // entitlement, `unit="cpu"` a fraction of one core, ~17x apart. Aggregating
  // both at once yields a meaningless blend, so `history`/`top` must warn.
  //
  // Deliberately on its own app, with timestamps that are neither the newest
  // nor inside any other test's assertions, so no existing expectation about
  // `demo-app`'s single-unit `container.cpu.usage` shifts.
  push(gauge("", "dual-app", "container.cpu.usage", "1", "2026-08-28T09:03:00.000Z", 0.28));
  push(gauge("", "dual-app", "container.cpu.usage", "1", "2026-08-28T09:07:00.000Z", 0.3));
  push(gauge("", "dual-app", "container.cpu.usage", "cpu", "2026-08-28T09:03:00.000Z", 0.016));
  push(gauge("", "dual-app", "container.cpu.usage", "cpu", "2026-08-28T09:07:00.000Z", 0.018));

  // A `watch`-only future point, added lazily by the server on a delay — see
  // `scheduleWatchArrival` below; not part of the static dataset.

  return docs;
}

const DATASET: Doc[] = [...buildDataset()];

/** `watch` polls for new points; this simulates one arriving mid-test. */
export function seedWatchArrival(service: string, name: string, value: number, time: string): void {
  DATASET.push({ _id: `watch-${String(DATASET.length)}`, _source: { name, kind: "GAUGE", value, unit: "1", time, [APP_FIELD]: service, serviceName: service } });
}

function getField(source: SourceDoc, field: string): unknown {
  return field in source ? source[field] : undefined;
}

function firstEntry(value: unknown): readonly [string, unknown] | undefined {
  return isRecord(value) ? Object.entries(value)[0] : undefined;
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
      if (gte !== undefined && !((value as string | number) >= (gte as string | number))) {
        return false;
      }
      if (lte !== undefined && !((value as string | number) <= (lte as string | number))) {
        return false;
      }
    }
    return true;
  }
  return true;
}

/** True when a `range` clause's field spec carries the sort-only `unmapped_type` option. */
function rangeSpecHasUnmappedType(rangeClause: Record<string, unknown>): boolean {
  return Object.values(rangeClause).some((spec) => isRecord(spec) && "unmapped_type" in spec);
}

/**
 * Reject the one query shape real OpenSearch rejects but a permissive fake
 * happily answers: `unmapped_type` is a **sort-only** option, so a `range`
 * clause carrying it fails with a `parsing_exception` (HTTP 400). That exact
 * bug once shipped to production precisely because this fake server accepted
 * it, so every e2e test passed while the real backend returned 400. `sort`
 * clauses legitimately carry the option and are deliberately not flagged —
 * only the `range` key is.
 */
function findIllegalRangeOption(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findIllegalRangeOption(entry);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "range" && isRecord(child) && rangeSpecHasUnmappedType(child)) {
      return "[range] query does not support [unmapped_type]";
    }
    const found = findIllegalRangeOption(child);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function asClauseArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function matchesQuery(source: SourceDoc, query: unknown): boolean {
  if (!isRecord(query) || query["match_all"] !== undefined) {
    return true;
  }
  if (isRecord(query["bool"])) {
    const clauses = asClauseArray(query["bool"]["filter"]);
    return clauses.every((clause) => matchesClause(source, clause));
  }
  return matchesClause(source, query);
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) {
    return 0;
  }
  return (a as string | number) < (b as string | number) ? -1 : 1;
}

function applySort(docs: readonly Doc[], sortSpec: readonly Record<string, unknown>[]): Doc[] {
  const sorted = [...docs];
  sorted.sort((a, b) => {
    for (const entry of sortSpec) {
      const first = firstEntry(entry);
      if (first === undefined) {
        continue;
      }
      const [field, spec] = first;
      const direction = isRecord(spec) ? spec["order"] : spec;
      let cmp = compareValues(getField(a._source, field), getField(b._source, field));
      if (direction === "desc") {
        cmp = -cmp;
      }
      if (cmp !== 0) {
        return cmp;
      }
    }
    return 0;
  });
  return sorted;
}

const INTERVAL_PATTERN = /^(\d+)(s|m|h|d)$/;
const INTERVAL_UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function intervalMillis(fixedInterval: string): number {
  const match = INTERVAL_PATTERN.exec(fixedInterval);
  if (match === null) {
    return 60_000;
  }
  return Number(match[1]) * (INTERVAL_UNIT_MS[match[2] ?? "m"] ?? 60_000);
}

function metricFieldValue(spec: unknown): string {
  return isRecord(spec) && typeof spec["field"] === "string" ? spec["field"] : "value";
}

function numericValues(docs: readonly Doc[], field: string): number[] {
  return docs.map((doc) => getField(doc._source, field)).filter((value): value is number => typeof value === "number");
}

/** Compute one named aggregation (and, for bucket-producing types, its nested sub-aggs) over a doc set. */
function computeAgg(spec: unknown, docs: readonly Doc[]): unknown {
  if (!isRecord(spec)) {
    return undefined;
  }
  if (isRecord(spec["avg"])) {
    const values = numericValues(docs, metricFieldValue(spec["avg"]));
    return { value: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null };
  }
  if (isRecord(spec["min"])) {
    const values = numericValues(docs, metricFieldValue(spec["min"]));
    return { value: values.length > 0 ? Math.min(...values) : null };
  }
  if (isRecord(spec["max"])) {
    const values = numericValues(docs, metricFieldValue(spec["max"]));
    return { value: values.length > 0 ? Math.max(...values) : null };
  }
  if (isRecord(spec["sum"])) {
    const values = numericValues(docs, metricFieldValue(spec["sum"]));
    return { value: values.reduce((a, b) => a + b, 0) };
  }
  if (isRecord(spec["top_hits"])) {
    const topHits = spec["top_hits"];
    const size = typeof topHits["size"] === "number" ? topHits["size"] : 1;
    const sortSpec = asClauseArray(topHits["sort"]);
    const ordered = sortSpec.length > 0 ? applySort(docs, sortSpec) : [...docs];
    return { hits: { hits: ordered.slice(0, size).map((doc) => ({ _id: doc._id, _source: doc._source })) } };
  }
  if (isRecord(spec["terms"])) {
    return computeTermsAgg(spec, docs);
  }
  if (isRecord(spec["date_histogram"])) {
    return computeDateHistogramAgg(spec, docs);
  }
  return undefined;
}

function computeSubAggs(spec: Record<string, unknown>, docs: readonly Doc[]): Record<string, unknown> {
  const subAggs = spec["aggs"];
  if (!isRecord(subAggs)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [name, subSpec] of Object.entries(subAggs)) {
    result[name] = computeAgg(subSpec, docs);
  }
  return result;
}

function computeTermsAgg(spec: Record<string, unknown>, docs: readonly Doc[]): unknown {
  const terms = spec["terms"];
  if (!isRecord(terms) || typeof terms["field"] !== "string") {
    return { buckets: [] };
  }
  const field = terms["field"];
  const size = typeof terms["size"] === "number" ? terms["size"] : 10;
  const order = isRecord(terms["order"]) ? terms["order"] : undefined;

  const groups = new Map<string, Doc[]>();
  for (const doc of docs) {
    const key = getField(doc._source, field);
    if (typeof key !== "string") {
      continue;
    }
    const bucket = groups.get(key) ?? [];
    bucket.push(doc);
    groups.set(key, bucket);
  }

  const buckets: Record<string, unknown>[] = [...groups.entries()].map(([key, bucketDocs]) => ({
    key,
    doc_count: bucketDocs.length,
    ...computeSubAggs(spec, bucketDocs),
  }));

  const [orderAggName, orderDirection] = order === undefined ? [undefined, undefined] : (Object.entries(order)[0] ?? [undefined, undefined]);
  const orderValue = (bucket: Record<string, unknown>): number => {
    if (orderAggName === undefined) {
      return typeof bucket["doc_count"] === "number" ? bucket["doc_count"] : 0;
    }
    const agg = bucket[orderAggName];
    const value = isRecord(agg) ? agg["value"] : undefined;
    return typeof value === "number" ? value : 0;
  };
  buckets.sort((a, b) => {
    const cmp = orderValue(a) < orderValue(b) ? -1 : orderValue(a) > orderValue(b) ? 1 : 0;
    return orderDirection === "asc" ? cmp : -cmp;
  });

  return { buckets: buckets.slice(0, size) };
}

function computeDateHistogramAgg(spec: Record<string, unknown>, docs: readonly Doc[]): unknown {
  const histogram = spec["date_histogram"];
  if (!isRecord(histogram) || typeof histogram["field"] !== "string") {
    return { buckets: [] };
  }
  const field = histogram["field"];
  const stepMs = intervalMillis(typeof histogram["fixed_interval"] === "string" ? histogram["fixed_interval"] : "1m");

  const groups = new Map<number, Doc[]>();
  for (const doc of docs) {
    const raw = getField(doc._source, field);
    if (typeof raw !== "string") {
      continue;
    }
    const epoch = Date.parse(raw);
    const bucketKey = Math.floor(epoch / stepMs) * stepMs;
    const bucket = groups.get(bucketKey) ?? [];
    bucket.push(doc);
    groups.set(bucketKey, bucket);
  }

  const buckets = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, bucketDocs]) => ({
      key,
      key_as_string: new Date(key).toISOString(),
      doc_count: bucketDocs.length,
      ...computeSubAggs(spec, bucketDocs),
    }));
  return { buckets };
}

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
  if (isRecord(aggs)) {
    const aggregations: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(aggs)) {
      aggregations[name] = computeAgg(spec, matches);
    }
    return { hits: { total: { value: matches.length }, hits: [] }, aggregations };
  }

  if (size === 0) {
    return { hits: { total: { value: matches.length }, hits: [] } };
  }

  const sortSpec = asClauseArray(body["sort"]);
  const sorted = sortSpec.length > 0 ? applySort(matches, sortSpec) : matches;
  const page = sorted.slice(0, size);
  return {
    hits: {
      total: { value: matches.length },
      hits: page.map((doc) => ({ _id: doc._id, _source: projectSource(doc._source, body["_source"]) })),
    },
  };
}

function handleCount(body: Record<string, unknown>): unknown {
  return { count: DATASET.filter((doc) => matchesQuery(doc._source, body["query"])).length };
}

function handleMapping(): unknown {
  const properties = {
    name: { type: "keyword", ignore_above: 256 },
    kind: { type: "keyword", ignore_above: 256 },
    value: { type: "double" },
    count: { type: "long" },
    sum: { type: "double" },
    unit: { type: "text" },
    time: { type: "date" },
    "@timestamp": { type: "text" },
    aggregationTemporality: { type: "keyword", ignore_above: 256 },
    [APP_FIELD]: { type: "keyword", ignore_above: 256 },
    serviceName: { type: "keyword", ignore_above: 256 },
    // Real OpenSearch/Elasticsearch mappings never write an explicit
    // "type": "object" — it's only ever implicit from a nested `properties`
    // block with no sibling "type" key, as on real metric documents'
    // `instrumentationScope` field.
    instrumentationScope: {
      properties: {
        name: { type: "keyword", ignore_above: 256 },
        version: { type: "keyword", ignore_above: 256 },
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
      const illegal = findIllegalRangeOption(requestBody);
      if (illegal !== undefined) {
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: { type: "parsing_exception", reason: illegal }, status: 400 }));
        return;
      }
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
        close: async () => {
          await new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          });
        },
      });
    });
  });
}
