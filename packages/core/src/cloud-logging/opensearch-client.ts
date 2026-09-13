/**
 * Encode a raw OpenSearch path for the Dashboards console-proxy `path` query
 * parameter: `/` -> `%2F` and, since `encodeURIComponent` leaves `*`
 * unescaped, `*` -> `%2A` as a second pass. Verified against a real Cloud
 * Logging instance for both `metrics-*` and `otel-v1-apm-span-*`.
 */
export function encodeConsoleProxyPath(path: string): string {
  return encodeURIComponent(path).replace(/\*/g, "%2A");
}

export interface OpenSearchClientOptions {
  readonly dashboardsEndpoint: string;
  readonly username: string;
  readonly password: string;
  readonly fetchImpl?: typeof fetch;
  /** Per-request ceiling in milliseconds; defaults to 60000. */
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

export class OpenSearchRequestError extends Error {
  readonly status?: number | undefined;
  constructor(message: string, options?: { readonly status?: number; readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpenSearchRequestError";
    this.status = options?.status;
  }
}

export function isAuthRejection(error: unknown): boolean {
  return error instanceof OpenSearchRequestError && (error.status === 401 || error.status === 403);
}

export interface OpenSearchClient {
  readonly search: (index: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<SearchResponse>;
  readonly count: (index: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<number>;
  readonly getMapping: (index: string, signal?: AbortSignal) => Promise<unknown>;
  /**
   * Escape hatch for a console-proxy request that doesn't fit the
   * `<index>/_search`-shaped methods above — currently only needed for
   * Point-in-Time open (`POST <index>/_search/point_in_time?keep_alive=1m`)
   * and close (`DELETE _search/point_in_time`). `path` is the raw OpenSearch
   * REST path exactly as the other methods build it internally (this method
   * applies the same `encodeConsoleProxyPath` encoding and auth).
   */
  readonly raw: (path: string, method: string, body?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTotal(value: unknown): number {
  if (typeof value === "number") {return value;}
  if (isRecord(value) && typeof value["value"] === "number") {return value["value"];}
  return 0;
}

function parseHits(hitsBlock: unknown): SearchHit[] {
  if (!isRecord(hitsBlock) || !Array.isArray(hitsBlock["hits"])) {return [];}
  const result: SearchHit[] = [];
  for (const raw of hitsBlock["hits"]) {
    if (!isRecord(raw)) {continue;}
    const id = raw["_id"];
    const source = raw["_source"];
    if (typeof id !== "string" || !isRecord(source)) {continue;}
    const sort = raw["sort"];
    result.push({ _id: id, _source: source, ...(Array.isArray(sort) ? { sort } : {}) });
  }
  return result;
}

function parseSearchResponse(value: unknown): SearchResponse {
  if (!isRecord(value)) {return { totalHits: 0, hits: [] };}
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

function firstShardFailureReason(shards: Record<string, unknown>): string {
  const failures: unknown = shards["failures"];
  const first: unknown = Array.isArray(failures) ? (failures as readonly unknown[])[0] : undefined;
  if (!isRecord(first)) {return "";}
  const reason = first["reason"];
  if (typeof reason === "string") {return reason;}
  if (isRecord(reason) && typeof reason["reason"] === "string") {return reason["reason"];}
  return "";
}

const ALLOW_PARTIAL_SHARDS_ENV = "CLOUD_LOGGING_ALLOW_PARTIAL_SHARDS";

/**
 * A query answered by only *some* shards is HTTP 200 with the count in
 * `_shards.failed` and whatever the surviving shards found — reading only
 * `hits`/`count`/`aggregations` turns a partly-executed query into a
 * plausible-looking but wrong result at exit 0.
 */
function assertNoShardFailures(path: string, value: unknown): void {
  if (!isRecord(value)) {return;}
  if (process.env[ALLOW_PARTIAL_SHARDS_ENV] !== undefined) {return;}
  if (value["timed_out"] === true) {
    throw new OpenSearchRequestError(
      `OpenSearch timed out serving ${path} and returned a partial result. Narrow the query, or raise the cluster-side search timeout.`,
    );
  }
  const shards = value["_shards"];
  if (!isRecord(shards) || typeof shards["failed"] !== "number" || shards["failed"] === 0) {return;}
  const total = typeof shards["total"] === "number" ? shards["total"] : undefined;
  const failed = String(shards["failed"]);
  const scope = total === undefined ? failed : `${failed} of ${String(total)}`;
  const reason = firstShardFailureReason(shards);
  throw new OpenSearchRequestError(
    `OpenSearch answered ${path} from only some shards: ${scope} failed, so the result is incomplete${reason.length === 0 ? "" : ` (${reason})`}. Retry: a shard may be recovering. If it persists, narrow the query so it touches fewer indices.`,
  );
}

function normalizeDashboardsEndpoint(rawEndpoint: string): string {
  let end = rawEndpoint.length;
  while (end > 0 && rawEndpoint.charAt(end - 1) === "/") {
    end -= 1;
  }
  const trimmed = rawEndpoint.slice(0, end);
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const MAX_HTTP_TIMEOUT_MS = 2_147_483_647;

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {return DEFAULT_HTTP_TIMEOUT_MS;}
  return Math.min(value, MAX_HTTP_TIMEOUT_MS);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function requestFailure(path: string, timeoutMs: number, error: unknown): OpenSearchRequestError {
  if (isTimeout(error)) {
    return new OpenSearchRequestError(`OpenSearch request to ${path} timed out after ${String(timeoutMs)}ms.`, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new OpenSearchRequestError(`OpenSearch request to ${path} failed: ${message}`, { cause: error });
}

function requestSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return caller === undefined ? deadline : AbortSignal.any([caller, deadline]);
}

/** Create a client for OpenSearch's `_search`/`_count`/`_mapping` via the Dashboards console-proxy. */
export function createOpenSearchClient(opts: OpenSearchClientOptions): OpenSearchClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const auth = Buffer.from(`${opts.username}:${opts.password}`).toString("base64");
  const baseUrl = normalizeDashboardsEndpoint(opts.dashboardsEndpoint);
  const timeoutMs = normalizeTimeoutMs(opts.timeoutMs);

  async function proxyRequest(path: string, method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const url = `${baseUrl}/api/console/proxy?path=${encodeConsoleProxyPath(path)}&method=${method}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "osd-xsrf": "true", "Content-Type": "application/json", Authorization: `Basic ${auth}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal(signal, timeoutMs),
      });
    } catch (error) {
      throw requestFailure(path, timeoutMs, error);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw requestFailure(path, timeoutMs, error);
    }
    if (!response.ok) {
      throw new OpenSearchRequestError(`OpenSearch request to ${path} failed: HTTP ${String(response.status)} ${text.slice(0, 500)}`, {
        status: response.status,
      });
    }
    if (text.length === 0) {return undefined;}
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new OpenSearchRequestError(`OpenSearch response for ${path} was not valid JSON`, { cause: error });
    }
    assertNoShardFailures(path, parsed);
    return parsed;
  }

  /**
   * A `_mapping` fetch on a wide wildcard pattern (measured: 92,000 lines for
   * `logs-cfsyslog-*` across 52 backing indices) is expensive enough that
   * repeat callers within one client's lifetime should share it — ported
   * from `@saptools/cf-otel`, which had this and `@saptools/cf-metrics` did
   * not. Caches the in-flight promise, not the result, so concurrent callers
   * share one request; a failed fetch is never remembered as the answer.
   */
  const mappingCache = new Map<string, Promise<unknown>>();

  return {
    async search(index, body, signal) {
      return parseSearchResponse(await proxyRequest(`${index}/_search`, "GET", body, signal));
    },
    async count(index, body, signal) {
      return parseCountResponse(await proxyRequest(`${index}/_count`, "GET", body, signal));
    },
    async getMapping(index, signal) {
      const cached = mappingCache.get(index);
      if (cached !== undefined) {return await cached;}
      const pending = proxyRequest(`${index}/_mapping`, "GET", undefined, signal);
      mappingCache.set(index, pending);
      try {
        return await pending;
      } catch (error) {
        mappingCache.delete(index);
        throw error;
      }
    },
    async raw(path, method, body, signal) {
      return await proxyRequest(path, method, body, signal);
    },
  };
}

export interface PagedSearchResult {
  readonly hits: readonly SearchHit[];
  readonly totalHits: number;
  readonly truncated: boolean;
}

/**
 * Fetch every hit for a query using `search_after` pagination (not bound by
 * `index.max_result_window`). `sortTiebreaker` must be a real, mapped,
 * sortable field combination unique enough to make `search_after` progress
 * deterministically for the caller's own domain — there is no single
 * universally-correct tiebreaker across every @saptools Cloud Logging
 * consumer (cf-otel's spans use `startTime`+`spanId`; cf-metrics's
 * heterogeneous metric docs have no natural unique field at all;
 * cf-log-search's `logs-cfsyslog-*` domain has no natural unique field
 * either and uses Point-in-Time + `[@timestamp desc, _doc asc]` instead of
 * this helper entirely — see the Phase 1 plan). Never use `_id` as a
 * tiebreaker: OpenSearch documents it as restricted from sorting without
 * fielddata, off by default.
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
