# Changelog

## 0.1.50

- Resolved local string, enum-member, and const-object decorator arguments with persisted evidence while keeping unsupported expressions conservative.
- Prevented handler registrations with exact class ids from producing cross-repository class-name candidates; genuine duplicate implementations remain ambiguous with scoped hints.
- Added copyable service-and-path trace-start selectors and strict doctor aggregates for decorator resolution and registration pairing.
- Added a neutral implementation-resolution workspace with SQLite, trace, hint, and runtime-variable regression coverage.

## 0.1.49

- Unified direct and wrapper operation-path analysis with deterministic static, ambiguous, and dynamic candidate evidence while preserving lexical scope and source order.
- Prevented future or mutable service-client assignments from becoming persisted bindings; trace and strict doctor now distinguish direct, contextual, ambiguous, unrecoverable, and missing-parameter-metadata cases.
- Added explicit OData entity-versus-operation precedence evidence, richer trace-start remediation, capped implementation hint alternatives, and repository-correct guided traversal.
- Added a neutral seven-package CAP workspace covering runtime substitutions, contextual clients, imported wrappers, OData/entity paths, duplicate helper implementations, SQLite evidence, and CLI quality gates.

## 0.1.48

- Added deterministic `doctor --format json|table` output while preserving legacy-compatible default doctor output; JSON mode returns `[]` for clean workspaces and table mode renders concise diagnostic rows with capped hint lines.
- Documented the 0.1.47 audit follow-up evidence fields for service-client ownership chains, normalized OData operation paths, wrapper path candidates, and implementation hint suggestions.
- Bumped the package patch version for the service-flow audit follow-up release.

## 0.1.46

- Improved ambiguous implementation diagnostics with ready-to-copy scoped hint suggestions for each blocked helper hop.
- Persisted deterministic service-client ownership across helper boundaries, object and tuple destructuring, returned clients, and transaction aliases while preserving dynamic evidence for ambiguous flows.
- Tightened OData operation-invocation normalization and dynamic wrapper-path evidence without promoting entity addressing paths to operation calls.
- Kept strict doctor output concise by default with actionable categories and detail-mode evidence expansion.

## 0.1.45

- Added repeatable scoped implementation hints with explicit selection and mismatch evidence while preserving conservative automatic and legacy repository selection.
- Propagated proven CAP clients and literal or runtime wrapper paths across relative imports, including object, array, returned-client, and transaction contexts.
- Kept OData invocation arguments, routing placeholders, and compact candidate scores distinct while preserving terminal entity paths.
- Added compact strict-doctor summaries with actionable detail mode and expanded publication atomicity recovery coverage.

## 0.1.44

- Separated trace-time effective resolution evidence from persisted graph resolution, including runtime substitution details and missing `--var` suggestions.
- Added duplicate package-name implementation ambiguity evidence plus trace-time implementation repo hints for guided traversal.
- Aggregated strict doctor implementation candidate noise into actionable categories with capped examples.
- Tightened contextual binding, nested wrapper, OData invocation, and incremental publication atomicity regression coverage.

## 0.1.43

- Reconciled inherited CDS operation search rows from the exact effective-operation set during extension materialization.
- Invalidated concrete extension repositories when derived inherited operations or base resolution semantics change, while preserving no-op generations.
- Tightened lexical binding scope so nested block declarations inside catch and loop bodies do not escape their real blocks.
- Classified proven CAP `send(operationName, payload)` calls, including immutable aliases, without applying the rule to generic `send()` receivers.

## 0.1.42

- Continued inherited CDS extension operations into the selected base implementation while retaining concrete routing evidence.
- Reconciled materialized inherited operations on reindex so renamed or removed base operations do not leave stale effective rows.
- Kept ambiguous or unresolved extension bases without a selected base id and ignored commented CDS `using` declarations.
- Added positional remote CAP `Service.send(method, path, ...)` classification for proven CAP clients and tightened catch/loop lexical constant resolution.

## 0.1.41

- Added imported CDS extension provenance and materialized inherited operations at concrete extension paths without guessing by simple service name.
- Resolved TypeScript identifier expressions through lexical bindings so module constants work and inaccessible shadowed block values are excluded.
- Classified positional CAP `Service.send(...)` dispatch only for proven CAP service receivers while leaving generic `send` calls untouched.
- Bumped the SQLite schema to persist extension/base and operation provenance metadata.

## 0.1.40

- Hardened operation path expression analysis to respect lexical scope, declaration order, aliases, and bounded branch candidates.
- Kept external URL and destination templates with substitutions dynamic with sanitized labels.
- Fixed CDS path annotation parsing for prefix/suffix annotations and supported service extension syntax.

## 0.1.35

- Hardened OData path precedence so entity key, navigation, and media/property paths with placeholders remain terminal entity evidence instead of dynamic operation candidates.
- Preserved separate evidence for service-routing placeholders, operation invocation argument placeholders, and entity key placeholders.
- Render operation-resolved parser entity calls as operation calls in traces while retaining the original parser call type for auditability.
- Added strict doctor coverage for dynamic remote-entity false positives without indexed operation evidence.

## 0.1.34

- Prefer indexed CDS operation evidence over heuristic remote-entity classification for service-client operation invocations, while keeping true collection, entity, delete, navigation, and media paths terminal.
- Added strict doctor collision diagnostics for terminal remote entity edges that look like operation invocations with indexed operation candidates.
- Persist repository fact analyzer versions and warn during link/strict doctor when force reindex is required after an analyzer upgrade.

## 0.1.33

- Preserved persisted graph decisions and call-site evidence during trace and graph rendering while keeping contextual runtime resolution as enrichment.
- Classified OData entity reads, mutations, deletes, navigation, media streams, and uppercase entity candidates as terminal remote entity edges instead of unresolved operation candidates.
- Kept dynamic external HTTP destinations dynamic with stable synthetic ids, neutral labels, bounded safe candidates, and sanitized URL evidence.
- Bumped the SQLite schema capability to version 7 and added strict doctor diagnostics for legacy schema drift and reindex-required external metadata.
- Standardized terminal trace-start diagnostics so non-traversable starts return zero graph nodes and edges by default.

## 0.1.32

- Hardened operation-first trace starts to fail closed on ambiguous, rejected, or non-executable implementation evidence.
- Made decorator normalization explicit and conservative for unsupported expressions.
- Populated queryable external HTTP target metadata with sanitized labels and kept CAP candidates distinct from HTTP endpoints.
- Removed accidental fresh-schema external-target columns from symbols and documented migration/re-index expectations.

## 0.1.31

- Resolve operation and path trace selectors from indexed CDS operations and persisted implementation edges before conservative handler fallback, including generated `Action<Name>` and `Func<Name>` decorator constants whose method names differ from public operation names.
- Emit the selected start operation and initial implementation hop once, with structured start-resolution evidence and ambiguity/not-found diagnostics that point to the operation, implementation edge, or handler-scope stage.
- Replace numeric external HTTP terminal targets with semantic external destination and endpoint nodes, preserving redacted structured target evidence for destinations, static URLs, dynamic URL expressions, and unknown calls.
- Add schema version 6 migration columns for queryable external target metadata and a strict doctor aggregate for external HTTP target quality.

## 0.1.30

- Normalize balanced OData operation invocations when multiline template placeholders appear inside function/action argument lists.
- Preserve invocation argument placeholders as non-routing evidence instead of treating them as missing operation-target runtime variables.
- Reuse the shared OData invocation normalizer during contextual trace resolution so persisted links and trace-time helper propagation handle the same path shapes.
- Keep GET entity key reads, navigation reads, and collection queries terminal unless strong indexed operation evidence resolves them.

## 0.1.29

- Classify GET OData entity/query paths with query strings, filter functions, key predicates, navigation reads, and query placeholders as terminal remote query/entity edges when no strong indexed CDS operation candidate resolves them.
- Preserve raw path, entity segment, query-string presence, query placeholders, method, and classifier reason in link evidence without creating dynamic operation edges from query parameters.
- Keep balanced top-level OData action/function invocation normalization for real operation imports while avoiding truncation at parentheses inside query strings.
- Document the conservative entity-query versus operation-invocation distinction for neutral CAP service-client calls.

## 0.1.28

- Propagate contextual service-client bindings through one-level object-parameter destructuring aliases, including renamed and assignment destructuring in neutral CAP helpers.
- Prefer caller-site higher-order wrapper remote-action evidence for literal wrapper paths while keeping dynamic wrapper path diagnostics on the caller edge.
- Refine contextual implementation selection evidence for duplicate helper candidates and report structured duplicate-candidate ties when selection is unsafe.
- Fix strict doctor contextual opportunity metrics so aggregate totals, capped examples, and actionable severity remain internally consistent.

## 0.1.27

- Enrich trace-time contextual service-client bindings from package-level CAP `cds.requires` aliases so helper-internal sends resolve through require-derived service paths and destinations.
- Preserve contextual binding attempt evidence for unresolved helper sends, including effective service path, destination, candidate counts, and resolution reasons.
- Refine strict doctor diagnostics for contextual helper sends to distinguish resolved contextual opportunities, missing `cds.requires` rows, require-backed unresolved sends, remaining runtime variables, and workspaces with no contextual opportunity.
- Expand neutral CAP coverage for positional helper arguments, destructured object helper parameters, renamed properties, late assignments, table output, Mermaid output, and require-derived target operations.

## 0.1.26

- Resolve helper-internal remote sends contextually in trace output when service clients are passed through positional arguments or one-level destructured object parameters.
- Add auditable contextual binding evidence for propagated helper client receivers, including caller argument, caller object property, callee parameter, callee receiver, and propagation source.
- Keep nested `this.<property>.<method>()` symbol-call resolution conservative unless explicit same-file or relative-import helper instance evidence exists.
- Update strict doctor diagnostics for trace-time contextual propagation opportunities and nested `this` receiver quality signals.

## 0.1.25

- Make class-instance symbol-call indexing conservative so only same-file and relatively imported helper classes are traced, while built-in collection, date, URL, error, typed-array, promise, and abort-controller instances are ignored.
- Persist identifier and one-level destructured object parameter metadata for executable symbols, including class methods, so contextual service-client binding propagation can map helper arguments to callee receiver names.
- Propagate contextual service bindings through positional helper arguments and destructured object helper parameters with auditable caller and callee evidence.
- Refine unresolved operation diagnostics when indexed candidates exist but service context is absent or the resolution score is below threshold.

## 0.1.24

- Add conservative class instance method symbol-call resolution for same-file and relatively imported helper classes, with auditable class-instance evidence.
- Propagate service-client binding context through resolved local symbol calls for explicit positional and object-literal helper arguments during trace rendering.
- Harden one-hop higher-order send wrapper literal path propagation for returned async closures and expose wrapper definition evidence.
- Refine strict doctor categories for no-binding remote actions and split ambiguous versus unresolved implementation diagnostics with capped examples.

## 0.1.23

- Retrospective note: preserve same-file late-assignment service binding extraction for connected clients, `cds.connect.to(...)` assignments, identity aliases, and simple transaction aliases before outbound `send(...)` calls.
- Retrospective note: preserve explicit object destructuring from safe helper-returned client objects so binding rows remain available for downstream remote action linking.

## 0.1.22

- Propagate conservative same-file identity aliases of connected service clients, including typed, `as`, `satisfies`, helper-returned, and transitive aliases, while preserving `.tx()` alias evidence.
- Link outbound `send(...)` calls through identity aliases to the closest same-file binding row so destination, service-path, placeholder, and helper-chain evidence remains available.
- Add narrow same-file wrapper literal-path propagation for wrappers that pass a client parameter directly to `send({ path })`; dynamic wrapper paths remain semantic dynamic targets with parser warnings.
- Improve trace-time contextual implementation selection evidence and suppress stale ambiguous unresolved reasons when a unique contextual handler is selected.
- Expand `doctor --strict` with alias-binding, no-binding remote-action, contextual implementation, and wrapper path propagation quality aggregates.

## 0.1.21

- Propagate helper-returned connected clients from function declarations, arrow-function variables, function-expression variables, named export lists, and aliased exports into caller destructuring and transaction aliases.
- Preserve conservative object-return analysis by binding only returned properties backed by local `cds.connect.to(...)` client variables, while ignoring unrelated metadata fields.
- Document contextual implementation selection evidence and strict doctor checks for operation-path-only remote actions.

## 0.1.20

- Preserve service-binding evidence when helpers return connected clients inside object properties and callers destructure or create simple transaction aliases.
- Track full template-expression placeholder keys such as `${domainInfo.serviceName}`, `${domainInfo.shortName?.toLowerCase()}`, and `${items[0].service}` for runtime `--var` substitution without evaluating JavaScript.
- Render unresolved remote actions with unknown or dynamic paths as semantic targets instead of numeric call ids, with parser evidence for shorthand `path` identifiers.
- Expand strict doctor aggregates for normalized OData invocation ambiguity and remote-action unresolved target quality.

## 0.1.19

- Normalize balanced top-level OData action/function invocation paths before remote operation resolution, including namespace-qualified invocation lookup, while preserving raw and normalized evidence.
- Model remote service-client queries as terminal remote-query edges with stable semantic targets instead of unresolved operation calls.
- Add strict doctor aggregates for remote-query target quality and OData invocation resolution quality.
- Document remote query terminal semantics and normalized invocation resolution behavior.

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
