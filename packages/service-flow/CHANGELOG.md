# Changelog

## 0.1.18

- Applied conservative CAP receiver eligibility to `.emit()` and `.publish()` so generic realtime, socket, DOM, and EventEmitter-style calls no longer become CAP async event facts without explicit CAP messaging/service evidence.
- Added structured parser evidence for local CAP service calls, including source offsets, service lookup/name, operation, and alias chain.
- Propagated outbound parser evidence into call-derived graph and JSON trace evidence under `outboundEvidence` for remote, local, DB, external, and async edges.
- Clarified graph-level dynamic flags so terminal DB, external, and event edges stay static while dynamic binding details remain in edge evidence.
- Expanded `doctor --strict` with outbound evidence, graph evidence propagation, event receiver classification, and dynamic terminal-edge consistency aggregates.

## 0.1.17

- Replaced remaining raw-text outbound call detection with TypeScript AST classification so comments and strings do not create outbound facts or graph edges.
- Added AST parser/range evidence for outbound calls and conservative CAP/service event registration ownership.
- Tightened synthetic callback and async subscription classification to avoid generic response `.send()` and non-CAP event listener noise.
- Expanded strict doctor ownerless source categories and examples.

## 0.1.16

- Index class property arrow/function members as executable symbols so outbound calls inside handler helper properties receive precise source-symbol ownership.
- Add conservative synthetic callback symbols for top-level CAP lifecycle, route, and event callbacks that contain supported outbound calls.
- Harden proxy-member symbol-call resolution with richer evidence and avoid ambiguous repository-wide member-name fallback.
- Split `service-flow link` operation-call output into remote resolved, local resolved, unresolved, ambiguous, dynamic, and terminal buckets.
- Extend strict doctor ownership diagnostics with ownerless outbound-call details by call type and syntactic gap.
- Keep `OutboundCallFact.sourceSymbolQualifiedName` aligned with persistence by preferring explicit qualified names before line-range fallback.

## 0.1.15

- Fixed `symbol_calls.evidence_json` persistence so inserted rows store the parser evidence object instead of a numeric repository id, with explicit initial resolved/unresolved statuses.
- Added strict doctor diagnostics for non-object symbol-call evidence, documented unresolved/unknown parser-quality thresholds, and outbound-call source-symbol ownership ratios.
- Made exported public static class methods addressable through relative imports while keeping non-exported, private/protected, and package-imported class member calls conservative.
- Indexed exported shorthand object maps as alias symbols and added conservative proxy-variable evidence for `const worker = ExportedClass.staticFactory(); worker.method()` flows when the factory comes from a relative import.
- Preserved 0.1.14 symbol-call noise filtering, semantic unknown DB targets, terminal transport-client classification, and strict parser-quality aggregates.

## 0.1.14

- Made local symbol-call indexing opt-in: CAP DSL, request helpers, package namespace/CommonJS calls, global runtime APIs, and service-client transport helpers are filtered unless indexed local or relative-import evidence makes the edge actionable.
- Expanded local DB query entity extraction for `SELECT.one(Entity)`, `UPSERT.into(Entity)`, `UPDATE.entity(Entity)`, static element access such as `this.model['Books']`, and clearer dynamic-query warning reasons.
- Persisted unknown DB query graph targets as semantic `db_entity:unknown` terminal nodes with source `callId` and parser-warning evidence, so fresh relinks no longer store numeric call ids as DB targets.
- Classified unresolved local service-client `.send`, `.emit`, `.publish`, and `.on` calls as terminal transport/client calls when the model does not declare a matching operation, while preserving real declared operations.
- Tightened doctor default local-service warnings and added compact `doctor --strict` symbol-call and DB-query quality aggregates with capped top unresolved examples.
- Added neutral regression fixtures for symbol-call noise, DB query forms, and local service-client methods.

## 0.1.13

- Added implementation-context fallback for local `cds.services.*` calls so helper packages can resolve model-package operations only when handler/dependency/registration evidence ties the caller repository to the target operation.
- Preserved same-repository local service resolution as the strongest path and added explicit evidence/reasons for implementation-context ownership, rejected candidates, and candidate-without-caller-ownership cases.
- Replaced fragile CAP DB query string extraction with AST traversal for chained `cds.run(SELECT/INSERT/UPDATE/DELETE...)` forms, including multiline `columns(...).where(...)` chains and `this.EntityName` targets.
- Kept genuinely dynamic DB queries terminal while exposing parser-warning evidence and rendering unknown targets as `Entity: unknown` instead of raw numeric call ids in table/Mermaid output.
- Further reduced symbol-call noise by filtering built-in collection/string methods, logger calls, global built-ins, third-party package property calls, and unindexed `this.container.method()` calls while retaining indexed local helpers and relative object-literal helper imports.
- Added doctor aggregate visibility for local service calls resolved by implementation context and calls left unresolved because candidates lack caller ownership.
- Updated README and technical notes to clarify generated constants remain low-level parser output rather than persisted graph facts.

## 0.1.12

- Resolved same-repository local CAP service calls by qualified CDS name, simple service name, and service path, with explicit local transport and alias-chain evidence.
- Made implementation matching decorator-aware so generated `Func*`/`Action*` constants outrank method-name fallback and contradictory decorators are rejected without making edges ambiguous.
- Cleared stale unresolved reasons from resolved symbol calls and suppressed false trace unresolved reasons for symbol edges with concrete callee ids.
- Made local symbol-call collection conservative, added named export-list support, and indexed one-level object-literal helper methods as executable symbols so traces can reach helper database queries.
- Added first-class symbol nodes and readable symbol labels/locations to JSON, table, and Mermaid trace output.
- Deduplicated implementation candidates by method identity while retaining multiple registration rows as nested evidence, and kept default doctor output from failing on explainable source-ownership gaps.
- Documented the generated-constant decision: this patch uses deterministic decorator normalization for linking while `parseGeneratedConstants` remains a low-level parser export rather than a persisted graph fact.

## 0.1.11

- Added repository-owned executable symbols, source-symbol ownership for outbound calls, and local symbol-call facts so traces can follow reachable same-file/imported helpers without including unrelated calls from the same file.
- Replaced local CAP service call extraction with AST alias tracking for `cds.services` lookups, ignored entity accessors, and linked local calls to exact local operations with explicit local transport evidence.
- Scoped service/path trace starts by repository, reports ambiguous starts instead of choosing the first row, and queues resolved implementation handlers by their handler repository and symbol identity.
- Deduplicated operation implementation candidates by logical identity while preserving distinct registration evidence in nested arrays.
- Link output now reports implementation-unresolved counts, table evidence falls back to nested implementation source locations, and depth `step` values remain within the requested scope depth.
- Generated-constant claims were removed from runtime documentation until persistence and resolution are fully integrated.
- Doctor now reports aggregate analyzer-quality diagnostics for systematic local-service, source-symbol, and trace-scope problems.

## 0.1.10

- Persist unresolved `OPERATION_IMPLEMENTED_BY_HANDLER` audit edges when implementation candidates exist but all are rejected, including ranked candidate evidence and rejected reasons.
- Added a conservative helper-owned implementation path for unique registered helper handlers that implement model-oriented CDS operations without direct package dependency evidence, while keeping multiple helper matches ambiguous and local service-path contradictions rejected.
- Trace output now includes operation-to-handler implementation hops and terminal handler nodes in JSON/table/Mermaid-compatible edge data, including runtime-resolved operation targets.
- Doctor now reports rejected implementation candidates and strict remote-target implementation coverage gaps without making entity-only services noisy by default.
- Updated Node compatibility errors, package metadata, and README wording so current behavior is not described with stale release-specific version strings.

## 0.1.9

- Fixed implementation dependency matching by binding graph repository ids as text when comparing against `graph_edges.from_id` and `graph_edges.to_id`, restoring cross-package application-to-model and application-to-handler evidence under `node:sqlite`.
- Improved implementation candidate ranking with model/application/handler package ownership, exact local service-path evidence, and cross-package dependency/import signals so duplicate operation names in different services resolve to the correct registered handler without false ambiguity.
- Expanded `OPERATION_IMPLEMENTED_BY_HANDLER` evidence with candidate ranks, scores, accepted/rejected reasons, package identities, service/operation paths, and dependency/ownership signals for auditability.
- Added neutral regression coverage for cross-package app/model/handler registration, duplicate same-name service operations, and graph-id string comparison behavior.

## 0.1.8

- Replaced regex-only handler registration extraction with TypeScript AST evidence for direct handler arrays, identifier arrays, spreads, imported arrays, default exports, aliases, and safe relative re-exports.
- Persisted class-level `handler_registrations` rows with registration file/line and import evidence so registered handlers can be resolved across same-repository and cross-package layouts.
- Relaxed implementation linking to support same-repository registrations, handler-package-owned registrations, and application registrations while preserving ambiguous candidate evidence.
- Continued trace traversal from static and runtime-resolved operations into registered implementation handlers via `OPERATION_IMPLEMENTED_BY_HANDLER` edges.
- Moved source discovery, reads, and fingerprinting into the protected repository indexing flow so failed reads preserve last-good facts/fingerprints and produce doctor-visible diagnostics.
- Added a legacy-schema doctor warning when migrated stores lack fresh foreign-key metadata for key tables.
- Suppressed the known `node:sqlite` experimental warning for normal supported-runtime database commands without suppressing application errors.
- Changed `index_run_abandoned` doctor policy to report only running index runs older than the documented 60-minute threshold, including run id and start time.

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
