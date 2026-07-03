# Changelog

## 0.1.3

- Propagated imported helper-returned `cds.connect.to(...)` bindings to caller-local service variables with helper-chain evidence.
- Changed operation resolution to prefer ambiguous/dynamic/unresolved graph edges over confident operation-path-only links.
- Improved chained CAP query entity extraction and table/JSON source-location evidence.
- Hardened trace traversal with repo-aware downstream scopes, stable visited keys, edge de-duplication, and cycle markers.
- Added safer clean behavior that only recursively removes marker-owned state directories.
- Added `doctor --strict` to separate entity-only service noise from action-oriented default diagnostics.

## 0.1.2

- Hardened SQLite CLI access with busy timeouts, retries, and larger read buffers for large graph/link runs.
- Improved CDS service extraction for annotation placement/whitespace variants and materialized inherited operations for `extend service` declarations.
- Scoped service binding resolution by source file and added helper-returned binding propagation to prevent cross-file variable false positives.
- Improved outbound call extraction for `SELECT.one.from` and common CAP query builders.
- Reworked trace traversal to consume linked graph edges recursively and populate JSON nodes.
- Added doctor health checks for silent index-quality issues.

## 0.1.0

- Initial `@saptools/service-flow` CLI package for indexing and tracing SAP CAP service flows.
