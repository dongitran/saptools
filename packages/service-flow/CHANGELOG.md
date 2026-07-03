# Changelog

## 0.1.1

- Hardened SQLite CLI access with busy timeouts, retries, and larger read buffers for large graph/link runs.
- Improved CDS service extraction for annotation placement/whitespace variants and materialized inherited operations for `extend service` declarations.
- Scoped service binding resolution by source file and added helper-returned binding propagation to prevent cross-file variable false positives.
- Improved outbound call extraction for `SELECT.one.from` and common CAP query builders.
- Reworked trace traversal to consume linked graph edges recursively and populate JSON nodes.
- Added doctor health checks for silent index-quality issues.

## 0.1.0

- Initial `@saptools/service-flow` CLI package for indexing and tracing SAP CAP service flows.
