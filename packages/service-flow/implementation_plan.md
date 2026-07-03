# Implementation plan

## Scope
Prepare `@saptools/service-flow` 0.1.10 after the implementation-coverage audit. Keep the package generic for SAP CAP/CDS TypeScript workspaces and preserve 0.1.9 safety constraints around exact service-path evidence, duplicate operation names, type-stable SQLite ids, and non-mutating runtime variables.

## Files to review before edits
- `src/linker/cross-repo-linker.ts` for implementation candidate policy, evidence, statuses, and link summaries.
- `src/trace/trace-engine.ts` plus `src/output/*` for operation-to-handler trace rendering in JSON, table, and Mermaid output.
- `src/doctor/*` or CLI doctor paths for implementation coverage diagnostics.
- `src/db/connection.ts` and version metadata for Node compatibility messages.
- Existing `tests/unit/**` fixtures/helpers to add neutral model/helper/duplicate/runtime regressions.
- `README.md`, `CHANGELOG.md`, `package.json`, and lock metadata for release docs/version updates.

## Intended changes
1. Persist unresolved `OPERATION_IMPLEMENTED_BY_HANDLER` evidence when candidates exist but policy rejects all of them.
2. Add a conservative helper-owned implementation acceptance path for unique registered helper handlers on model-oriented operations, while keeping multiple helpers ambiguous and local service-path contradictions rejected.
3. Render implementation hops and terminal handler nodes in trace JSON, table, and Mermaid output, including ambiguous/unresolved explanatory edges when traversal stops.
4. Ensure runtime-resolved operation targets reuse the persisted implementation edge lookup without mutating graph facts.
5. Add doctor diagnostics for rejected implementation candidates and remote target operations lacking implementation coverage.
6. Bump package metadata to 0.1.10, fix stale version strings, and update README/changelog wording.

## Verification plan
- Run focused unit tests for implementation linking, trace rendering, doctor diagnostics, runtime variables, and Node compatibility messaging.
- Run `npm run build`, `npm run typecheck`, `npm run lint`, and `npm run test` in `packages/service-flow`.
- Inspect git diff for neutral sample names only and no credential-like fixture data.
