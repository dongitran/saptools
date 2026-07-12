# Service Flow Resolution Notes

## 0.1.54 runtime-current diagnostics and selected handler notes

- Contextual service-binding resolution now emits typed local trace state instead of passing a message string as control flow. `dynamic_missing`, `ambiguous_binding`, `ambiguous_operation`, `no_matching_operation`, and other conservative blockers remain distinguishable; `contextualPreSubstitutionState` preserves the historical attempt without changing a persisted graph row.
- Dynamic analysis runs after supported route expressions receive supplied values. Its deterministic post-substitution missing-key set controls the edge reason, `effectiveResolution.unresolvedReason`, and `linker.reason`; a supplied-value no-match wins over a stale missing-variable state. Structural blockers remain in `contextualBlocker` and block automatic selection.
- Resolved implementation evidence now stores `selectedHandler` derived from the actual graph `to_id`. It includes method/class/repository/source provenance and is checked again at trace time. A mismatch is diagnostic evidence; rendering uses the actual graph target rather than a candidate-array position, and a missing target blocks handler traversal.
- Implementation candidate `rank` remains the discovery-score rank. `displayRank` and `selected` describe the presentation order, which puts a resolved selected handler first and then preserves deterministic accepted/rejected ordering. Generic bounded projections preserve producer-established semantic order; unordered producers retain their explicit comparators before projection.

## 0.1.53 call-scoped dynamic routing and bounded evidence notes

- Runtime routing starts from the outbound call's selected binding when one exists. Its service path, alias, destination, source location, and helper-return chain form one call-scoped context; fallback repository references are marked as fallback and cannot override a selected binding. Multiple distinct fallback bindings are never combined into one derived route.
- Template matching substitutes only explicit `--var` values, then matches the original template exactly against a concrete service target. A concrete mismatch rejects the candidate. Alias and destination evidence is evaluated only from that same validated binding or an alias-matched package require in the caller repository.
- Explicit values remain authoritative only when compatible. A deterministic value derived from a selected binding signal or concrete route-owner identity conflicts with an incompatible supplied value, rejects that candidate, and reports `no_candidate_after_runtime_substitution` instead of permitting generic service-path resolution.
- Identity derivation is tied to the repository that owns the concrete service path. Inherited operations may use a resolved helper implementation as implementation evidence, but neither helper nor base-model identity is a fallback source. Provenance retains the route owner, effective/base operation relationship, implementation status, normalized identity, and rule.
- Persisted graph and strict-doctor evidence project every candidate-like collection through the fixed cap with total, shown, and omitted metadata. Dynamic and implementation decisions query canonical SQLite facts before ranking or applying hints, so a capped JSON prefix is never treated as the complete search space. Detail output remains bounded.

## 0.1.52 dynamic target, lifecycle, and indexing notes

- Persisted graph storage remains conservative. Runtime-dependent remote targets still link as dynamic or unresolved graph edges unless static evidence is strong enough.
- Trace and graph accept `--dynamic-mode strict|candidates|infer`. Strict is the default and never traverses a target that still needs runtime values. Candidates mode emits only viable, explicitly unselected exploratory branches. Infer mode resolves only when the top viable candidate has every required value, scores at least `0.85`, exceeds the runner-up by more than `0.05`, and has no conflicting strong derivation.
- Explicit variables are substituted first and remain authoritative. Concrete service, operation, alias, or destination contradictions reject a candidate before viable counts or branch creation. A conflicting derived value is retained as conflict evidence and cannot replace the explicit value.
- Identity normalization removes an npm scope, splits camel case, lowercases, folds separator runs to `_`, and trims edge separators. Fallback then requires an exact whole-name template match with literal text on both sides of one placeholder, the concrete service route owner, a resolved implementation for the effective operation, and workspace-wide unique repository/package identity and derived value. Provenance records the matched source name, normalized form, and rule; substring, duplicate-name, discovery-order, and same-operation-name guesses remain ineligible.
- `--max-dynamic-candidates` bounds viable and rejected candidates, branches, suggestions, variable sets, nested provenance/conflict lists, and duplicate persisted candidate projections. `omittedCandidateCount` is always relative to viable candidates; rejected shown/omitted counts are separate.
- Supported zero-argument `OnCreate/Read/Update/Delete`, `Before*`, and `After*` method decorators require runtime imports and retain their original expression, canonical import evidence, lifecycle phase/event, and source location. Type-only imports, nonzero arguments, unsupported shapes, and body-less methods stay non-executable. Lifecycle and event rows are not CDS operation implementations without real operation facts; supported methods in a mixed class remain traceable with structured warnings.
- Schema version 11 adds nullable index-writer owner metadata. A short `BEGIN IMMEDIATE` claim serializes writers for one database, dead owners are recoverable, active owners fail with `index_writer_active`, and read-only commands remain available outside the short claim/publication transactions.
- Repository preparation stays sequential. Each discovered source and package metadata file is read once into a repository-scoped immutable snapshot; TypeScript parsers share one lazy AST per file. Publication remains one atomic transaction, and discovery/read/parse failures retain the last-good facts and fingerprint.

## 0.1.33 trace, entity, destination, and upgrade notes

- Trace and graph rendering use persisted resolved graph rows as authoritative base edges. Runtime/contextual resolution may add evidence such as substitutions or binding propagation, but persisted graph edge ids, outbound call ids, call-site file/line, parser evidence, linker status, selected target id, and target evidence remain present in effective edges.
- The trace-start machine contract is fail-closed: terminal start diagnostics produce zero graph nodes and zero graph edges by default. Candidate operations, implementation candidates, rejected edges, and selected ids are diagnostics-only evidence.
- Service-client OData entity paths are separated from action/function invocations. Entity reads, mutations, deletes, navigation, media stream calls, and uppercase entity-set candidates become terminal remote entity graph edges; lowercase operation-looking paths still go through operation resolution when indexed evidence exists.
- External HTTP destination extraction uses conservative static evaluation. Literals and safe local const literals are static; all other expressions stay dynamic unless a conditional has all-static branches, in which case a bounded safe candidate-literal projection, counts, and a sanitized expression shape are persisted.
- Schema version 7 follows an explicit reindex-required upgrade policy. Legacy external-target columns on `symbols` or missing queryable external metadata are strict doctor warnings with rebuild/reindex remediation instead of silent relink-only drift.

## 0.1.31 selector and external target notes

Operation trace selectors are resolved from CDS operation facts before handler-source fallback. The start resolver scopes by repository and service path, requires disambiguation when multiple repositories or services match, and only queues traversal from a resolved implementation edge. Generated operation decorator constants are normalized in `operation-decorator-normalizer` so linker, trace fallback, diagnostics, and tests share one conservative implementation.

Schema version 6 adds queryable external target metadata columns to `outbound_calls`. The linker writes semantic `external_destination` or `external_endpoint` graph targets and keeps redacted structured target details in edge evidence. Existing databases migrate forward without dropping facts; relinking rebuilds legacy numeric external HTTP targets.

## 0.1.30 OData invocation argument placeholder notes

- Balanced top-level OData function/action imports such as `/readDetails(ID='${id}',version=0)` now normalize to the operation segment even when placeholder expressions span multiple lines or contain nested JavaScript parentheses.
- Placeholders inside the invocation argument list are recorded as `invocationArgumentPlaceholderKeys` evidence. They are not route selectors and do not produce `missing_variable:*` operation-target diagnostics after a stable operation segment has been identified.
- Runtime `--var` substitution still applies to actual route selectors: service path, destination, alias, and dynamic operation path segments. GET entity key reads, navigation reads, and query-string placeholders remain conservative terminal remote query/entity evidence unless strong indexed operation evidence resolves them.
- Trace-time contextual service-client resolution uses the same shared OData invocation normalizer as persisted linking, keeping helper-propagated calls consistent with full graph linking.

## 0.1.29 OData entity-query intent notes

- Service-client `GET` paths with OData collection queries, filter/search functions in the query string, entity key predicates, navigation reads, or query-string placeholders are classified conservatively as terminal remote entity/query reads when no strong indexed CDS operation candidate resolves the path. Examples include `/Books?$filter=contains(title,'A')`, `/Books(ID='1000')`, and `/Authors('A1')/books?$select=ID`.
- Query-string placeholders are recorded as query evidence and do not make the operation target dynamic. Runtime variables in service paths, destinations, aliases, and true operation paths still keep the existing dynamic-edge behavior.
- OData invocation normalization no longer truncates paths at parentheses that appear inside query strings. Balanced top-level operation imports such as `/calculateScore(input='A')` continue to normalize and resolve against indexed CDS functions/actions when service evidence is strong.

## 0.1.22 alias, wrapper, contextual trace, and strict doctor notes

- Same-file service-client identity aliases now create their own service binding rows when the right-hand side is a known connected client variable. The parser accepts direct identifier aliases plus typed, `as`, and `satisfies` forms, supports source-order transitive aliases, and records `aliasKind: identity` helper-chain evidence. It still does not infer aliases from property reads, indexed access, function calls, object metadata, or cross-scope guesses.
- Outbound calls through identity aliases can attach to the closest alias binding row in the same source file, preserving alias, destination, service path, placeholder, and helper-chain evidence for link and trace.
- Wrapper path propagation is intentionally narrow: same-file wrappers can resolve literal caller paths only when a wrapper client parameter is passed directly to `.send(...)` and a wrapper path parameter is passed as `send({ path })`. Dynamic caller paths remain dynamic with parser-warning evidence.
- Contextual implementation selection now records selected/tied score evidence. When trace selects a unique contextual handler, the implementation hop sets `contextualImplementationSelected` and no longer renders the original ambiguous reason as a failure.
- Strict doctor adds compact aggregates for likely missed identity aliases, remote actions with operation paths but no binding id, contextual implementation stops, and wrapper dynamic-path candidates.

## 0.1.21 helper-return propagation and contextual trace notes

- Helper-return binding analysis uses the same returned-object scanner for `function` declarations, `async function` declarations, arrow-function variables, async arrow-function variables, and function-expression variables. Named export lists and aliases are resolved, so `export { connectCatalog as createCatalogClient }` can be destructured by callers without losing evidence.
- Returned object properties are bound only when their value is a local variable initialized from `cds.connect.to(...)`. Shorthand properties and explicit property assignments are supported; unrelated strings, codes, and metadata fields are ignored. Destructuring renames and `.tx()` aliases append helper-chain evidence instead of replacing the original binding evidence.
- Trace-time contextual implementation selection may use caller repository, runtime-resolved service path, destination or alias expression, package dependency evidence, handler and registration packages, and local service ownership to continue from an ambiguous operation edge into one handler. If candidates tie or no static signal is strong enough, trace keeps the ambiguous edge and reports the tie or unresolved reason.
- `doctor --strict` is the intended place for broad regression aggregates, including helper-return coverage, contextual implementation ambiguity, and remote actions that have an operation path but no service binding id.

## 0.1.20 helper object clients, expression placeholders, and remote-action target notes

- Helper-return binding analysis now follows concrete `cds.connect.to(...)` clients returned through object shorthand or explicit properties. Callers that destructure those properties, rename them, or assign a simple `.tx()` transaction alias keep helper-chain evidence including caller variable, returned property, helper source, destination expression, service-path expression, and placeholders. Arbitrary object returns are ignored.
- Template placeholders use the full trimmed expression inside `${...}` as the runtime key. Examples include `domain`, `domainInfo.serviceName`, `domainInfo.shortName?.toLowerCase()`, and `items[0].service`. Runtime `--var` substitution matches these keys literally and does not execute or partially evaluate JavaScript. Missing expression keys keep edges dynamic.
- Remote action calls that do not expose a static path now use semantic unresolved targets such as `Remote action: unknown path` or `Remote action: dynamic path`; shorthand `path` properties retain `operationPathExpression` and `dynamic_operation_path_identifier` parser evidence.
- Strict doctor reports normalized OData invocation totals by resolved/dynamic/ambiguous/unresolved status and remote-action target quality, including numeric unresolved targets and semantic unknown/dynamic target counts.

## 0.1.19 remote invocation and query notes

- Remote action/function paths are scanned for a balanced top-level OData invocation suffix. Single-segment operation imports like `/readConfig(...)` normalize to `/readConfig`; namespace-qualified operation imports keep the qualified request segment for evidence and can resolve against the indexed simple CDS operation when service signals are strong. Navigation/property paths like `/Orders(id='123')/items` are left unchanged. Graph evidence keeps both `rawOperationPath` and `normalizedOperationPath` when normalization occurs.
- Remote `send({ query })` calls without explicit operation-path evidence now become `HANDLER_RUNS_REMOTE_QUERY` terminal edges. Static entities produce `Remote entity: ...` targets; dynamic or unknown entities produce `Remote query: unknown` with parser-warning evidence.
- Strict doctor includes remote-query target-quality and OData invocation-resolution aggregates to catch numeric query targets and unresolved normalized invocation paths.

## 0.1.18 auditability notes

- CAP async event parsing treats `.emit()`, `.publish()`, and `.on()` consistently: a row is indexed only when the direct or chained root receiver has explicit CAP service or messaging evidence such as `cds` or a variable initialized from `cds.connect.to(...)`. Generic realtime/socket/EventEmitter receivers are ignored for CAP graph purposes by default.
- Local CAP service calls now carry TypeScript AST evidence with classifier, source offsets, service lookup/name, operation, and alias chain.
- Call-derived graph evidence nests persisted outbound parser evidence as `outboundEvidence`, allowing JSON trace output to explain parser classification without colliding with linker fields.
- `graph_edges.is_dynamic` means the edge itself requires runtime operation-target resolution. Terminal database, external HTTP, and async event edges keep `is_dynamic=0`; dynamic binding provenance remains in `evidence_json.bindingHasDynamicExpression`.
- Strict doctor adds aggregate checks for outbound evidence JSON quality, graph evidence propagation, event receiver classification, and dynamic terminal-edge consistency.

- Imported helper bindings: TypeScript imports are resolved for relative modules. When a caller assigns `const client = await connectToService()`, the analyzer follows the imported symbol to an exported helper that returns `cds.connect.to(...)` and persists caller-variable evidence plus the helper source/export chain.
- Candidate ranking: operation-path matches start as weak candidates. A resolved operation edge requires a strong signal such as exact service path, CDS alias/destination context, or explicit dynamic variable overrides. Otherwise candidates are preserved in edge evidence as ambiguous or unresolved.
- Edge states: `REMOTE_CALL_RESOLVES_TO_OPERATION` is used only above the resolution threshold; `DYNAMIC_EDGE_CANDIDATE` preserves runtime-dependent service paths/destinations; `UNRESOLVED_EDGE` carries candidate counts and reasons when static evidence is insufficient.
- Trace cycle safety: trace queues carry repository IDs, visited scope keys are independent of depth, graph edge IDs are emitted once, and revisiting an already-seen downstream operation scope creates a cycle marker instead of recursive expansion.
- SQLite reliability: the package uses a persistent SQLite connection per opened database, bound parameters, transactions, WAL, busy timeouts, read-only openings for query commands, and connection-local foreign-key enforcement. Native driver loading failures produce an actionable startup error before output rendering.

## 0.1.16 audit follow-up notes

- Executable symbol parsing now treats class property arrow functions and function-expression initializers as method-like symbols with `ClassName.memberName` qualified names. Their body ranges are persisted so outbound-call ownership can use the existing shortest enclosing range lookup.
- Synthetic callback symbols are intentionally narrow: only top-level CAP lifecycle, route, and event-registration callbacks whose bodies contain supported outbound calls/subscriptions are indexed as `module:<relative-file>#callback:<line>`. Ordinary anonymous callbacks remain out of scope to avoid broad call-graph noise.
- Proxy-member calls record proxy variable, factory expression, factory import source, and candidate strategy. Resolution prefers explicit object-map evidence and treats ambiguous repository-wide member-name matches as ambiguous instead of picking the first symbol row. Full whole-program TypeScript data-flow remains a non-goal.
- `link` summaries now distinguish remote and local operation-call resolutions, while retaining the aggregate `resolvedCount` in the programmatic result for compatibility.
- Strict doctor source-ownership diagnostics include ownerless groupings by call type and syntactic gap so remaining ownerless calls can be audited without weakening the threshold.

## 0.1.15 audit follow-up notes

- Symbol-call rows now require object-shaped parser evidence in strict doctor; this catches numeric JSON regressions that `json_valid()` alone would miss.
- Relative-import symbol resolution remains opt-in, but exported public static class members and exported shorthand object-map aliases are now addressable with explicit evidence (`exported_class_member`, `exported_object_shorthand`, and `relative_import_proxy_member`).
- Strict parser-quality aggregates document thresholds for symbol-call unresolved ratio (5%), local DB query unknown ratio (25%), and outbound calls without source-symbol ownership (1%).

## 0.1.14 audit follow-up notes

- Local CAP service calls keep same-repository service ownership as the strongest resolution path. When the caller repository does not own the CDS service model, the linker searches workspace operations by service identity and operation name/path, then requires caller ownership evidence from implementation edges, ambiguous implementation candidates, registration packages, or resolved dependency/import edges before resolving. Candidate operations without caller evidence are retained with `local_service_candidate_without_caller_ownership` rather than guessed.
- Trace traversal can use local-call context to choose the caller repository's handler from an otherwise ambiguous global implementation edge. This is scoped to the local call and does not rewrite the global `OPERATION_IMPLEMENTED_BY_HANDLER` ambiguity.
- CAP DB entity extraction for local `cds.run(...)` calls uses TypeScript AST traversal across chained query expressions, including `SELECT.from(Entity)`, `SELECT.one.from(Entity)`, `SELECT.one(Entity)`, `INSERT.into(Entity)`, `UPSERT.into(Entity)`, `UPDATE(Entity)`, `UPDATE.entity(Entity)`, `DELETE.from(Entity)`, and static element access such as `this.model['Books']`. Dynamic or unknowable query targets remain terminal graph edges with parser-warning evidence such as `dynamic_entity_expression`.
- Fresh relinks persist unknown DB query targets semantically as `to_kind = db_entity` and `to_id = unknown`; no schema migration is required for this row-level graph change. JSON, table, and Mermaid output use `Entity: unknown`, while evidence keeps the source `callId` and parser warning for machines.
- Symbol-call indexing is opt-in. Same-file symbols, indexed `this.method()` calls, exact relative import/export matches, and exported object-literal helper methods are kept; CAP DSL, request helpers, package namespace/CommonJS calls, global runtime APIs, and generic transport helpers are filtered unless local indexed evidence makes the edge actionable.
- `doctor --strict` reports compact parser-quality aggregates for symbol calls and local DB query known/unknown ratios; default doctor stays focused on actionable warnings.
- Generated constants remain low-level parser output through `parseGeneratedConstants`. They are not persisted as graph facts; implementation linking only uses deterministic decorator normalization for common generated action/function names.

## 0.1.4 trace-correctness additions

- Helper exports are normalized through a public-to-local export map, so `export { helper }` and `export { helper as publicHelper }` both resolve to the local declaration that contains the `cds.connect.to(...)` call.
- Two-argument CAP connections keep alias expressions distinct from `credentials.destination` and `credentials.path` / `credentials.servicePath`; dynamic placeholders from all three fields are retained for later `--var` substitution.
- Repository discovery validates `.git` markers using `HEAD`, `config`, or gitfile `gitdir:` content and keeps scanning children so outer workspaces can contain many nested repositories.
- Fresh SQLite stores now declare core parent/child foreign keys with cascading cleanup for repository-owned facts.

## 0.1.5 hardening additions

- Runtime variables are applied to alias, destination, service path, and operation path evidence. Trace/graph then perform an effective in-memory resolution requiring both operation-path compatibility and an exact service-path signal.
- Edge evidence and target operation provenance are separate: call file/line and helper chains stay on the edge, while operation nodes are loaded from CDS operation/service/repository rows.
- The linker stores explicit edge status categories and summary counts. Valid DB, event, and external terminals keep `unresolved_reason` null.
- Repository-level fingerprints include source paths/hashes, package dependencies, and analyzer schema version. Unchanged repositories are skipped unless `--force` is used.


## 0.1.8 implementation resolver model

- Facts: indexing records CDS operations, decorated handler classes/methods, package dependencies, service bindings, outbound calls, and class-level handler registration facts. Registration facts include class name, import source where known, registration file, registration line, kind, and confidence.
- Dependency evidence: helper-package linking creates repository dependency edges from package metadata. Implementation linking treats same-repository registration/handler evidence as strong without requiring a self-dependency edge, and treats registration-package or handler-package dependencies on the model package as strong cross-package evidence.
- Registration evidence: the registration parser uses the TypeScript AST for `createCombinedHandler({ handler: ... })` and resolves direct arrays, identifier arrays, spreads, imported aggregate arrays, default exports, named exports, aliases, and safe relative re-exports. Decorator-only matches are not resolved as strong implementation edges.
- Implementation edges: an operation-to-handler edge requires an exact operation path/name or method-name match plus registration evidence. One strong candidate becomes a resolved `OPERATION_IMPLEMENTED_BY_HANDLER` edge; multiple strong candidates become an ambiguous edge with candidate evidence.
- Trace traversal: trace follows remote-call graph edges to operations, applies runtime `--var` substitutions only to eligible dynamic/ambiguous/unresolved remote edges, and then prefers persisted implementation edges to enqueue the registered handler scope. Depth limits and visited-scope keys continue to bound recursion and report cycles.

## 0.1.8 operational notes

- The known Node 24 `node:sqlite` experimental warning is filtered before loading the database driver for normal service-flow database commands. This filter targets only that runtime warning and does not convert application errors into success.
- Repository indexing protects discovery, reads, hashing, parsing, and publication in one repository-level failure boundary. Failed attempts keep last-good facts and fingerprints and produce `source_read_failed` diagnostics visible in doctor.
- Doctor reports `index_run_abandoned` only for running rows older than 60 minutes, including run id and start time.
- Fresh schema version 3 stores define foreign keys for `graph_edges`, `index_runs`, and `diagnostics`. If a migrated legacy store is structurally weaker, doctor reports `legacy_schema_weaker_foreign_keys` rather than implying parity.

## 0.1.8 correctness additions

- Runtime resolution now has an explicit eligibility gate: only remote dynamic/ambiguous/unresolved graph edges with affected placeholders are re-resolved in memory. Terminal and resolved static edges are copied through unchanged, and substitutions keep original expressions, effective values, supplied variables, and missing variables separate.
- Operation candidate scores are clamped into `[0, 1]` before graph or trace rendering.
- Helper package linking uses exact `repositories.package_name` matches before normalized directory-name fallback. Ambiguous package names are represented as ambiguous graph edges with bounded candidate projections and count metadata.
- Fingerprints hash normalized package facts and package bytes in addition to source file paths/content and analyzer version.
- The CLI version imports package metadata, so package metadata, `service-flow --version`, changelog, and analyzer/fingerprint version share one release source.
- Supported runtime is Node.js 24+ with `node:sqlite` validation; older runtimes should fail with a compatibility message instead of a late `DatabaseSync` error.


### 0.1.17 parser ownership policy

Outbound call extraction is AST-based and ignores comments, block comments, and string literals. CAP/service `.on(...)` registrations are indexed only when the receiver has CAP/service evidence, and top-level registrations receive `module:<relative-file>#event:<event-name>:<line>` synthetic owners. Generic event emitters such as desktop or window events are ignored by default rather than guessed as CAP async edges. Unsupported source shapes are surfaced through diagnostics and strict doctor ownerless categories instead of guessed graph edges.


## 0.1.35 OData placeholder semantics

Service-flow now records OData placeholders by semantic layer. Service-routing placeholders belong to service bindings and can make an operation edge dynamic until runtime variables are supplied. Operation invocation argument placeholders, such as action/function call arguments, remain operation evidence but are not service-routing variables. Entity key placeholders belong to entity addressing, so key, navigation, and media/property paths remain terminal remote entity/query edges unless indexed CDS operation evidence provides a credible operation match.
## 0.1.40 analyzer hardening

Expression resolution is consumer-specific: operation paths may retain template placeholders for OData normalization, while external URL and destination classifiers require literal or no-substitution-template evidence before a static target is persisted. Identifier resolution is bounded to the call-site lexical scope and ignores sibling scopes, later declarations, nested function bodies, and mutable or computed writes unless they are recorded as conservative candidate evidence.
