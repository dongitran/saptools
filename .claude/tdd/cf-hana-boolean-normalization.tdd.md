# TDD Evidence: cf-hana Boolean Normalization

## Source Plan

- Plan artifact: `packages/cf-hana/implementation_plan.md`
- User journey: as a `cf-hana` user querying SAP HANA `BOOLEAN` columns, I want
  returned values to be booleans instead of `1`/`0`, so CLI output, API rows,
  saved refs, and backups represent the data type correctly.

## Task Report

| Behavior | RED Evidence | GREEN Evidence | Guarantee |
| --- | --- | --- | --- |
| HANA `BOOLEAN` result cells returned as numeric or textual `1`/`0` become JavaScript booleans while non-boolean numeric cells stay numeric. | `pnpm --filter @saptools/cf-hana exec vitest run tests/unit/connection.test.ts` failed with `ACTIVE: 1` and `DELETED: 0` returned unchanged. | Same focused command passed after normalizing rows by `QueryResultColumn.typeName`. | Boolean conversion happens before `QueryResult` leaves `Connection.query()`. |

## Verification

| # | What is guaranteed | Test file or command | Type | Result |
| --- | --- | --- | --- | --- |
| 1 | `BOOLEAN` metadata converts `1`/`0` and `"1"`/`"0"` to `true`/`false`. | `tests/unit/connection.test.ts` | Unit | PASS |
| 2 | Strict TypeScript remains valid. | `pnpm --filter @saptools/cf-hana typecheck` | Static | PASS |
| 3 | ESLint package rules remain valid. | `pnpm --filter @saptools/cf-hana lint` | Static | PASS |
| 4 | Package unit suite and coverage thresholds pass. | `pnpm --filter @saptools/cf-hana test:unit` | Unit/coverage | PASS, 248 tests, 85.84% statements |
| 5 | Built CLI still passes fake-backed user flows and version output. | `pnpm --filter @saptools/cf-hana build` and `pnpm --filter @saptools/cf-hana test:e2e:fake` | Build/E2E | PASS, 38 tests |

## Known Gaps

- Live HANA E2E was not run because it requires `SAP_EMAIL`, `SAP_PASSWORD`,
  and `CF_HANA_E2E_TARGET`. The unit reproducer covers the driver-observed
  shape directly at the `Connection` boundary.
