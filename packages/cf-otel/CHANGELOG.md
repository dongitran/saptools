# Changelog

All notable changes to `@saptools/cf-otel` are documented in this file.

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
