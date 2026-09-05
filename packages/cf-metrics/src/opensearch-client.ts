import { DEFAULT_HTTP_TIMEOUT_MS, envName, readEnv } from "./config.js";
import { CfMetricsError, errorMessage } from "./errors.js";

/**
 * Encode a raw OpenSearch path for the Dashboards console-proxy `path` query
 * parameter: `/` -> `%2F` and, since `encodeURIComponent` leaves `*`
 * unescaped, `*` -> `%2A` as a second pass. Verified against a real Cloud
 * Logging instance: an index pattern like `otel-v1-apm-span-` + a wildcard,
 * joined with `_search`, encodes to `otel-v1-apm-span-%2A%2F_search` — the
 * same mechanism applies unchanged to this package's `metrics-*` pattern.
 */
export function encodeConsoleProxyPath(path: string): string {
  return encodeURIComponent(path).replace(/\*/g, "%2A");
}

export interface OpenSearchClientOptions {
  readonly dashboardsEndpoint: string;
  readonly username: string;
  readonly password: string;
  readonly fetchImpl?: typeof fetch;
  /** Per-request ceiling in milliseconds; defaults to {@link DEFAULT_HTTP_TIMEOUT_MS}, overridable via `CF_METRICS_HTTP_TIMEOUT_MS`. */
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
//
// `signal` is optional and additive: existing callers that never pass one
// see no change in behavior. `watch.ts` is the only caller that supplies it
// today, so an in-flight poll request can actually be cancelled on Ctrl-C
// instead of merely being ignored once it resolves.
export interface OpenSearchClient {
  readonly search: (index: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<SearchResponse>;
  readonly count: (index: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<number>;
  readonly getMapping: (index: string, signal?: AbortSignal) => Promise<unknown>;
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
 * the surviving shards found. Reading only `hits`/`count`/`aggregations`
 * therefore turns a partly-executed query into a short — or, for the
 * aggregation-only commands (`names`, `snapshot`, `top`, `history`), a
 * plausible-looking but wrong — result at exit 0.
 *
 * The window is real here: `metrics-*` spans 40 backing indices over 80
 * shards (measured live), nearly 3x `@saptools/cf-otel`'s own 14/28, and a
 * field can be dynamically mapped one way in an older index and another way
 * in a newer one after an ingest change. Every caller is better off being
 * told the number is incomplete than believing it — this mirrors cf-otel's
 * `assertNoShardFailures` exactly, ported after the same gap was found here.
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
    throw new CfMetricsError(
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
  throw new CfMetricsError(
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
 * outcomes hand a caller who asked for a long ceiling the exact opposite —
 * confirmed live: an over-large `CF_METRICS_HTTP_TIMEOUT_MS` aborted in under
 * 1ms while the resulting error still claimed to have waited that many ms.
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

/** Create a client for OpenSearch's `_search`/`_count`/`_mapping` via the Dashboards console-proxy. */

/**
 * The caller's cancellation signal (`watch`'s Ctrl-C) combined with a deadline,
 * so a request is bounded whether or not the caller supplied one. Without the
 * combination, passing a caller signal would silently opt that request out of
 * the timeout.
 */
function requestSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return caller === undefined ? deadline : AbortSignal.any([caller, deadline]);
}

/** `AbortSignal.timeout` rejects with a `TimeoutError`; a caller's abort rejects with `AbortError`. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Shared by the request and the body read, because the deadline can fire at
 * either point (see the body-read comment in `proxyRequest`). A timeout is
 * worth naming: "failed" alone sends the reader looking for a query or
 * credential problem when the endpoint simply never answered.
 */
function requestFailure(path: string, timeoutMs: number, error: unknown): CfMetricsError {
  if (isTimeout(error)) {
    return new CfMetricsError(
      "OPENSEARCH_REQUEST_FAILED",
      `OpenSearch request to ${path} timed out after ${String(timeoutMs)}ms. ` +
        "Raise CF_METRICS_HTTP_TIMEOUT_MS if the query is genuinely slow, or narrow the time range.",
      { cause: error },
    );
  }
  return new CfMetricsError(
    "OPENSEARCH_REQUEST_FAILED",
    `OpenSearch request to ${path} failed: ${errorMessage(error)}`,
    { cause: error },
  );
}

export function createOpenSearchClient(opts: OpenSearchClientOptions): OpenSearchClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const auth = Buffer.from(`${opts.username}:${opts.password}`).toString("base64");
  const baseUrl = normalizeDashboardsEndpoint(opts.dashboardsEndpoint);
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);

  async function proxyRequest(path: string, method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
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
        signal: requestSignal(signal, timeoutMs),
      });
    } catch (error) {
      throw requestFailure(path, timeoutMs, error);
    }
    // The body read needs the same handling as the request: headers can
    // arrive well before the payload finishes streaming — the normal shape
    // for a wide aggregation, and this package's indices run wider than
    // cf-otel's — so the deadline/an abort often fires here rather than
    // above. Left outside a try, that escaped as a bare "The operation was
    // aborted due to timeout" with no path, no ceiling, no hint.
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw requestFailure(path, timeoutMs, error);
    }
    if (!response.ok) {
      // The status rides along so the credential layer can tell "this
      // credential is dead" (401/403) from every other kind of failure.
      throw new CfMetricsError(
        "OPENSEARCH_REQUEST_FAILED",
        `OpenSearch request to ${path} failed: HTTP ${String(response.status)} ${text.slice(0, 500)}`,
        { status: response.status },
      );
    }
    if (text.length === 0) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new CfMetricsError(
        "OPENSEARCH_REQUEST_FAILED",
        `OpenSearch response for ${path} was not valid JSON`,
        { cause: error },
      );
    }
    assertNoShardFailures(path, parsed);
    return parsed;
  }

  return {
    async search(index, body, signal) {
      return parseSearchResponse(await proxyRequest(`${index}/_search`, "GET", body, signal));
    },
    async count(index, body, signal) {
      return parseCountResponse(await proxyRequest(`${index}/_count`, "GET", body, signal));
    },
    async getMapping(index, signal) {
      return await proxyRequest(`${index}/_mapping`, "GET", undefined, signal);
    },
  };
}

export interface PagedSearchResult {
  readonly hits: readonly SearchHit[];
  readonly totalHits: number;
  readonly truncated: boolean;
}

/**
 * Fetch every hit for a query using `search_after` pagination, which is not
 * bound by `index.max_result_window` the way `from`+`size` deep pagination
 * is — required whenever a query can match more documents than a single
 * `_search` page can return (OpenSearch's default window is 10000).
 *
 * `sortTiebreaker` must be a real, mapped, sortable field combination unique
 * enough to make `search_after` progress deterministically — unlike
 * `cf-otel`'s span domain (which always sorts on its own `startTime`+
 * `spanId`), this package's callers query heterogeneous metric documents
 * (container/queue/db-pool/custom), so no single tiebreaker is universally
 * correct here; the caller supplies one appropriate to its own query. Never
 * use `_id`: OpenSearch documents it as restricted from sorting (falls back
 * to fielddata, off by default on modern OpenSearch/Elasticsearch).
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
  sortTiebreaker: readonly Record<string, unknown>[],
): Promise<PagedSearchResult> {
  const allHits: SearchHit[] = [];
  let searchAfter: readonly unknown[] | undefined;

  for (;;) {
    const body: Record<string, unknown> = {
      ...baseBody,
      size: pageSize,
      sort: sortTiebreaker,
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
