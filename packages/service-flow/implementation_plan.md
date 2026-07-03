# service-flow GitHub Action Failure Fix Plan

## Scope

- Fix the failing `service-flow` GitHub Action on `main`.
- Preserve unrelated local work:
  - Do not modify, stage, delete, or move untracked `packages/cf-watch/`.
- Keep changes scoped to `packages/service-flow` unless workflow configuration is proven to be the root cause.
- Commit and push the fix, then monitor `.github/workflows/service-flow.yml` with `gh` until the workflow succeeds.

## Current Findings

- Latest failing push run: `28639045327`.
- Workflow: `.github/workflows/service-flow.yml`.
- Commit: `8b44884896db7b4eb5c36ec5a3530b18f029ef7e`.
- Passing CI steps before failure:
  - `pnpm --filter @saptools/service-flow lint`
  - `pnpm --filter @saptools/service-flow typecheck`
  - `pnpm --filter @saptools/service-flow build`
  - `pnpm --filter @saptools/service-flow test:unit`
- Failing CI step:
  - `pnpm --filter @saptools/service-flow test:e2e:fake`
- Failure:
  - `tests/e2e/cli.e2e.test.ts` parses CLI JSON from a helper that returns `stdout + stderr`.
  - CI fails with `Unexpected non-whitespace character after JSON at position 10338 (line 353 column 1)`.
  - The workflow verify job uses Node `22.23.1`; the CI log shows `ExperimentalWarning: SQLite is an experimental feature` during tests. Appending stderr to stdout makes otherwise valid JSON unparseable.

## Research Steps

1. Read the e2e test helper and command sequence:
   - `packages/service-flow/tests/e2e/cli.e2e.test.ts`
2. Read CLI output behavior:
   - `packages/service-flow/src/cli.ts`
   - `packages/service-flow/src/output/json-output.ts`
   - `packages/service-flow/src/output/mermaid-output.ts`
3. Reproduce the failing shape by running the e2e test under Node 22, or by injecting stderr while preserving valid stdout in a focused test if Node 22 is unavailable locally.
4. Confirm whether the CLI itself emits structured output only to stdout and diagnostics only to stderr.

## Intended Code Changes

- Update the e2e helper to keep stdout and stderr separate.
- Parse machine-readable JSON from stdout only.
- Preserve stderr in assertion failure messages so real CLI errors remain debuggable.
- Add a focused test or assertion that JSON commands keep stdout parseable even when stderr contains warnings.

## Verification

- RED: with a synthetic runtime stderr warning preloaded via `node --require`, the existing e2e helper failed JSON parsing with `Unexpected non-whitespace character after JSON`.
- GREEN: after returning stdout only from the e2e helper, the same e2e flow parsed JSON successfully while stderr warning output remained separate.
- `git diff --check`
- `pnpm --filter @saptools/service-flow lint`
- `pnpm --filter @saptools/service-flow typecheck`
- `pnpm --filter @saptools/service-flow build`
- `pnpm --filter @saptools/service-flow test:unit`
- `pnpm --filter @saptools/service-flow test:e2e:fake`
- `npm pack --dry-run` from `packages/service-flow`

## Push And Monitoring

- Commit without bypassing hooks.
- Push `main`.
- Use `gh run list --workflow service-flow.yml` to find the run for the pushed SHA.
- Use `gh run watch <run-id> --exit-status`.
- If it fails, inspect `gh run view <run-id> --log-failed`, update this plan if the hypothesis changes, and repeat until the workflow succeeds.
