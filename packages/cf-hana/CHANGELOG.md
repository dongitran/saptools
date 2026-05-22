# Changelog

## 0.1.1 - 2026-05-22

- Patch release to publish via npm trusted publishing after the manual `0.1.0` bootstrap.

## 0.1.0 - 2026-05-22

- Initial release: run SQL directly against SAP HANA Cloud databases bound to a Cloud Foundry app, addressed by a `region/org/space/app` selector (or a bare app name).
- Credentials are resolved cache-first via `@saptools/cf-sync`, with an on-demand live Cloud Foundry fetch fallback.
- Includes a `HanaClient` with pooled connections, parameterized queries, transactions, table introspection, query-builder shorthands, a read-only/destructive-statement safety guard, and a `cf-hana` CLI.
