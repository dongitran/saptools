# Implementation plan

## Scope
Finish the `@saptools/service-flow` 0.1.7 patch focused on cross-package implementation tracing, atomic repository publication, graph freshness indicators, selector safety, dependency summaries, parser warning evidence, documentation, and release metadata. All fixtures and examples use neutral generated repository names.

## Baseline completed before edits
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run test:unit`: passed (15 tests).
- `npm run build`: passed.
- `npm run test:e2e`: passed (1 test).
- `npm pack --dry-run`: passed for 0.1.6 with 12 files.

## Current data-flow trace
1. Parsers emit CDS services/operations, decorated handler classes/methods, handler registrations, service bindings, outbound calls, and package facts.
2. `indexWorkspace()` creates an index run and calls `indexRepository()` for each selected repository.
3. `indexRepository()` discovers source files, computes package/source fingerprints, parses files, and publishes facts to SQLite.
4. Dependency graph edges are emitted from package dependencies by `linkHelperPackages()`.
5. Remote call graph edges are emitted by `linkWorkspace()` via `resolveOperation()`.
6. `trace()` scopes calls from CLI selectors, follows call graph edges to operation nodes, then looks up decorated handlers for downstream traversal.

## Implementation steps
1. Release metadata: bump package metadata and docs from 0.1.6 to 0.1.7, then rebuild declarations/source maps and refresh lockfile metadata if needed.
2. Schema/migration compatibility: add generation/freshness columns and registration evidence columns using idempotent migrations, reject future schema versions, and retain foreign-key checks.
3. Atomic repository publication: parse all package/source facts before clearing published facts; publish inside one transaction; on parse/persistence failure keep the previous snapshot and fingerprint, record failed diagnostics/index status, and avoid stale graph changes.
4. Graph freshness: increment fact generation after successful publication, mark existing graph stale, record link generation on successful rebuild, expose stale/abandoned diagnostics through trace/graph/doctor, and clear stale only after relink.
5. Handler registration evidence: persist parsed class names, resolve unique local registrations, and add cross-package implementation edges using application model dependency + handler registration dependency evidence.
6. Trace traversal: consume `OPERATION_IMPLEMENTED_BY_HANDLER` graph edges before local decorator fallback, traverse unique handler files in other repositories, and render ambiguous implementation candidates without automatic traversal.
7. Selector safety: count `servicePath` as a selector and choose the documented service-only policy of returning a typed diagnostic requiring `--operation` or `--path`.
8. Dependency summaries: return dependency resolved/ambiguous counts, use match strategies independent of uniqueness, and ensure link output categories reconcile to persisted edge totals.
9. Parser completeness: preserve terminal DB parse warnings in graph evidence and doctor aggregation without changing terminal routing status.
10. Tests/fixtures: add neutral multi-repository fixtures and unit/e2e coverage for cross-package implementation, atomic snapshot failure, graph freshness, service-only selector behavior, dependency summaries, and parser warning evidence.
11. Verification: rerun `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:e2e`, `npm run build`, `npm pack --dry-run`, and targeted packed CLI smoke checks where the available Node runtime supports the package.
