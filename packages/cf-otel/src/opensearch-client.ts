import { DEFAULT_HTTP_TIMEOUT_MS, envName, readEnv } from "./config.js";
import { CfOtelError, errorMessage } from "./errors.js";

/**
 * Encode a raw OpenSearch path for the Dashboards console-proxy `path` query
 * parameter: `/` -> `%2F` and, since `encodeURIComponent` leaves `*`
 * unescaped, `*` -> `%2A` as a second pass. Verified against a real Cloud
 * Logging instance: the index pattern `otel-v1-apm-span-` + a wildcard,
 * joined with `_search`, encodes to `otel-v1-apm-span-%2A%2F_search`.
 */
export function encodeConsoleProxyPath(path: string): string {
  return encodeURIComponent(path).replace(/\*/g, "%2A");
}

export interface OpenSearchClientOptions {
  readonly dashboardsEndpoint: string;
  readonly username: string;
  readonly password: string;
  readonly fetchImpl?: typeof fetch;
  /** Per-request ceiling in milliseconds; defaults to {@link DEFAULT_HTTP_TIMEOUT_MS}, overridable via `CF_OTEL_HTTP_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

export interface SearchHit {
  readonly _id: string;
  readonly _source: Readonly<Record<string, unknown>>;
  readonly sort?: readonly unknown[];
}

export interface SearchResponse {
  readonly totalHits: number;
  readonly hits: readonly SearchHit[];
  readonly aggregations?: Readonly<Record<string, unknown>>;
}

// Arrow-typed properties (not method shorthand) so consumers — including test
// fakes — can reference e.g. `client.search` on its own without tripping
// @typescript-eslint/no-unbound-method, which only worries about `this` on
// genuine method signatures.
export interface OpenSearchClient {
  readonly search: (index: string, body: Record<string, unknown>) => Promise<SearchResponse>;
  readonly count: (index: string, body: Record<string, unknown>) => Promise<number>;
  readonly getMapping: (index: string) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTotal(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (isRecord(value) && typeof value["value"] === "number") {
    return value["value"];
  }
  return 0;
}

function parseHits(hitsBlock: unknown): SearchHit[] {
  if (!isRecord(hitsBlock) || !Array.isArray(hitsBlock["hits"])) {
    return [];
  }
  const result: SearchHit[] = [];
  for (const raw of hitsBlock["hits"]) {
    if (!isRecord(raw)) {
      continue;
    }
    const id = raw["_id"];
    const source = raw["_source"];
    if (typeof id !== "string" || !isRecord(source)) {
      continue;
    }
    const sort = raw["sort"];
    result.push({ _id: id, _source: source, ...(Array.isArray(sort) ? { sort } : {}) });
  }
  return result;
}

function parseSearchResponse(value: unknown): SearchResponse {
  if (!isRecord(value)) {
    return { totalHits: 0, hits: [] };
  }
  const hitsBlock = value["hits"];
  const aggregations = value["aggregations"];
  return {
    totalHits: isRecord(hitsBlock) ? parseTotal(hitsBlock["total"]) : 0,
    hits: parseHits(hitsBlock),
    ...(isRecord(aggregations) ? { aggregations } : {}),
  };
}

function parseCountResponse(value: unknown): number {
  return isRecord(value) && typeof value["count"] === "number" ? value["count"] : 0;
}

/** First failure reason OpenSearch reported, for a message that names the cause rather than only the count. */
function firstShardFailureReason(shards: Record<string, unknown>): string {
  const failures: unknown = shards["failures"];
  const first: unknown = Array.isArray(failures) ? (failures as readonly unknown[])[0] : undefined;
  if (!isRecord(first)) {
    return "";
  }
  const reason = first["reason"];
  if (typeof reason === "string") {
    return reason;
  }
  if (isRecord(reason) && typeof reason["reason"] === "string") {
    return reason["reason"];
  }
  return "";
}

/**
 * A query that fails on *every* shard comes back as an HTTP error and is
 * already reported. One that fails on *some* of them does not: OpenSearch
 * answers HTTP 200, puts the count in `_shards.failed`, and returns whatever
 * the surviving shards found. Reading only `hits`/`count` therefore turns a
 * partly-executed query into a short result at exit 0 — the same silent
 * wrong-answer this tool keeps having to design against.
 *
 * The window is real here: `otel-v1-apm-span-*` spans 14 backing indices over
 * 28 shards (measured), and a field can be dynamically mapped one way in an
 * older index and another way in a newer one after an ingest change. Every
 * caller is better off being told the number is incomplete than believing it.
 */
function assertNoShardFailures(path: string, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  // A persistently red shard would otherwise make every command unusable on a
  // tenant whose data the caller can still mostly read. The override is loud by
  // construction: it only exists as an env var, and the caller has to have seen
  // the error first to know it is there.
  if (readEnv(envName("ALLOW_PARTIAL_SHARDS")) !== undefined) {
    return;
  }
  if (value["timed_out"] === true) {
    // Same class as a shard failure: OpenSearch answers 200 with whatever it
    // collected before the deadline, and reading only `hits` calls that partial
    // set the answer.
    throw new CfOtelError(
      "OPENSEARCH_REQUEST_FAILED",
      `OpenSearch timed out serving ${path} and returned a partial result. ` +
        "Narrow the query, or raise the cluster-side search timeout.",
    );
  }
  const shards = value["_shards"];
  if (!isRecord(shards) || typeof shards["failed"] !== "number" || shards["failed"] === 0) {
    return;
  }
  const total = typeof shards["total"] === "number" ? shards["total"] : undefined;
  const failed = String(shards["failed"]);
  const scope = total === undefined ? failed : `${failed} of ${String(total)}`;
  const reason = firstShardFailureReason(shards);
  throw new CfOtelError(
    "OPENSEARCH_REQUEST_FAILED",
    `OpenSearch answered ${path} from only some shards: ${scope} failed, so the result is incomplete` +
      `${reason.length === 0 ? "" : ` (${reason})`}. Retry: a shard may be recovering. If it persists, narrow the query so it touches fewer indices.`,
  );
}

/**
 * Real Cloud Logging service-key/binding payloads have been observed to
 * return `dashboards-endpoint` as a bare hostname with no scheme (e.g.
 * `dashboards-sf-<guid>.<n>.<region>.cls.services.cloud.sap`) — `fetch()`
 * rejects that outright as an invalid URL. Default to `https://` when no
 * scheme is present; pass an explicit endpoint through unchanged.
 */
function normalizeDashboardsEndpoint(rawEndpoint: string): string {
  // Trim trailing slashes with a manual scan rather than a `/+$/` regex: a
  // regex anchored at the end backtracks quadratically over a long run of
  // slashes that isn't actually followed by the end of input, and this
  // endpoint comes straight from a service-key/binding payload we don't
  // control the shape of.
  let end = rawEndpoint.length;
  while (end > 0 && rawEndpoint.charAt(end - 1) === "/") {
    end -= 1;
  }
  const trimmed = rawEndpoint.slice(0, end);
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Node's timers overflow past 2^31-1: `AbortSignal.timeout` accepts up to
 * 2^32-1 but silently reduces anything above this to **1ms**, emitting only a
 * `TimeoutOverflowWarning`, and throws a `RangeError` beyond 2^32-1. Both
 * outcomes hand a caller who asked for a long ceiling the exact opposite.
 */
const MAX_HTTP_TIMEOUT_MS = 2_147_483_647;

/**
 * Bring any configured ceiling into the range `AbortSignal.timeout` actually
 * honors. It throws a `RangeError` for a negative or fractional delay, and
 * that RangeError would be reported as "OpenSearch request failed" — blaming
 * the endpoint for a bad local setting. Normalizing in one place means neither
 * a malformed env var nor an odd explicit option can reach it, so an unusable
 * value never becomes the reason a read-only query refuses to run.
 */
function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_HTTP_TIMEOUT_MS;
  }
  // Clamped rather than defaulted, unlike the guard above: an over-large
  // ceiling still expresses "wait a long time", and falling back to 60s would
  // invert that intent instead of merely ignoring an unusable value.
  return Math.min(value, MAX_HTTP_TIMEOUT_MS);
}

function resolveTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) {
    return normalizeTimeoutMs(explicit);
  }
  const raw = readEnv(envName("HTTP_TIMEOUT_MS"));
  return normalizeTimeoutMs(raw === undefined ? undefined : Number(raw));
}

/** `AbortSignal.timeout` rejects with a `TimeoutError`, which is what separates a deadline from a transport failure. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Shared by the request and the body read, because the deadline can fire at
 * either point. A timeout is worth naming: "failed" alone sends the reader
 * looking for a query or credential problem when the endpoint simply never
 * answered.
 */
function requestFailure(path: string, timeoutMs: number, error: unknown): CfOtelError {
  if (isTimeout(error)) {
    return new CfOtelError(
      "OPENSEARCH_REQUEST_FAILED",
      `OpenSearch request to ${path} timed out after ${String(timeoutMs)}ms. ` +
        `Raise ${envName("HTTP_TIMEOUT_MS")} if the query is genuinely slow, or narrow the time range.`,
      { cause: error },
    );
  }
  return new CfOtelError(
    "OPENSEARCH_REQUEST_FAILED",
    `OpenSearch request to ${path} failed: ${errorMessage(error)}`,
    { cause: error },
  );
}

/**
 * Node's `fetch` applies no deadline of its own, so without this a Dashboards
 * endpoint that accepts the connection and then never answers hangs the CLI
 * indefinitely with no output at all.
 *
 * The deadline is per *request*, not per operation: `searchAfterAll` can issue
 * up to 50 pages, so its worst case is 50 times this ceiling. That is the
 * right semantic for a page-at-a-time fetch, where each page is an independent
 * round trip that either answers or does not.
 *
 * Unlike cf-metrics, no caller-supplied `AbortSignal` is threaded through the
 * client interface. cf-metrics needs one because its `watch` command runs until
 * Ctrl-C; every cf-otel command is a single bounded query, so a plain deadline
 * is enough and the extra parameter would be unused surface.
 */
export function createOpenSearchClient(opts: OpenSearchClientOptions): OpenSearchClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const auth = Buffer.from(`${opts.username}:${opts.password}`).toString("base64");
  const baseUrl = normalizeDashboardsEndpoint(opts.dashboardsEndpoint);
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);

  async function proxyRequest(path: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
    const url = `${baseUrl}/api/console/proxy?path=${encodeConsoleProxyPath(path)}&method=${method}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "osd-xsrf": "true",
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw requestFailure(path, timeoutMs, error);
    }
    // The body read needs the same handling as the request: headers can arrive
    // well before the payload finishes streaming — the normal shape for a wide
    // aggregation — so the deadline often fires here rather than above. Left
    // outside a try, that abort escaped as a bare "The operation was aborted
    // due to timeout" with no path, no ceiling and no hint.
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw requestFailure(path, timeoutMs, error);
    }
    if (!response.ok) {
      throw new CfOtelError(
        "OPENSEARCH_REQUEST_FAILED",
        `OpenSearch request to ${path} failed: HTTP ${String(response.status)} ${text.slice(0, 500)}`,
      );
    }
    if (text.length === 0) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new CfOtelError(
        "OPENSEARCH_REQUEST_FAILED",
        `OpenSearch response for ${path} was not valid JSON`,
        { cause: error },
      );
    }
    assertNoShardFailures(path, parsed);
    return parsed;
  }

  /**
   * One `_mapping` fetch of `otel-v1-apm-span-*` returns every field of all 14
   * backing indices and costs over a second, yet `resolveAttrKey` asks for it
   * once per prefix candidate per `--attr`, and the request-id guard asks again.
   * Memoizing per client instance collapses that to one call.
   *
   * Safe precisely because the lifetime is one client: every command builds its
   * own inside `withOpenSearchClient` for a single bounded operation, so there
   * is no long-running process that could hold a mapping past a rollover.
   */
  const mappingCache = new Map<string, Promise<unknown>>();

  return {
    async search(index, body) {
      return parseSearchResponse(await proxyRequest(`${index}/_search`, "GET", body));
    },
    async count(index, body) {
      return parseCountResponse(await proxyRequest(`${index}/_count`, "GET", body));
    },
    async getMapping(index) {
      const cached = mappingCache.get(index);
      if (cached !== undefined) {
        return await cached;
      }
      // Cache the promise, not the result, so concurrent callers share one request.
      const pending = proxyRequest(`${index}/_mapping`, "GET");
      mappingCache.set(index, pending);
      try {
        return await pending;
      } catch (error) {
        // A failed fetch must not be remembered as the answer.
        mappingCache.delete(index);
        throw error;
      }
    },
  };
}

/**
 * `spanId`, not `_id`: OpenSearch documents `_id` as restricted from sorting
 * (falls back to fielddata, which is off by default on Elasticsearch 8+ and
 * only on by default on OpenSearch today because of a dynamic cluster
 * setting an operator can flip). `spanId` is a mandatory OpenTelemetry field
 * — every span has one — mapped as a plain `keyword` with doc_values on by
 * default in Data Prepper's own `otel-v1-apm-span-*` index template, so it
 * sorts natively with no fielddata fallback and no dependence on a setting
 * outside this tool's control.
 */
export const SPANS_SORT_TIEBREAKER = [{ startTime: "asc" }, { spanId: "asc" }] as const;

export interface PagedSearchResult {
  readonly hits: readonly SearchHit[];
  readonly totalHits: number;
  readonly truncated: boolean;
}

/**
 * Fetch every hit for a query using `search_after` pagination, which is not
 * bound by `index.max_result_window` the way `from`+`size` deep pagination
 * is — required for traces with more spans than a single `_search` page can
 * return (OpenSearch's default window is 10000; real traces have exceeded it).
 *
 * `track_total_hits: true` is mandatory here: OpenSearch's default caps
 * `hits.total.value` at 10000 (reported as an approximate lower bound) once
 * real matches exceed that, independent of `search_after` paging — without
 * it, a query genuinely matching e.g. 15000 documents would still correctly
 * collect all 15000 via `search_after`, but `page.totalHits` would report a
 * stuck-at-10000 approximation, making the "total"/"truncated" diagnostic
 * self-contradictory (`truncated: false` next to a total that doesn't match
 * how many hits were actually returned).
 */
export async function searchAfterAll(
  client: OpenSearchClient,
  index: string,
  baseBody: Record<string, unknown>,
  pageSize: number,
  maxTotal: number,
): Promise<PagedSearchResult> {
  const allHits: SearchHit[] = [];
  let searchAfter: readonly unknown[] | undefined;

  for (;;) {
    const body: Record<string, unknown> = {
      ...baseBody,
      size: pageSize,
      sort: SPANS_SORT_TIEBREAKER,
      track_total_hits: true,
      ...(searchAfter === undefined ? {} : { search_after: searchAfter }),
    };
    const page = await client.search(index, body);
    allHits.push(...page.hits);
    const last = page.hits[page.hits.length - 1];

    if (page.hits.length < pageSize || last === undefined) {
      return { hits: allHits, totalHits: page.totalHits, truncated: allHits.length < page.totalHits };
    }
    if (allHits.length >= maxTotal) {
      return { hits: allHits, totalHits: page.totalHits, truncated: true };
    }
    if (last.sort === undefined) {
      return { hits: allHits, totalHits: page.totalHits, truncated: allHits.length < page.totalHits };
    }
    searchAfter = last.sort;
  }
}
