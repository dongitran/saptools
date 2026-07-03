# @saptools/service-flow 0.1.5 hardening implementation plan

## Source trace baseline
- Read source, tests, README, changelog, technical note, tsup/tsconfig/vitest config, package metadata, and CLI workflow.
- Existing baseline: `pnpm --filter @saptools/service-flow test:unit` passed 13 tests.
- End-to-end flow traced as discovery (`discover-repositories`) -> indexing (`workspace-indexer`, `repository-indexer`) -> persistence (`db/*`) -> linking (`cross-repo-linker`, `service-resolver`) -> runtime variables (`dynamic-edge-resolver`) -> traversal (`trace-engine`) -> rendering (`output/*`).

## Implementation steps
1. Replace the SQLite CLI-per-statement adapter with a persistent SQLite driver connection, bound parameters, transactions, read-only mode, WAL, busy timeout, and foreign-key enforcement.
2. Introduce schema user-version migrations with safe additive/backfill behavior for edge status and missing foreign keys where possible; keep creation idempotent.
3. Add explicit graph edge status semantics (`resolved`, `terminal`, `dynamic`, `ambiguous`, `unresolved`) and update link summaries/counts.
4. Preserve operation candidate identity in linker evidence and re-resolve dynamic edges at trace/graph read time using substituted alias, destination, service path, and operation path.
5. Create typed operation nodes from target CDS operation provenance rather than spreading call evidence into operation nodes.
6. Apply the same `--var` parser/resolution behavior to `graph` and `trace`.
7. Enforce service-aware trace selectors so `--service` narrows operation/handler matching and nonexistent services do not broaden the trace.
8. Implement repository-level incremental indexing fingerprints and meaningful `--force` behavior.
9. Make doctor lower-noise and actionable, including foreign-key checks and run status checks.
10. Bump package version to 0.1.5 and update docs, technical note, changelog, lockfile, and generated package metadata.

## Verification steps
- Run focused unit tests for parser/link/trace/runtime resolver/migration/incremental behavior.
- Run package typecheck, lint, unit, e2e, build, and npm pack dry-run.
- Install packed tarball in a temporary prefix and run neutral fixture CLI smoke commands, including repeated index, forced index, link, trace/graph with variables, and doctor.
