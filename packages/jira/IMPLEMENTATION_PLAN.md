# Jira Identity, Attachments, And Safe Comment Delete Plan

## Objective

Deliver three additive, independently testable Jira CLI capabilities:

1. `jira whoami` reads the connected account profile without exposing a bearer token.
2. `jira issue <key>` downloads every attachment by default, independently from inline-image capture.
3. `jira comment-delete <key> <comment-id>` backs up the full comment locally and durably before deleting it.

The existing `jira comment <key> --text ...` contract remains unchanged. Repository history uses direct
SemVer bumps without changesets, so these backward-compatible features will release as `0.6.0`.

## Repository And API Findings

- Current package version: `0.5.1`.
- `src/cli.ts` and `src/client.ts` are already above the 700-line guardrail. New command and persistence
  responsibilities will go in focused modules, with only registration/orchestration changes in those files.
- `fetchJiraCurrentUser` and `JiraAssignableUserSchema` are assignment-specific. A separate profile schema
  will preserve the existing `assign --me` safety contract and map private/missing email values to `null`.
- Inline images default to 20 files and 10,000,000 bytes each under
  `os.tmpdir()/saptools-jira/issue-images/<issue-key>/...`. General attachments will mirror those bounds and
  use the sibling `issue-attachments` directory.
- The image downloader already uses manual redirects and removes `Authorization` before fetching signed
  media URLs. The generic attachment downloader will keep that security model without weakening the
  image-only content checks.
- Atlassian documents:
  - `GET /rest/api/3/myself`: `200`, classic scope `read:jira-user`.
  - `GET /rest/api/3/attachment/content/{id}`: `200`/`206` or `303`, classic scope `read:jira-work`.
  - `GET /rest/api/3/issue/{issueIdOrKey}/comment/{id}`: `200`, classic scope `read:jira-work`.
  - `DELETE /rest/api/3/issue/{issueIdOrKey}/comment/{id}`: `204`, classic scope `write:jira-work`.
- Jira release history uses direct package version changes and has no Jira changeset or changelog. The pnpm
  lockfile importer does not store workspace package versions, so a version-only bump does not require a
  lockfile content change.

## Unit 1: Connected Account Identity

### Intended files

- `src/current-user.ts`: distinct profile schema/parser and authenticated `/myself` fetch.
- `src/types.ts`: `JiraCurrentUserProfile`.
- `src/format.ts`: concise human profile formatter.
- `src/whoami-command.ts`: register `jira whoami` with human and standalone JSON output.
- `src/cli.ts`: register the focused command module.
- `src/index.ts`: export the typed API.
- `tests/unit/current-user.test.ts`, `tests/unit/format.test.ts`: valid, missing-email, malformed, and HTTP
  failures.
- `tests/e2e/jira-cli.e2e.ts`: human/JSON output, missing email, malformed response, and missing-token behavior.

### Verification

- `jira whoami` prints display name, account ID, email availability, and active state.
- `jira whoami --json` always includes `emailAddress`, using `null` when Jira omits or nulls it.
- Authentication and malformed-response failures remain neutral and never include tokens.

## Unit 2: Issue Attachment Auto-Download

### Intended files

- `src/attachment-files.ts`: generic bounded attachment-content fetch, safe redirect handling, filename
  sanitization, and private local file writes.
- `src/issue-attachments.ts`: count bounds, per-attachment graceful errors, and image/attachment ID deduplication.
- `src/types.ts`: attachment download options and additive attachment local-path/error fields.
- `src/client.ts`: run image hydration and attachment hydration independently, in that order.
- `src/issue-command.ts`: register the existing issue command with new attachment flags outside the oversized
  CLI module.
- `src/cli.ts`: use the extracted issue command registration.
- `src/format.ts`: show downloaded attachment paths or per-file skip/failure reasons in human output.
- `src/index.ts`: export reusable attachment constants/helpers where appropriate.
- `tests/unit/attachment-files.test.ts`, `tests/unit/issue-attachments.test.ts`,
  `tests/unit/client.test.ts`, and `tests/unit/format.test.ts`: generic MIME types, byte/count bounds, failures,
  redirects, independent flags, and deduplication.
- `tests/e2e/jira-cli.e2e.ts`: built-CLI request sequences and saved-file assertions.

### Defaults and behavior

- Up to 20 attachment-list entries per issue.
- Up to 10,000,000 bytes per generically downloaded attachment.
- Default directory:
  `os.tmpdir()/saptools-jira/issue-attachments/<issue-key>/<unique-run>/...`.
- `--no-images` affects only inline-image hydration.
- `--no-attachments` affects only general attachment-list hydration.
- A successfully saved inline image is reused for the matching attachment ID, so that physical file is fetched
  once.
- Oversized, empty, failed, or count-limited entries keep metadata and gain a neutral `downloadError`; other
  attachments continue.

## Unit 3: Backup-Before-Delete Comments

### Command decision

Use the new top-level command:

```text
jira comment-delete <key> <comment-id>
```

Commander 13 does not provide a clean default subcommand that would preserve the shipped
`jira comment <key> --text ...` syntax while also making `comment delete` unambiguous. Repository releases
treat additive features as minor bumps and do not indicate approval for a breaking major release, so the
top-level command is the safe, non-breaking choice.

### Intended files

- `src/urls.ts`: encoded single-comment URL builder reused by GET and DELETE.
- `src/issue-comments.ts`: validated single-comment fetch and neutral `DELETE` client.
- `src/comment-backup.ts`: cloud-scoped path construction through `jiraCloudDataDirectory`, private atomic
  JSON write, file sync, and cleanup of failed temporary files.
- `src/comment-commands.ts`: preserve comment creation and add the non-breaking delete command.
- `src/cli.ts`: replace inline comment registration with the focused command module.
- `src/index.ts`: export the typed comment and backup APIs.
- `tests/unit/urls.test.ts`, `tests/unit/issue-comments.test.ts`, and
  `tests/unit/comment-backup.test.ts`: URL encoding, response validation, neutral errors, path/mode/content,
  and write failure.
- `tests/e2e/jira-cli.e2e.ts`: fetch → durable backup → DELETE order, zero DELETE on backup failure/not-found,
  retained backup on DELETE failure, output shapes, and no retries.

### Invariant

The command sequence is strictly:

```text
GET comment → write/sync/close/rename private backup → DELETE comment
```

The backup path is:

```text
~/.saptools/jira/clouds/<safe-cloud-id>/comments/<safe-issue-key>/<safe-comment-id>.json
```

No backup-skip option exists. A failed backup aborts before DELETE; a failed DELETE leaves the backup intact.

## Documentation And Release Files

- `packages/jira/README.md`: human-first `whoami`, default attachment downloads and controls, non-breaking
  `comment-delete`, recovery path, sensitive-download guidance, and verified classic OAuth scopes.
- `.skills/jira/SKILL.md`: plain output by default across every command example, JSON only for deterministic
  parsing, plus concise identity/attachment/delete guidance.
- `packages/jira/package.json`: bump `0.5.1` to `0.6.0`.
- `pnpm-lock.yaml`: inspect after the bump; retain unchanged if pnpm confirms no importer change.

## Complete Verification

Run:

```bash
pnpm --filter @saptools/jira cspell
pnpm --filter @saptools/jira lint
pnpm --filter @saptools/jira typecheck
pnpm --filter @saptools/jira test:unit
pnpm --filter @saptools/jira test:e2e
pnpm --filter @saptools/jira build
```

Then inspect:

- coverage branches for profile parsing/auth failures, attachment success/error/cap/deduplication behavior, and
  backup-before-delete ordering;
- generated `dist/index.d.ts`, `dist/index.js`, and `dist/cli.js`;
- built `jira --version`, root help, `whoami --help`, `issue --help`, `comment --help`, and
  `comment-delete --help`;
- source/function sizes, standalone attachment-command absence, secret-pattern searches, final package/skill
  diff, and unrelated dirty workspace files.

## Verification Result

- `pnpm --filter @saptools/jira check`: passed.
- Unit tests: 117 passed with 87.89% statements/lines, 82.62% branches, and 97.65% functions.
- Fake-backed E2E tests: 28 passed, including direct backup-exists-at-DELETE observation.
- Production build: passed; generated CLI reports `0.6.0`.
- Built help exposes `whoami`, the new `issue` attachment flags, and `comment-delete`; the existing
  `comment <key>` help remains unchanged and no attachment command exists.
- Generated declarations export the profile, single-comment, delete, URL, and backup APIs plus the additive
  issue attachment option/result fields.
- The package lockfile remained unchanged because its workspace importer does not store this package version.
- Jira skill validation and focused spelling checks passed.
