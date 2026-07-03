# Implementation plan

## Scope
Produce `@saptools/service-flow` 0.1.8 with neutral fixtures only. Preserve the 0.1.7 fixes while improving handler registration evidence, implementation edge linking, trace continuation through runtime-resolved operations, read/fingerprint failure diagnostics, schema-v3 migration integrity, warning-free supported-runtime CLI output, and active index-run doctor policy.

## Files to review before edits
- `src/parsers/handler-registration-parser.ts` for current registration extraction.
- `src/db/repositories.ts`, `src/db/schema.ts`, and `src/db/migrations.ts` for persistence and schema behavior.
- `src/linker/cross-repo-linker.ts` and `src/linker/helper-package-linker.ts` for implementation and dependency edge construction.
- `src/trace/trace-engine.ts` for implementation-scope traversal after static and runtime resolution.
- `src/indexer/repository-indexer.ts` and `src/cli.ts` for protected indexing and warning suppression.
- Existing unit/e2e fixtures to extend with neutral service and handler names.

## Intended changes
1. Replace regex-only handler registration parsing with TypeScript AST registration evidence for direct arrays, identifier arrays, spreads, relative imports, default/named exports, and safe relative re-exports.
2. Persist class-level registration facts with source/import evidence and link unique same-repository classes; preserve ambiguous evidence instead of silently dropping candidates.
3. Relax and score implementation edge linking so same-repository registrations, handler-owned registrations, and application registrations can produce resolved or ambiguous `OPERATION_IMPLEMENTED_BY_HANDLER` graph edges.
4. Ensure trace implementation scope consumes persisted implementation edges for both static and runtime-resolved operation scopes while retaining fallback matching and depth/cycle safeguards.
5. Move read/fingerprint failures into repository-level protected indexing so last-good facts/fingerprints are preserved and actionable diagnostics/statuses appear in doctor.
6. Strengthen or diagnose schema-v3 migration constraints for `graph_edges`, `index_runs`, and `diagnostics`; validate with `PRAGMA foreign_key_check`.
7. Suppress the `node:sqlite` experimental warning before database loading without hiding real application errors, and add packed CLI stderr assertions.
8. Update abandoned index-run policy to use a documented age threshold with run id/start time.
9. Bump version metadata to 0.1.8 and update README, technical note, changelog, and lock metadata.

## Verification plan
- Run focused unit tests for parser, linker, trace, migration, doctor, and snapshot behavior.
- Run e2e tests for packed CLI and neutral multi-repository trace fixtures where supported by the local Node runtime.
- Run `pnpm --filter @saptools/service-flow typecheck`, `lint`, `test:unit`, `test:e2e`, `build`, and package dry-run/smoke checks.
