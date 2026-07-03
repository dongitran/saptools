# Implementation plan

## Scope
Prepare `@saptools/service-flow` 0.1.11 with a focused static-analysis patch for symbol-scoped traces, local CAP service calls, repository-scoped starts, deduplicated implementation evidence, diagnostics, and documentation/version consistency.

## Intended files and reasons
- `src/db/schema.ts`, `src/db/migrations.ts`, `src/db/repositories.ts`: add executable symbol and local symbol-call persistence and wire source-symbol ids into calls.
- `src/parsers/outbound-call-parser.ts` plus new parser helpers: use TypeScript AST ownership and local-service alias extraction instead of broad regular expressions.
- `src/indexer/repository-indexer.ts`: pass file ids and insert executable symbols/symbol calls before outbound calls.
- `src/linker/cross-repo-linker.ts`, `src/linker/service-resolver.ts`: resolve local service calls with exact repository/service evidence and deduplicate implementation candidates.
- `src/trace/trace-engine.ts`, `src/output/table-output.ts`: queue repository+symbol identities, follow local helper edges, preserve handler repository identity, normalize implementation evidence, and keep depth/step semantics coherent.
- `src/cli.ts`: print implementation-unresolved link summary and add aggregate doctor diagnostics.
- `README.md`, `CHANGELOG.md`, `package.json`, lock metadata, tests: document and verify 0.1.11 behavior with neutral fixtures.

## Verification plan
- Run package build, typecheck, lint, unit tests, and e2e tests.
- Run requested source-quality `rg` checks.
- Pack/install the package where feasible and run fresh-cycle smoke commands against neutral fixtures.
- Check SQLite foreign-key/integrity invariants on generated fixture databases.
