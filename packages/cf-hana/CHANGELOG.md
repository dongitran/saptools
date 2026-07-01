# Changelog

## 0.3.1 - 2026-07-01

- Remove the `cf-hana: saved result expires at...` stderr notice from `query --save` output while keeping result refs available for inspection.

## 0.3.0 - 2026-07-01

- Add invalid table/view recovery suggestions for failed `query` statements, with nearby table and view names printed to stderr so stdout remains parseable.
- Add a private local metadata cache under `~/.saptools/cf-hana/metadata` with a strict 30-minute TTL and `--refresh-metadata` bypass.
- Include schema-scoped `SYS.TABLES` and `SYS.VIEWS` metadata for suggestions without caching credentials, parameters, result rows, or table data.

## 0.2.0 - 2026-06-25

- Change CLI `query` output for `SELECT`/`WITH` statements to compact CSV and
  remove `--format` from `query`.
- Default bare `SELECT` queries to at most 100 returned rows, with accurate
  N+1 truncation detection.
- Limit visible SELECT data cells to 128 characters by default, configurable
  with `--cell-limit <n>` up to 10,000.
- Add `query --save` and `cf-hana result` commands to save exact returned rows
  for 60 minutes, inspect rows/cells/JSON paths by ref, search saved values,
  export exact cells, and prune local result sessions.
- Keep programmatic query APIs and write backups full-fidelity.

## 0.1.6 - 2026-06-23

- Expand fake-backed E2E coverage for complex `UPDATE` and `DELETE` backups,
  including mixed-case keywords, comments, quoted identifiers, nested queries,
  placeholder filtering, and unscoped writes.
- Verify backup SELECT failures, write failures, filesystem failures, read-only
  mode, malformed SQL, and parameter mismatches cannot bypass backup safety.
- Add opt-in fake-driver statement tracing and deterministic failure injection
  without recording parameter values.

## 0.1.5 - 2026-06-23

- Remove the CLI `--no-backup` opt-out so `cf-hana query` always attempts a
  local backup before running `UPDATE` or `DELETE`.
- Keep backup paths on stderr and keep stdout parseable for table, JSON, and CSV
  output.

## 0.1.4 - 2026-06-23

- Add automatic local CSV backups before CLI `query` runs an `UPDATE` or
  `DELETE`.
- Derive the backup `SELECT` from the write target and top-level `WHERE`
  clause, preserving only the WHERE parameters for `UPDATE` statements.
- Save each backup in its own non-expiring folder with `statement.sql` and
  `backup.csv`.

## 0.1.3 - 2026-06-23

- Add local SQL history for successful direct `query` and `execute` calls under
  `~/.saptools/cf-hana/histories/YYYY-MM-DD.jsonl`.
- Rotate SQL history with five-day retention and keep parameter values,
  credentials, certificates, and result rows out of the history file.
- Keep helper-driven catalog SQL out of user SQL history and document the new
  local state behavior.

## 0.1.2 - 2026-06-23

- Harden connection pooling so queued callers continue after transient reconnect failures.
- Preserve query results when HANA statement cleanup fails and close partially opened clients on schema setup errors.
- Strengthen read-only and destructive-statement checks around comments, quoted identifiers, and unknown statements.
- Improve `explain()` statement isolation, cleanup, and read-only behavior.
- Validate CLI numeric options strictly and align E2E diagnostics with project defaults.

## 0.1.1 - 2026-05-22

- Patch release to publish via npm trusted publishing after the manual `0.1.0` bootstrap.

## 0.1.0 - 2026-05-22

- Initial release: run SQL directly against SAP HANA Cloud databases bound to a Cloud Foundry app, addressed by a `region/org/space/app` selector (or a bare app name).
- Credentials are resolved cache-first via `@saptools/cf-sync`, with an on-demand live Cloud Foundry fetch fallback.
- Includes a `HanaClient` with pooled connections, parameterized queries, transactions, table introspection, query-builder shorthands, a read-only/destructive-statement safety guard, and a `cf-hana` CLI.
