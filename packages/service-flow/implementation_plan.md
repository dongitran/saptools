# Implementation plan

## Scope
Improve `@saptools/service-flow` correctness for the post-0.1.5 patch while preserving existing graph/link/trace behavior and synthetic fixtures.

## Steps
1. Baseline: run package typecheck, lint, unit, e2e, build, and dry-run pack; record failures here.
2. Runtime variables: add typed placeholder substitution metadata, eligibility predicate, confidence clamping, and trace-only effective target resolution without mutating persisted graph.
3. Dependency linking: resolve dependencies by exact `package_name`, preserve ambiguous candidates, set explicit edge statuses, and report helper counts in link summaries.
4. Selector safety: ensure repository/service/operation selectors never broaden to workspace-wide results and emit typed diagnostics.
5. Fingerprinting: hash normalized package facts (including package name/version, dependencies/devDependencies, scripts, and full `cds`) plus source content and options/version.
6. Index atomicity/freshness: parse before publish where feasible, keep publication transactional, mark graph stale on fact changes, and expose stale diagnostics.
7. Migration/runtime/version docs: bump version to 0.1.6, source CLI version from package metadata, document Node/SQLite/runtime/selector/freshness behavior.
8. Tests: add unit/e2e coverage for runtime eligibility, dependency package-name matching, selector narrowing, fingerprint metadata, and version consistency.
9. Verification: rerun package checks and commit changes.

## Baseline
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run test:unit`: passed (13 tests).
- `npm run test:e2e`: failed before implementation because `dist/cli.js` was missing; rerun after build is required.
