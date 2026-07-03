# Implementation Plan - Jira Safe Assignment

## Intended files
- `packages/jira/src/urls.ts`: add URL builders for current user, issue-scoped assignable-user search, and issue assignee updates.
- `packages/jira/src/types.ts`: add public request/user/assignment/resolution types.
- `packages/jira/src/assignment.ts`: add pure candidate validation, normalization, deduplication, deterministic assignee resolution, and ambiguity error types.
- `packages/jira/src/client.ts`: add typed Jira REST calls for `/myself`, issue-scoped assignable users, and `PUT /assignee`.
- `packages/jira/src/cli.ts`: register `jira assign` with selector validation, JSON/human output, and typed ambiguity formatting without inlining resolution logic.
- `packages/jira/src/index.ts`: export the assignment helpers intended for consumers.
- `packages/jira/tests/unit/*`: add URL, client, assignment, and CLI behavior coverage.
- `packages/jira/tests/e2e/jira-cli.e2e.ts`: extend fake Jira server and built CLI request-sequence tests.
- `packages/jira/README.md` and `.skills/jira/SKILL.md`: document assignment contract and agent guidance.
- `packages/jira/package.json` and `pnpm-lock.yaml`: bump `@saptools/jira` minor version and synchronize lock metadata.

## Reasons
- Implement deterministic issue assignee resolution that never guesses among multiple viable Jira users.
- Verify issue-specific assignability before every assignment write.
- Preserve existing CLI behavior and secret redaction.

## Verification steps
- `pnpm --filter @saptools/jira cspell`
- `pnpm --filter @saptools/jira lint`
- `pnpm --filter @saptools/jira typecheck`
- `pnpm --filter @saptools/jira test:unit`
- `pnpm --filter @saptools/jira test:e2e`
- `pnpm --filter @saptools/jira build`
- Inspect built CLI help/version/declarations and search changed files for accidental secrets.
