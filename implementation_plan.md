# @saptools/service-flow 0.1.33 hardening implementation plan

## Files and schema objects to change

- `packages/service-flow/src/trace/trace-engine.ts`: enforce persisted graph edge precedence during trace traversal, merge contextual/runtime evidence without replacing resolved persisted rows, stamp call-edge evidence with graph edge id, outbound call id, call site, linker status/reason, persisted target, and contextual participation; keep terminal trace-start diagnostics at zero nodes/edges.
- `packages/service-flow/src/parsers/outbound-call-parser.ts`: make OData entity path classification conservative for service-client `send` calls and make external destination expression evaluation safe (static literals/const literals only, bounded dynamic candidates for static conditional branches, otherwise dynamic sanitized expression shape).
- `packages/service-flow/src/linker/cross-repo-linker.ts`: persist terminal remote entity graph edges for OData entity read/mutation/delete/media/candidate calls and keep real action/function resolution intact.
- `packages/service-flow/src/linker/external-http-target.ts`: render dynamic destination targets using stable synthetic ids and neutral labels; never use identifier names as static destination labels; sanitize URL evidence.
- `packages/service-flow/src/types.ts`: extend call/edge taxonomy for remote entity classifications without breaking existing public shapes.
- `packages/service-flow/src/db/migrations.ts`: bump SQLite `user_version` and use the explicit reindex-required policy for legacy drift/missing external metadata.
- `packages/service-flow/src/cli.ts`: add strict doctor diagnostics for schema drift, missing external metadata, call-site evidence loss, contextual override risks, OData entity misclassification, fake static destinations, terminal trace-start contract, and target taxonomy mismatches; warn link users when relink cannot fully clean upgraded schema drift.
- `packages/service-flow/src/output/*.ts`: ensure table, JSON graph, and Mermaid graph use effective trace-edge semantics and prefer call-site location for call edges.
- `packages/service-flow/tests/unit/*.test.ts` and `tests/e2e/cli.e2e.test.ts`: add neutral regression tests for persisted evidence preservation, dynamic routing, OData entity terminal edges, dynamic destination sanitization, migration/doctor policy, terminal start contract, public ESM exports, pack dry-run, and SQLite checks.
- `packages/service-flow/package.json`, root `pnpm-lock.yaml`, `packages/service-flow/CHANGELOG.md`, `README.md`, `TECHNICAL-NOTE.md`, and generated `dist/**`: bump to 0.1.33 and document user-visible behavior.

## Schema policy

Use option B (explicit reindex-required policy). Bump `user_version` to 7, detect legacy external-target columns on `symbols` and missing queryable external metadata on `outbound_calls`, and surface `doctor --strict` diagnostics plus link warnings/remediation. Fresh databases keep the current clean table layout with external target columns only on `outbound_calls`.

## Verification criteria

- Trace and graph outputs retain persisted graph edge ids, outbound call ids, call-site file/line, parser/outbound/linker/target evidence, and contextual participation without replacing resolved persisted targets.
- Remote OData entity reads, mutations, deletes, navigation, media, and uppercase candidates are terminal remote entity edges, not unresolved operation candidates; real `/submitOrder` and `/calculatePrice` operations still resolve.
- Static destinations resolve only from safe literals/local const literals; conditionals become bounded dynamic candidates; identifiers/property reads/function calls are dynamic with stable synthetic ids and sanitized evidence.
- `doctor --strict` reports actionable diagnostics for upgrade drift and quality regressions; reindex path produces queryable external metadata.
- Terminal trace-start diagnostics return zero nodes and zero edges by default, with candidates/evidence in diagnostics only.
- `pnpm --filter @saptools/service-flow build`, typecheck, lint, unit/e2e tests, generated JS `node --check`, public ESM import smoke test, `npm pack --dry-run --json`, and SQLite integrity/foreign-key checks pass or are documented with environment limitations.
