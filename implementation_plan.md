# Service Flow Accuracy/Stability Implementation Plan

## Intended files
- `packages/service-flow/src/db/*`: harden SQLite shell adapter with busy timeout, retries, output handling, and schema adjustments if needed.
- `packages/service-flow/src/parsers/*`: improve CDS extraction, TypeScript AST service bindings, outbound/database calls, generated constants integration.
- `packages/service-flow/src/linker/*`: make remote resolution use scoped bindings, service metadata, decorator/operation evidence, and dynamic candidates.
- `packages/service-flow/src/trace/*` and `packages/service-flow/src/output/*`: traverse linked graph edges recursively and populate typed nodes for JSON/Mermaid/table output.
- `packages/service-flow/src/cli.ts`: make force/filter/inspect options meaningful where scoped.
- `packages/service-flow/tests/*`: add focused parser/linker/trace/doctor/database coverage and fixtures.
- `packages/service-flow/README.md` and `packages/service-flow/CHANGELOG.md`: document changed behavior and troubleshooting.

## Verification steps
- Run focused unit/e2e tests for `@saptools/service-flow`.
- Run lint, typecheck, build, and pack dry-run when feasible.
- Exercise the CLI against the included fake CAP workspace fixture.

## Scope note
The request is broad; implement the highest-impact source fixes in this package without editing globally installed packages or unrelated packages.
