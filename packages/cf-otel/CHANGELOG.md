# Changelog

All notable changes to `@saptools/cf-otel` are documented in this file.

## 0.1.2 - 2026-08-29

- Fixed `searchAfterAll`'s pagination tiebreaker: it sorted by OpenSearch's
  `_id` meta-field, which is documented as restricted from sorting (falls
  back to fielddata, a deprecated path outside this tool's control). Now
  sorts by `spanId`, a mandatory OpenTelemetry field mapped as a plain
  `keyword` with doc_values on. `span` and `fields` now share the same
  tiebreaker constant instead of duplicating the sort array.
- Fixed `mintDashboardsCredential`'s last-resort SAML restore
  (`--allow-mint-credential`): it used to hard-code `saml.enabled=true` on
  restore regardless of the instance's actual original value, permanently
  turning SSO on for an instance that never had it. Now writes the original
  params blob back verbatim, and the critical-failure error message's
  "broken for ALL users" framing only appears when SAML was genuinely on
  beforehand.
- Fixed `top`/`detached`'s `by_trace` terms aggregation: it had no explicit
  `order`, defaulting to OpenSearch's `_count`-desc bucket selection even
  when sorting by duration — on a window with more than 10,000 distinct
  traces, a long-but-low-span-count trace could be silently dropped before
  the client-side sort ever saw it. Both commands now order by the same
  metric they sort by, and warn when that 10,000-bucket cap is actually hit.
- Added regression tests covering every fix above.

## 0.1.1 - 2026-08-29

- Fixed `--attr` filters (e.g. `--attr 'http@status_code>=400'`): bare attribute keys were never
  resolved against their real `span.attributes.*`/`resource.attributes.*` mapping paths, so every
  `--attr` filter silently matched nothing. Added `resolveAndValidateAttrFilters` to resolve keys
  against the live index mapping before querying.
- Fixed `mapping --field` for nested attribute paths: lookups only checked one level of
  `properties`, so dotted paths like `url@path` never resolved against the real nested mapping
  tree (`properties.span.properties.attributes.properties.*`). Field lookups now walk each
  `.`-separated segment's own nested `properties`.
- Fixed a redaction bug in `redactSecretLikeText`: a secret value containing an escaped quote
  (`\"`) could leak the remainder of the value in plaintext next to `[REDACTED]`. The matching
  pattern is now escape-aware.
- Fixed `gaps`'s regression "growing" verdict: the threshold was scaled by `Math.max(1, meanY)`,
  which collapsed toward zero whenever the mean gap was negative. Now scaled by `Math.abs(meanY)`.
- Corrected `gaps`'s self-time documentation and tests: the raw signed-gap sum is only
  approximately, not exactly, equal to the naive self-time formula (a child span nested with slack
  breaks the exact identity).
- Refreshed the OpenTelemetry semantic-convention attribute list backing `--with-samples`, which
  had gone stale and rendered an empty samples column against current data.
- Fixed VCAP `instance_name` matching, `track_total_hits` not being set on paginated queries, four
  commands silently discarding their own truncation flag, a `--limit 0` footgun on `find`/`sample`
  that returned zero rows without warning, a `diff --sort pct` ranking bug when both sides were
  zero, and a missing fallback in `getRegionKeyForApi` for valid SAP regions not yet in the static
  map.
- Added regression tests covering every fix above.

## 0.1.0

Initial release.

- Read-only query and analysis CLI over OpenTelemetry spans already ingested into SAP Cloud
  Logging's OpenSearch backend (`otel-v1-apm-span-*`), reached through the OpenSearch
  Dashboards console-proxy.
- Twelve commands: `sample`, `mapping`, `find`, `top`, `count`, `spans`, `span`, `fields`,
  `selftime`, `gaps`, `detached`, `diff`, plus a `result` subtree (`show`/`list`/`prune`/`clear`)
  for refs saved via `--save`.
- `--region`/`--org`/`--space` targeting with ambient `cf target` fallback and a resolved-target
  stderr notice, matching `cf-hana`'s convention.
- A credential-discovery decision tree for the Cloud Logging dashboards basic-auth credential:
  existing service keys, then pre-SAML app bindings, then (only behind the explicit
  `--allow-mint-credential` opt-in) a temporary SAML disable/mint/restore cycle with redacted
  logging and a loud, distinct error if the restore step itself fails.
- `--format table|json|json-compact|csv` and `--save`/`result show` on every row-returning
  command, mirroring `cf-hana`.
- `search_after`-based pagination past OpenSearch's default `max_result_window` (10000) for
  `spans`, verified against a 10000+ span synthetic trace in both the unit and e2e suites.
