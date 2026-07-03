# Implementation plan

## Scope
Implement `@saptools/service-flow` 0.1.15 as a focused patch-release quality pass after the 0.1.14 audit. Preserve the 0.1.14 opt-in symbol-call policy while fixing symbol-call evidence persistence, conservative exported class/object-map traversal, strict doctor parser-quality diagnostics, and release metadata.

## Intended files and reasons
- `package.json`, root lock metadata, `src/version.ts`, `README.md`, `CHANGELOG.md`, and `TECHNICAL-NOTE.md`: bump/document 0.1.15 and the evidence/traversal fixes.
- `src/db/repositories.ts`: correct `insertSymbolCalls()` binding order so `evidence_json` stores object JSON with an explicit initial status.
- `src/parsers/symbol-parser.ts` and `src/types.ts`: index exported static class members and exported shorthand object-map aliases with conservative evidence; add variable-flow evidence for statically proven factory/proxy calls if feasible with existing facts.
- `src/linker/cross-repo-linker.ts`, `src/linker/service-resolver.ts`, and trace/output code as needed: resolve the new conservative facts without broad fallback and improve same-repository service-call evidence.
- `src/cli.ts` and doctor helpers: add strict diagnostics for non-object symbol-call evidence, unresolved/unknown ratios, and outbound calls missing source-symbol ownership.
- `src/db/schema.ts` and `src/db/migrations.ts`: inspect whether schema changes are required; prefer existing `symbols`/`symbol_calls` if sufficient.
- Existing unit/e2e tests plus focused fixtures: add regressions for evidence JSON, exported static class calls, object shorthand aliases, factory/proxy trace traversal, terminal transport calls, DB query semantics, and strict doctor diagnostics.

## Verification plan
- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run test:e2e`
- Built CLI fixture verification: `service-flow init`, `index`, `link`, `trace --format json`, `doctor --strict`.
- SQLite direct checks for object `symbol_calls.evidence_json`, status/group counts, graph-edge counts, and semantic unknown DB targets.
