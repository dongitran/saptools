export interface CuratedField {
  readonly field: string;
  readonly type: string;
  readonly appliesTo: "all" | "RTR only" | "APP-log only";
  readonly notes: string;
}

export const CURATED_FIELDS: readonly CuratedField[] = [
  { field: "@timestamp", type: "date", appliesTo: "all", notes: "the only safe time field — raw timestamp (no @) is mapped long but arrives as an ISO string, so it is silently _ignored on every document" },
  { field: "source_type", type: "keyword (.keyword)", appliesTo: "all", notes: "RTR, APP/PROC/WEB, CELL, STG, API, or an APP/TASK/<8-hex> one-off task" },
  { field: "app_name", type: "text (+.keyword)", appliesTo: "all", notes: "" },
  { field: "app_id", type: "text (+.keyword)", appliesTo: "all", notes: "a normal hyphenated CF GUID — unlike metrics-*'s aliased fields, no remove_hyphens normalizer here" },
  { field: "space_name", type: "text (+.keyword)", appliesTo: "all", notes: "" },
  { field: "organization_name", type: "text (+.keyword)", appliesTo: "all", notes: "" },
  { field: "level", type: "text (+.keyword)", appliesTo: "APP-log only", notes: "RTR rows carry no level field at all" },
  { field: "logger", type: "text (+.keyword)", appliesTo: "APP-log only", notes: "" },
  { field: "msg", type: "text (+.keyword)", appliesTo: "APP-log only", notes: "the only full-text-searchable field — RTR rows have no msg field at all, already fully decomposed into method/request/response_status/etc." },
  { field: "correlation_id", type: "text (+.keyword)", appliesTo: "all", notes: "coarse: one value spans many requests and many OTel traces, not a per-hop id" },
  { field: "vcap_request_id", type: "text (+.keyword)", appliesTo: "all", notes: "the per-hop join key — use as the input to the trace command; --with-span joins to spans via the matched RTR row's own traceId, not this field as a span attribute (tried and abandoned, see the design doc)" },
  { field: "trace_id", type: "text (+.keyword)", appliesTo: "all", notes: "the REAL OTel trace id only when source_type=RTR (mirrors w3c_trace-id); on every other row it is unreliable — a live sample found ~58% were a de-hyphenated correlation_id and ~42% were a real trace id anyway, with no way to tell which from the document alone — never read this field directly, always call resolveTraceId()" },
  { field: "span_id", type: "keyword", appliesTo: "RTR only", notes: "paired with trace_id's RTR-only guarantee — see resolveSpanId()" },
  { field: "method", type: "keyword", appliesTo: "RTR only", notes: "" },
  { field: "request", type: "text (+.keyword)", appliesTo: "RTR only", notes: "the request path — aggregate on request.keyword, not the bare field (verified live: OpenSearch rejects fielddata on the bare text field)" },
  { field: "response_status", type: "integer", appliesTo: "RTR only", notes: "a real mapped number — filter with --status, not a text match" },
  { field: "response_time_ms", type: "float", appliesTo: "RTR only", notes: "" },
  { field: "backend_time_ms", type: "float", appliesTo: "RTR only", notes: "" },
  { field: "user_agent", type: "text (+.keyword)", appliesTo: "RTR only", notes: "" },
  { field: "x_forwarded_for", type: "text (+.keyword)", appliesTo: "RTR only", notes: "" },
];
