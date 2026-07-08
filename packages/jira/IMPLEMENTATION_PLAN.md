# Description ADF Round-Trip Plan

## Objective

Add a read mode for `jira describe <key>` that emits the stored Jira description as raw Atlassian Document Format (ADF), enabling users to edit a text node and push the same document back with `--adf-file` without losing media nodes. Also expose the same raw ADF in `jira issue <key> --json`.

## Source Findings

- `src/client.ts` already exports `fetchJiraIssueDescriptionAdf(options)`, which calls the existing description endpoint and validates the response with `JiraAdfDocumentSchema`.
- `updateJiraIssueDescription(options)` already preserves existing media for `--append`, refuses unsafe plain-text replacement unless `--force`, and sends `--adf-file` documents as-is.
- `src/cli.ts` currently calls `readJiraAdfBodyInput(flags)` unconditionally in `addDescribeCommand`, so a read mode must branch before body-source selection.
- `mapIssueDetail(issue)` already receives `issue.fields.description` but only emits `descriptionText`.
- `JiraAdfDocumentSchema` requires a non-empty `content` array. Raw non-JSON `--print` mode therefore must not emit an empty document for null descriptions because that output would not validate through the existing `--adf-file` path.
- The E2E fake Jira fixture for `OPS-123` already returns a description containing a `mediaSingle` node with `attrs.id: "media-platform-id"`.

## Shipped Behavior

- Add `jira describe <key> --print`.
- Without `--json`, `--print` writes only pretty-printed raw ADF JSON to stdout so redirection creates a re-pushable `--adf-file` artifact.
- With `--json`, `--print` writes an envelope:

  ```json
  {
    "issueKey": "OPS-123",
    "description": null
  }
  ```

  where `description` is the raw ADF document or `null`.
- If the current issue has no description and `--print` is used without `--json`, the CLI writes a clear stderr error and exits non-zero rather than creating an invalid empty file.
- `--print` is mutually exclusive with `--text`, `--text-file`, and `--adf-file`.
- Existing write mode remains unchanged when `--print` is absent: exactly one body source is still required.
- `jira issue <key> --json` gains `descriptionAdf: JiraAdfDocument | null`; human formatting remains based on `descriptionText`.
- `descriptionAdf` is populated only when `issue.fields.description` safely parses as `JiraAdfDocument`; missing, null, or invalid descriptions map to `null` without making detail reads fail.

## Files To Touch

- `packages/jira/tests/unit/adf.test.ts`: cover flag validation helper behavior for read-vs-write body source selection.
- `packages/jira/tests/unit/client.test.ts`: assert `descriptionAdf` preserves valid raw ADF, stays `null` for missing/invalid descriptions, and keeps `descriptionText` unchanged.
- `packages/jira/tests/e2e/jira-cli.e2e.ts`: cover `describe --print`, round-trip `--print` output into `--adf-file`, media-node preservation, `describe --print --json`, `issue --json` `descriptionAdf`, and null raw print error handling if fixture support is needed.
- `packages/jira/src/adf.ts`: add a small validation helper that enforces `--print` body-source exclusivity without changing write-source selection.
- `packages/jira/src/cli.ts`: add the `--print` flag, branch before `readJiraAdfBodyInput`, fetch via `fetchJiraIssueDescriptionAdf`, and print either raw ADF or the JSON envelope.
- `packages/jira/src/types.ts`: add `descriptionAdf` to `JiraIssueDetail`.
- `packages/jira/src/client.ts`: safe-parse `issue.fields.description` into `descriptionAdf` inside `mapIssueDetail`.
- `packages/jira/README.md`: document `--print`, raw ADF round-trip image preservation, null handling, and concurrency caveat.
- `README.md`: update the `@saptools/jira` package summary.
- `.skills/jira/SKILL.md`: document read mode and safe round-trip editing rules.
- `packages/jira/package.json`: bump `0.4.0` to `0.5.0`.

## Verification Matrix

- RED: `pnpm --filter @saptools/jira test:unit -- tests/unit/adf.test.ts tests/unit/client.test.ts` failed before implementation because `assertNoJiraAdfBodySource` and `descriptionAdf` mapping were missing.
- GREEN focused:
  - `pnpm --filter @saptools/jira test:unit -- tests/unit/adf.test.ts tests/unit/client.test.ts`
  - `pnpm --filter @saptools/jira test:e2e`
- Package checks run during implementation:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm cspell`
- Full requested gate:

  ```bash
  pnpm cspell
  pnpm lint
  pnpm typecheck
  pnpm test:unit
  pnpm test:e2e
  ```

- Commit with a Conventional Commit message after verification and push a working branch for PR creation.
