# Changelog

All notable changes to `@saptools/cf-log-search` are documented in this file.

## 0.1.0

### Added

- Initial release: `search`, `count`, `fields`, `apps`, `sources`, `result`, and `credential` commands querying `logs-cfsyslog-*`, the historical application-log index SAP Cloud Logging's OpenSearch backend already ingests — full-text and structured search far beyond `cf logs`'s short recent-only buffer.
- Built on `@saptools/core`'s shared Cloud-Logging target resolution, dashboards-credential discovery/cache, and OpenSearch client — the same mechanism `@saptools/cf-otel`/`@saptools/cf-metrics` use.
- A dedicated Point-in-Time-based pagination helper for reliable `search_after` paging over an index with no natural unique sort key (verified live: this index has none, unlike `cf-otel`'s spans).
- Safe handling of the verified `trace_id` field ambiguity: the real OTel trace id only on `RTR` rows, never misread as one on any other `source_type`.
