# Changelog

## 0.1.7

- Added atomic last-good repository publication so failed source reads preserve the previous complete snapshot and fingerprint.
- Added explicit graph freshness metadata and stale diagnostics after successful fact changes until relink.
- Persisted handler registration class/import evidence and linked registered cross-package implementation handlers through application dependency evidence.
- Made service-only trace selectors return a typed narrowing diagnostic instead of workspace-wide traversal.
- Expanded link summaries with dependency and implementation categories whose totals reconcile with persisted graph edges.
- Preserved terminal parser warning evidence separately from routing status.


## 0.1.6

- Scoped runtime variable resolution to eligible dynamic, ambiguous, or unresolved remote edges with matching placeholders, preserving terminal and static resolved edge status, target, reason, and confidence.
- Clamped operation-resolution confidence to the `[0, 1]` range and retained original runtime expressions alongside effective substitutions and missing-variable evidence.
- Resolved helper/package dependency graph edges primarily by indexed package name, persisted ambiguous dependency candidates with evidence, and marked inserted helper edges with explicit statuses.
- Expanded repository fingerprints to include normalized package metadata, full `cds.requires`, scripts, package file content, and the analyzer version so metadata-only changes invalidate stale facts.
- Replaced the hard-coded CLI version with package metadata as the release source of truth and documented selector, graph variable, SQLite, fingerprint, freshness, and parser-warning semantics.

## 0.1.5

- Runtime `--var` substitution now re-runs operation resolution in memory for trace and graph output, clears stale unresolved reasons on exact matches, and traverses into the matched downstream handler without mutating the persisted graph.
- Operation nodes now use target CDS provenance while call-site evidence remains on edges.
- Graph edges now carry explicit status values for resolved, terminal, dynamic, ambiguous, and unresolved cases; normal DB, external HTTP, and event terminals no longer receive remote-resolution failure text.
- Replaced per-statement SQLite shelling with a persistent `node:sqlite` connection, bound parameters, transactions, read-only query openings, WAL, busy timeouts, and connection-local foreign-key enforcement.
- Added schema user-version migration support for edge status and repository fingerprints.
- Repository indexing now skips unchanged repositories unless `--force` is supplied and reports indexed/skipped counts.
- `service-flow --version` now matches package metadata for the 0.1.5 release.

## 0.1.4

- Resolved helper-returned service bindings exported through named export lists, including aliased exports, while preserving helper-chain evidence.
- Parsed `cds.connect.to(alias, options)` as separate alias, destination, and service-path evidence so dynamic service paths can resolve with runtime variables.
- Improved repository discovery so valid workspace-root Git repositories no longer prevent nested repository discovery, and empty `.git` markers are ignored.
- Added explicit SQLite foreign-key constraints for fresh databases and recorded alias-expression evidence for service bindings.
- Documented clearer operator guidance for test-file hygiene, doctor severity, and list/trace selector semantics.

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
