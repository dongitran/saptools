# Summary

## Objective

Add raw current-description ADF retrieval to `@saptools/jira` so users can round-trip rich Jira descriptions with embedded media: `jira describe OPS-123 --print > d.json`, edit text, then `jira describe OPS-123 --adf-file d.json`.

## Modified Files

- `packages/jira/src/adf.ts`
- `packages/jira/src/cli.ts`
- `packages/jira/src/client.ts`
- `packages/jira/src/types.ts`
- `packages/jira/tests/unit/adf.test.ts`
- `packages/jira/tests/unit/client.test.ts`
- `packages/jira/tests/unit/format.test.ts`
- `packages/jira/tests/e2e/jira-cli.e2e.ts`
- `packages/jira/README.md`
- `packages/jira/package.json`
- `packages/jira/IMPLEMENTATION_PLAN.md`
- `README.md`
- `.skills/jira/SKILL.md`

## Lessons & Decisions

- Reused `fetchJiraIssueDescriptionAdf`; no new endpoint or URL builder was added.
- `jira describe --print` branches before body-source selection, so read mode does not require `--text`, `--text-file`, or `--adf-file`.
- Default `--print` emits raw pretty JSON ADF. `--print --json` emits `{ issueKey, description }`.
- Null descriptions use an explicit policy: default raw mode exits non-zero instead of emitting an invalid empty ADF file; JSON mode returns `description: null`.
- `jira issue --json` now exposes `descriptionAdf` while keeping `descriptionText` unchanged.
- `descriptionAdf` is safe-parsed with `JiraAdfDocumentSchema`; invalid or missing raw descriptions map to `null` rather than breaking issue detail reads.
- Round-trip E2E coverage proves the printed media node is carried into a later `--adf-file` PUT unchanged.
- Package gate passed with `pnpm check` in `packages/jira`.
- Root `pnpm run lint` and `pnpm run typecheck` passed.
- Root `pnpm cspell`, `pnpm run test:unit`, and `pnpm run test:e2e` failed due to unrelated packages outside Jira. Jira package checks passed independently.
