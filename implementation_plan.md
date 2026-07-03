# service-flow 0.1.16 implementation plan

## Intended files
- `packages/service-flow/package.json`, lock metadata if needed: bump @saptools/service-flow to 0.1.16.
- `packages/service-flow/src/parsers/symbol-parser.ts`: add class property function symbols and conservative outbound-owning callback symbols; enrich proxy call evidence where parser-local facts are available.
- `packages/service-flow/src/db/repositories.ts`: prefer explicit `sourceSymbolQualifiedName` when assigning outbound source symbols and harden proxy member resolution away from global name-only matches.
- `packages/service-flow/src/linker/cross-repo-linker.ts`, `packages/service-flow/src/cli.ts`: split link summary labels for remote/local/terminal/dynamic counts and add strict doctor ownership details.
- `packages/service-flow/tests/unit/*`, `packages/service-flow/tests/e2e/*`: add focused regression coverage for ownership, proxy resolution, doctor detail, CLI wording, and API/persistence alignment.
- `packages/service-flow/CHANGELOG.md`, `TECHNICAL-NOTE.md`, `README.md`: document 0.1.16 behavior and limitations.

## Reasons
- Reduce ownerless outbound calls by indexing precise class-property and targeted callback scopes.
- Prevent proxy-member edges from resolving solely by repository-wide member-name collisions.
- Make CLI link output accurately distinguish remote and local operation resolutions.
- Keep public `OutboundCallFact.sourceSymbolQualifiedName` consistent with persistence.

## Verification steps
- Read requested service-flow source and test files before edits.
- Run focused unit/e2e tests plus typecheck, lint, build.
- Pack/install or pack-smoke the local artifact.
- Where a full external multi-repo CAP workspace is unavailable, run the closest deterministic fixture audit and SQLite integrity/user_version/quality queries, and report the limitation.
