# Implementation plan

## Scope
Implement `@saptools/service-flow` 0.1.13 as a focused audit follow-up for local CAP service calls, chained CAP query parsing, symbol-call noise, output labels, doctor visibility, and docs.

## Intended files and reasons
- `package.json` and root lock metadata: bump `@saptools/service-flow` to `0.1.13`.
- `src/parsers/outbound-call-parser.ts`: replace string-only CAP query entity extraction with TypeScript AST query traversal for chained `cds.run(...)` forms while keeping warnings for dynamic queries.
- `src/parsers/symbol-parser.ts`: filter noisy built-in/property calls unless local symbol/import evidence proves they are actionable.
- `src/linker/service-resolver.ts` and `src/linker/cross-repo-linker.ts`: keep same-repository local service resolution first, then add implementation-context fallback with explicit evidence and unresolved ownership reasons.
- `src/trace/trace-engine.ts`: use local-call implementation-context evidence to trace from model operations into the caller repository's handler when global implementation edges are ambiguous.
- `src/output/table-output.ts` and `src/output/mermaid-output.ts`: show `Entity: unknown`/safe labels for unknown DB query targets and preserve parser-warning semantics.
- `src/cli.ts` or doctor helpers: surface aggregate local-service resolution statuses without failing explainably unresolved cases.
- `tests/unit/*` and `tests/e2e/*`: add neutral regression coverage for CAP query parsing, symbol-call filtering, output labels, and local service model-package fallback.
- `README.md`, `CHANGELOG.md`, and `TECHNICAL-NOTE.md`: document 0.1.13 behavior, generated-constant limitations, parser-warning output, and implementation-context local service resolution.

## Verification plan
- `pnpm --filter @saptools/service-flow lint`
- `pnpm --filter @saptools/service-flow typecheck`
- `pnpm --filter @saptools/service-flow test:unit`
- `pnpm --filter @saptools/service-flow test:e2e`
- `pnpm --filter @saptools/service-flow build`
- `cd packages/service-flow && npm pack --dry-run`
- Run the neutral fixture flow with init, index, link, trace, doctor, and strict doctor.
