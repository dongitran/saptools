# Implementation plan

## Scope
Prepare `@saptools/service-flow` 0.1.12 as a focused correctness and trace-quality patch for CAP/CDS TypeScript static analysis.

## Intended files and reasons
- `src/parsers/symbol-parser.ts`: make symbol-call collection conservative, mark export-list symbols, index object-literal helper methods, and preserve readable symbol evidence.
- `src/parsers/outbound-call-parser.ts`: preserve local CAP service alias-chain evidence and rely on object-literal symbols for source ownership.
- `src/db/repositories.ts`: clear stale unresolved reasons for resolved symbol calls and support exported-name/object-helper symbol resolution.
- `src/linker/service-resolver.ts`, `src/linker/cross-repo-linker.ts`: resolve same-repository local CAP service calls by qualified/simple/path identity, make implementation matching decorator-aware, and deduplicate method candidates by method identity with nested registration evidence.
- `src/trace/trace-engine.ts`, `src/output/table-output.ts`, `src/output/mermaid-output.ts`: add first-class symbol nodes, readable labels/locations, suppress false symbol unresolved reasons, and traverse local service calls into implementation handlers.
- `src/cli.ts`: keep doctor diagnostics actionable while avoiding default failures for explainable top-level calls.
- Tests/fixtures under `packages/service-flow/tests`: add unit and fake-workspace regression coverage for local service resolution, symbol calls, export-list helpers, object-literal helpers, implementation collision handling, doctor behavior, and trace output.
- `README.md`, `CHANGELOG.md`, `package.json`, lock metadata/version source: document the 0.1.12 behavior and bump the patch version.

## Verification plan
- Run package build, typecheck, lint, unit tests, and fake e2e tests using existing package scripts.
- Run focused CLI fake-workspace flow: init, index --force, link --force, trace --handler FacadeEntryHandler --include-db --format json.
- Confirm no private/customer-specific names were introduced.
