import { createServer } from "node:http";

export const FAKE_USERNAME = "fake-dashboards-user";
export const FAKE_PASSWORD = "fake-dashboards-password";

interface Doc {
  readonly _id: string;
  readonly _source: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rtrDoc(id: string, appName: string, timestamp: string, status: number, vcapRequestId: string, traceId: string): Doc {
  return {
    _id: id,
    _source: {
      "@timestamp": timestamp,
      source_type: "RTR",
      app_name: appName,
      space_name: "app",
      organization_name: "acme-demo-org",
      method: "GET",
      request: "/SystemConfigService/getBrokerConfig()",
      response_status: status,
      response_time_ms: 16.9,
      vcap_request_id: vcapRequestId,
      correlation_id: "22222222-2222-4222-8222-222222222222",
      trace_id: traceId,
      span_id: "beefbeefbeefbeef",
    },
  };
}

function appLogDoc(id: string, appName: string, timestamp: string, level: string, msg: string, correlationId: string): Doc {
  return {
    _id: id,
    _source: {
      "@timestamp": timestamp,
      source_type: "APP/PROC/WEB",
      app_name: appName,
      space_name: "app",
      organization_name: "acme-demo-org",
      level,
      logger: "remote",
      msg,
      correlation_id: correlationId,
      // Regression fixture for the verified trace_id gotcha: on an APP-log
      // document this field is unreliable — sometimes a de-hyphenated
      // correlation_id as modeled here, sometimes (a live sample found ~42%
      // of the time) a genuinely different real trace id instead — and the
      // row-mapper (unit-tested already) must ignore it either way.
      trace_id: correlationId.replace(/-/g, ""),
    },
  };
}

/**
 * The real CLI is spawned as a subprocess (`runCli`) and reads the actual
 * system clock — unlike the unit tests, there is no `now: () => Date` to
 * freeze. `search`/`count`/`apps` all default to `--since 1h`, so fixture
 * timestamps must stay recent relative to whenever the suite actually runs,
 * not pinned to the date this fixture was authored. Anchored 5 minutes ago,
 * preserving the exact original relative gaps between the four documents
 * (rtr-2 1.957s before rtr-1, app-1 ~3m7.913s before rtr-1, app-2 1.044s
 * before app-1) so sort-order and "same request" groupings are unchanged.
 */
function isoOffsetFromNow(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function buildDataset(): readonly Doc[] {
  const rtr1Ago = 5 * 60_000;
  const rtr2Ago = rtr1Ago + 1_957;
  const app1Ago = rtr1Ago + 187_913;
  const app2Ago = app1Ago + 1_044;
  return [
    rtrDoc("rtr-1", "acme-svc-config", isoOffsetFromNow(rtr1Ago), 200, "11111111-1111-4111-8111-111111111111", "deaddeaddeaddeaddeaddeaddeaddead"),
    rtrDoc("rtr-2", "acme-svc-config", isoOffsetFromNow(rtr2Ago), 500, "44444444-4444-4444-8444-444444444444", "facefacefacefacefacefacefaceface"),
    appLogDoc("app-1", "acme-svc-user", isoOffsetFromNow(app1Ago), "debug", "GET SystemConfigService/getBrokerConfig()", "cafecafe-babe-4bad-8bad-deadbeefcafe"),
    appLogDoc("app-2", "acme-svc-user", isoOffsetFromNow(app2Ago), "error", "connection refused talking to db", "66666666-6666-4666-8666-666666666666"),
  ];
}

const DATASET: readonly Doc[] = buildDataset();

function getField(source: Record<string, unknown>, field: string): unknown {
  return field in source ? source[field] : undefined;
}

function firstEntry(value: unknown): readonly [string, unknown] | undefined {
  return isRecord(value) ? Object.entries(value)[0] : undefined;
}

function matchesClause(source: Record<string, unknown>, clause: Record<string, unknown>): boolean {
  if (clause["match_all"] !== undefined) {
    return true;
  }
  const term = firstEntry(clause["term"]);
  if (term !== undefined) {
    const [rawField, value] = term;
    const field = rawField.replace(/\.keyword$/, "");
    return getField(source, field) === value;
  }
  const match = firstEntry(clause["match"]);
  if (match !== undefined) {
    const [field, value] = match;
    const rawFieldValue = getField(source, field);
    const haystack = (typeof rawFieldValue === "string" ? rawFieldValue : "").toLowerCase();
    return haystack.includes(String(value).toLowerCase());
  }
  const range = firstEntry(clause["range"]);
  if (range !== undefined) {
    const [field, spec] = range;
    const value = getField(source, field);
    if (isRecord(spec)) {
      const gte = spec["gte"];
      const lte = spec["lte"];
      if (typeof gte === "string" && typeof value === "string" && value < gte) {
        return false;
      }
      if (typeof lte === "string" && typeof value === "string" && value > lte) {
        return false;
      }
    }
    return true;
  }
  return true;
}

function matchesQuery(source: Record<string, unknown>, query: unknown): boolean {
  if (!isRecord(query) || query["match_all"] !== undefined) {
    return true;
  }
  if (isRecord(query["bool"])) {
    const must = Array.isArray(query["bool"]["must"]) ? (query["bool"]["must"] as Record<string, unknown>[]) : [];
    const filter = Array.isArray(query["bool"]["filter"]) ? (query["bool"]["filter"] as Record<string, unknown>[]) : [];
    return [...must, ...filter].every((clause) => matchesClause(source, clause));
  }
  return matchesClause(source, query);
}

function sortKey(doc: Doc): { readonly timestampMs: number } {
  return { timestampMs: Date.parse(String(doc._source["@timestamp"])) };
}

/** Newest first, matching `pit-pagination.ts`'s `[@timestamp desc, _doc asc]` — ties broken by array position, simulating `_doc` order. */
function sortedNewestFirst(docs: readonly Doc[]): readonly Doc[] {
  return [...docs].sort((a, b) => sortKey(b).timestampMs - sortKey(a).timestampMs);
}

interface PitState {
  readonly matches: readonly Doc[];
}

const openPits = new Map<string, PitState>();
let pitCounter = 0;

function handleOpenPit(_path: string): unknown {
  pitCounter += 1;
  const pitId = `fake-pit-${String(pitCounter)}`;
  openPits.set(pitId, { matches: sortedNewestFirst(DATASET) });
  return { pit_id: pitId };
}

function handleClosePit(body: Record<string, unknown>): unknown {
  const ids = Array.isArray(body["pit_id"]) ? body["pit_id"] : [];
  const results = ids.map((id) => {
    const existed = typeof id === "string" && openPits.delete(id);
    return { successful: existed };
  });
  return { pits: results };
}

function handlePitSearch(body: Record<string, unknown>): unknown {
  const pit = body["pit"];
  const pitId = isRecord(pit) ? pit["id"] : undefined;
  if (typeof pitId !== "string") {
    return { error: { type: "illegal_argument_exception", reason: "missing pit.id" }, status: 400 };
  }
  const state = openPits.get(pitId);
  if (state === undefined) {
    return { error: { type: "search_context_missing_exception", reason: `pit ${pitId} not found (or already closed)` }, status: 404 };
  }
  const matches = state.matches.filter((doc) => matchesQuery(doc._source, body["query"]));
  const size = typeof body["size"] === "number" ? body["size"] : 10;
  const searchAfter = body["search_after"];
  let startIndex = 0;
  if (Array.isArray(searchAfter) && searchAfter.length > 0) {
    const afterIndex = Number(searchAfter[searchAfter.length - 1]);
    startIndex = Number.isFinite(afterIndex) ? afterIndex + 1 : 0;
  }
  const page = matches.slice(startIndex, startIndex + size);
  return {
    pit_id: pitId,
    hits: {
      total: { value: matches.length },
      hits: page.map((doc, index) => ({ _id: doc._id, _source: doc._source, sort: [sortKey(doc).timestampMs, startIndex + index] })),
    },
  };
}

function handlePlainSearch(body: Record<string, unknown>): unknown {
  const matches = DATASET.filter((doc) => matchesQuery(doc._source, body["query"]));
  const aggs = body["aggs"];
  if (isRecord(aggs)) {
    const aggregations: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(aggs)) {
      if (!isRecord(spec) || !isRecord(spec["terms"]) || typeof spec["terms"]["field"] !== "string") {
        continue;
      }
      const field = spec["terms"]["field"].replace(/\.keyword$/, "");
      const groups = new Map<string, number>();
      for (const doc of matches) {
        const key = getField(doc._source, field);
        if (typeof key !== "string") {
          continue;
        }
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      aggregations[name] = { buckets: [...groups.entries()].map(([key, docCount]) => ({ key, doc_count: docCount })) };
    }
    return { hits: { total: { value: matches.length }, hits: [] }, aggregations };
  }
  return { hits: { total: { value: matches.length }, hits: [] } };
}

function handleMapping(): unknown {
  return {
    "logs-cfsyslog-000099": {
      mappings: {
        properties: {
          level: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
          response_status: { type: "integer" },
          "@timestamp": { type: "date" },
        },
      },
    },
  };
}

export interface FakeOpenSearch {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** Start the fake OpenSearch Dashboards console-proxy server, with Point-in-Time support cf-metrics's/cf-otel's fixtures do not need. */
export async function startFakeOpenSearch(): Promise<FakeOpenSearch> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/console/proxy") {
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
    const method = url.searchParams.get("method") ?? "GET";
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body: unknown = raw.length > 0 ? JSON.parse(raw) : {};
      const requestBody = isRecord(body) ? body : {};
      let result: unknown;
      if (path.includes("/_search/point_in_time") && method === "POST") {
        result = handleOpenPit(path);
      } else if (path === "_search/point_in_time" && method === "DELETE") {
        result = handleClosePit(requestBody);
      } else if (path === "_search" && isRecord(requestBody["pit"])) {
        result = handlePitSearch(requestBody);
      } else if (path.endsWith("/_mapping")) {
        result = handleMapping();
      } else if (path.endsWith("/_count")) {
        result = { count: DATASET.filter((doc) => matchesQuery(doc._source, requestBody["query"])).length };
      } else {
        result = handlePlainSearch(requestBody);
      }
      const status = isRecord(result) && typeof result["status"] === "number" ? result["status"] : 200;
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(result));
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
