# Changelog

All notable changes to `@saptools/cf-log-search` are documented in this file.

## 0.3.0

### Added

- `trace <vcap-request-id>` — every `logs-cfsyslog-*` document sharing one exact per-hop request id, with `--with-span` to also pull the correlated `otel-v1-apm-span-*` spans (joined on the matched RTR row's own trace id — verified live to be more reliable than the originally-planned `vcap_request_id`-to-span-attribute join, which depends on an array-encoding workaround and only works on `SPAN_KIND_SERVER` spans).

### Notes

- Span availability lags log-document availability by a real, measured few minutes on this backend; `trace --with-span` reports this explicitly rather than treating a temporarily-empty result as a failure.

## 0.2.0

### Added

- `errors`, `latency`, and `top-routes` — RTR-only analytics over `logs-cfsyslog-*`'s already-structured router-access-log fields (status codes, response times, request paths).

## 0.1.1

### Changed

- No functional changes. Version bump to verify the package's npm publish pipeline (`.github/workflows/cf-log-search.yml`) end-to-end.

## 0.1.0

### Added

- Initial release: `search`, `count`, `fields`, `apps`, `sources`, `result`, and `credential` commands querying `logs-cfsyslog-*`, the historical application-log index SAP Cloud Logging's OpenSearch backend already ingests — full-text and structured search far beyond `cf logs`'s short recent-only buffer.
- Built on `@saptools/core`'s shared Cloud-Logging target resolution, dashboards-credential discovery/cache, and OpenSearch client — the same mechanism `@saptools/cf-otel`/`@saptools/cf-metrics` use.
- A dedicated Point-in-Time-based pagination helper for reliable `search_after` paging over an index with no natural unique sort key (verified live: this index has none, unlike `cf-otel`'s spans).
- Safe handling of the verified `trace_id` field ambiguity: the real OTel trace id only on `RTR` rows, never misread as one on any other `source_type`.
