# Changelog

## 0.1.4 - 2026-06-23

- Add automatic local CSV backups before CLI `query` runs an `UPDATE` or
  `DELETE`.
- Derive the backup `SELECT` from the write target and top-level `WHERE`
  clause, preserving only the WHERE parameters for `UPDATE` statements.
- Save each backup in its own non-expiring folder with `statement.sql` and
  `backup.csv`, and add `--no-backup` for explicit CLI opt-out.

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
