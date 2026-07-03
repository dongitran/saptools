# Implementation plan

## Scope
Prepare `@saptools/service-flow` 0.1.9 by fixing implementation-edge linking after the 0.1.8 audit. Keep the public CLI unchanged while making graph-id comparisons deterministic, improving implementation candidate scoring/evidence, and adding neutral regression coverage.

## Files to review before edits
- `src/linker/cross-repo-linker.ts` for implementation candidate SQL, graph-id binds, scoring, and evidence.
- `src/linker/helper-package-linker.ts` and other `src/**` SQL call sites for graph-edge id comparison patterns.
- `src/trace/trace-engine.ts` to confirm resolved implementation edges remain traceable.
- Existing `tests/**` integration helpers and fixtures to add neutral cross-package and duplicate-service regressions.
- `package.json`, lock metadata, and `CHANGELOG.md` for the 0.1.9 release update.

## Intended changes
1. Add a small graph-id normalization helper for SQL comparisons against `graph_edges.from_id`/`to_id` and remove numeric `CAST(? AS TEXT)` binds from implementation candidate dependency checks.
2. Expand implementation candidate rows with model/application/handler package context, import/dependency evidence, local service-path evidence, and accepted/rejected ranking reasons.
3. Score candidates using direct ownership, exact local service-path matches, and validated cross-package dependency/import relationships; keep true ties ambiguous.
4. Add neutral integration tests for cross-package app/model/handler linking, duplicate same-name service operations, and graph-id string binding behavior.
5. Update changelog/version metadata to 0.1.9 and run package test/build/pack checks.

## Verification plan
- Run focused `service-flow` tests for the new regression coverage and existing implementation linking/trace suites.
- Run `npm test`, `npm run build`, and `npm pack --dry-run` in `packages/service-flow`.
- Inspect `rg` results for remaining unsafe `CAST(? AS TEXT)` graph-id comparisons.
