# Implementation plan: service-flow 0.1.34 hardening

## Files and schema objects to change

- `packages/service-flow/src/linker/odata-path-normalizer.ts`
  - Expose normalized top-level operation invocation evidence independently from entity intent.
  - Stop treating parenthesized operation segments and uppercase first segments as strong entity evidence by themselves.
  - Verify with unit tests for `/refreshCache()`, `/SyncCatalog`, `/submitDocument(documentId='123')`, and true entity/media/delete paths.

- `packages/service-flow/src/linker/cross-repo-linker.ts`
  - Make operation-vs-entity precedence explicit during linking.
  - For persisted `remote_entity_*` facts, consult indexed operation candidates before inserting terminal entity edges.
  - Preserve parser, call-site, outbound, normalized operation, selected target, and linker evidence in every branch.
  - Emit ambiguous/unresolved operation edges rather than terminal entity edges when operation evidence exists without a strong entity selection.
  - Verify through link/trace tests and graph edge assertions.

- `packages/service-flow/src/linker/service-resolver.ts`
  - Reuse existing operation path/name matching to ensure normalized invocation paths and bare operation names resolve consistently.
  - Verify by tracing operation, handler, and service/path selectors against the same unique operation.

- `packages/service-flow/src/db/schema.ts`, `packages/service-flow/src/db/migrations.ts`, `packages/service-flow/src/db/repositories.ts`
  - Add `repositories.fact_analyzer_version` to persist the analyzer version that produced repository facts.
  - Bump schema version and initialize legacy rows as `legacy`/unknown through migration defaulting.
  - Write the current analyzer version on successful index publication.
  - Verify migration compatibility, SQLite `integrity_check`, and `foreign_key_check`.

- `packages/service-flow/src/cli.ts`
  - Warn during `link` when repository facts were produced by an older/unknown analyzer.
  - Add strict doctor diagnostics: `strict_remote_entity_operation_collision_quality` and `reindex_required_after_analyzer_upgrade`.
  - Preserve default doctor behavior except documented quietness for strict-only quality checks.
  - Verify with CLI e2e/unit tests.

- `packages/service-flow/tests/unit/odata-path-normalizer.test.ts`, `packages/service-flow/tests/unit/odata-path-classifier.test.ts`, `packages/service-flow/tests/unit/link-trace.test.ts`, and/or `packages/service-flow/tests/e2e/cli.e2e.test.ts`
  - Add neutral operation/entity precedence, strict doctor collision, analyzer-version warning, and migration-style tests.
  - Verify every outbound call owns one graph edge and JSON/table/Mermaid evidence stays consistent.

- `packages/service-flow/package.json`, `packages/service-flow/CHANGELOG.md`, generated `packages/service-flow/dist/**`, root `pnpm-lock.yaml`
  - Bump the package from 0.1.33 to 0.1.34 and document operation/entity precedence, strict doctor guard, and analyzer-version reindex warning.
  - Verify build, node checks, ESM import, and dry-run pack.

## End-to-end fact trace to verify

1. TypeScript AST extraction keeps service-client sends as outbound facts with call-site and parser evidence.
2. CDS extraction indexes service operation facts used by operation resolution.
3. Persistence stores outbound facts and repository analyzer version.
4. Linking prefers indexed operation evidence over heuristic terminal entity classification unless strong entity evidence applies.
5. Trace traversal follows `REMOTE_CALL_RESOLVES_TO_OPERATION` into implementation handlers.
6. Doctor strict mode reports collision and analyzer-version remediation diagnostics.
7. JSON/table/Mermaid output agree on effective edge type while preserving call-site evidence.
