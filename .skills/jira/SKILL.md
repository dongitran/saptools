---
name: jira
description: Use when working with Jira Cloud through the jira CLI, including connected-account identity, assigned issue lists, issue details with local attachments and inline images, remote links, transitions, safe issue assignment, worklogs, descriptions, summaries, comment creation, and backup-first comment deletion.
---

# Jira

## Purpose

Use `jira` to read and update Jira Cloud issues from the terminal. Prefer it when the user needs the connected account's identity, assigned tickets, one issue's description/comments/attachments, locally saved attachment or inline-image files, remote links, available transitions, safe assignee changes, description/summary/comment writes, recoverable comment deletion, status changes, logout, or worklog entries.

If `jira` is missing, install it from `@saptools/jira`: `npm install -g @saptools/jira`.

## First Steps

1. Identify whether the user needs auth status or identity, assigned issues, one issue detail, remote links, transitions, a transition write, a content write, a comment deletion, or a worklog write.
2. Use plain human-readable output by default, including when an agent will read the result and act on it directly. Use `--json` only when a deterministic script, `jq` pipeline, or another tool must parse fields programmatically.
3. Reuse the default token store at `~/.jira-oauth/tokens.json` when available.
4. Use write commands only when the user explicitly asks to assign or transition an issue, update issue content, add worklog time, or delete a comment.
5. Treat access tokens, refresh tokens, Authorization headers, OAuth client secrets, and raw token-store contents as sensitive.

## Authentication

Check whether the default Jira token is present and usable:

```bash
jira status
```

Resolve the connected Jira account's own identity:

```bash
jira whoami
```

Never extract a bearer token with `jira token` and hand-curl `/myself`. When a
deterministic script needs the stable account ID, use the structured form as a
secondary pipeline:

```bash
jira whoami --json | jq -r '.accountId'
```

Connect through browser OAuth when no token exists or the user needs a fresh connection:

```bash
jira connect
```

Refresh and connect flows need Atlassian OAuth app credentials in the environment:

```bash
export JIRA_CLIENT_ID="..."
export JIRA_CLIENT_SECRET="..."
jira connect
```

Use a separate token file only when the run must not share the default token store:

```bash
jira --token-store ./tmp/jira-tokens.json status
```

Log out by removing the local shared token file:

```bash
jira logout
```

Avoid `jira token` unless the user explicitly needs a bearer token for a script. It prints a live access token.

## Command Choice

List assigned, not-done issues:

```bash
jira issues
```

- `--max <number>`: maximum issue count.
- `--json`: return structured output for parsing.

Read one issue:

```bash
jira issue OPS-123
```

- The default call downloads every attachment locally; no separate attachment-download command or token/curl workaround is needed.
- `--json`: use only when a script must parse summary, status, priority, assignee, flattened description text, raw `descriptionAdf`, paginated comments, attachments, clone links, and saved-file metadata.
- `--no-attachments`: keep attachment metadata without downloading the general attachment list.
- `--attachment-dir <path>`: save general attachments in a controlled folder.
- `--max-attachments <number>`: cap the number of general attachments saved.
- `--max-attachment-bytes <number>`: cap each general attachment body size.
- `--no-images`: skip downloading inline Jira images.
- `--image-dir <path>`: save inline images in a specific folder instead of the OS temp directory.
- `--max-images <number>`: cap the number of inline images saved.
- `--max-image-bytes <number>`: cap each saved image body size.

Print the current raw description ADF when the user needs to inspect or safely edit a complex description:

```bash
jira describe OPS-123 --print > description.adf.json
```

- `--print` is a read mode and does not update Jira.
- Default `--print` emits raw pretty-printed ADF JSON, not human text, so redirected output can be reused with `--adf-file`.
- `--print --json` returns `{ "issueKey": "OPS-123", "description": <ADF|null> }`.
- If default `--print` reports that the issue has no description ADF, use `--print --json` to handle `null` explicitly.

For a deterministic caller that must distinguish a missing description:

```bash
jira describe OPS-123 --print --json | jq '.description'
```

Round-trip a description with images by editing the printed ADF and pushing the whole document back:

```bash
jira describe OPS-123 --print > description.adf.json
# Edit only the relevant {"type":"text","text":"..."} node.
jira describe OPS-123 --adf-file ./description.adf.json
```

- Leave `media` and `mediaSingle` nodes unchanged. Their `media.attrs.id` values point to existing Jira media, so the image is preserved without re-upload.
- `--text` and `--text-file` cannot preserve media because flattened text has no media nodes.
- The read-edit-write flow is last-write-wins; if Jira changes between `--print` and `--adf-file`, the later update overwrites the server description.

Update a description only when the user explicitly asks for a write:

```bash
jira describe OPS-123 --text "Plain text description"
jira describe OPS-123 --text-file ./description.txt
jira describe OPS-123 --adf-file ./description.adf.json
jira describe OPS-123 --text "Additional notes" --append
```

- Exactly one body source is required for write mode: `--text`, `--text-file`, or `--adf-file`.
- Plain text becomes ADF paragraphs; blank lines split paragraphs and single newlines become hard breaks.
- `jira describe` checks Jira edit metadata before writing.
- If the current description contains media, plain-text replacement is refused unless `--force` is passed. Prefer `--append` or a `--print` to `--adf-file` round-trip that preserves the media nodes.
- Native local-image inline embedding is unsupported because Jira attachments do not reliably expose the Media Services ID needed for ADF `media` file nodes.
- Use `--no-notify-users` only when the user explicitly wants to suppress Jira notifications.

Update a summary only when the user explicitly asks for a write:

```bash
jira summary OPS-123 "New issue title"
```

- Summary is a plain string, not ADF.
- The command checks Jira edit metadata before writing.
- Use `--no-notify-users` only when notification suppression is intended.

Add a comment only when the user explicitly asks for a write:

```bash
jira comment OPS-123 --text "Reviewed the rollout logs."
jira comment OPS-123 --text-file ./comment.txt
jira comment OPS-123 --adf-file ./comment.adf.json
```

- Exactly one body source is required: `--text`, `--text-file`, or `--adf-file`.
- Plain text becomes ADF paragraphs. Raw ADF is for callers that need richer comment content.
- JSON output returns `issueKey` and `commentId`.

Delete a comment only when the user explicitly wants that specific comment removed:

```bash
jira comment-delete OPS-123 10098
```

- The command always fetches the full comment and durably backs it up before `DELETE`; there is no backup-skip flag.
- If the backup write fails, no Jira deletion occurs. A Jira delete failure leaves the backup in place and is not retried.
- Recovery data lives at `~/.saptools/jira/clouds/<cloudId>/comments/<issueKey>/<commentId>.json`, and success output reports the absolute path.
- Use `jira comment-delete OPS-123 10098 --json` only when a script must parse `issueKey`, `commentId`, `backupPath`, and `deleted`.

List remote links:

```bash
jira links OPS-123
```

- `--json`: return structured remote-link objects.

List available transitions:

```bash
jira transitions OPS-123
```

- `--json`: return transition IDs and destination statuses.

Apply a transition by ID:

```bash
jira transition OPS-123 --id 31
```

- `--id <id>`: required transition ID from `jira transitions <key>`.

Assign one issue only when the user explicitly asks for an assignee write:

```bash
jira assign OPS-123 --me
jira assign OPS-123 --to "Display Name"
jira assign OPS-123 --account-id "account-id-from-ambiguity"
```

- Use `jira assign <KEY> --me` for the connected Jira account.
- Use `jira assign <KEY> --to "Display Name"` for Jira's issue-scoped assignable-user name lookup.
- Use `--account-id` only after inspecting ambiguous candidates or when the stable Jira account ID is already known.
- Assignment is a write and requires explicit user intent.
- If assignment is ambiguous, no Jira mutation occurred; inspect the returned candidate display names/account IDs and ask the user which account to use.
- Never work around ambiguity by calling `jira token` and hand-writing an unsafe first-result script.

Add worklog time:

```bash
jira worklog OPS-123 --minutes 30
```

- `--minutes <number>`: required positive worklog duration.
- `--comment <text>`: optional worklog comment.
- `--started <date>`: optional Jira timestamp such as `2026-05-01T08:20:00.000+0000`.
- Successful writes are appended locally under `~/.saptools/jira/worklog-history/YYYYMM.md`; local history failures warn but do not retry the Jira write.

Summarize local worklog history without calling Jira or reading tokens:

```bash
jira worklogs --day 2026-05-01
jira worklogs --issue OPS-123 --month 202605
jira worklogs --month 202605 --group-by issue
```

Use `--api-root <url>` only for deterministic tests or compatible fake Atlassian API roots:

```bash
jira --api-root http://127.0.0.1:4010/ex/jira issue OPS-123
```


## Custom Field Discovery And Updates

Use custom field workflows when agents need site-specific fields such as analysis notes, review notes, or completion notes. Always work with Jira display names; do not ask users to provide `customfield_*` IDs and do not invent aliases.

```bash
jira fields discover
jira fields discover --search "custom text"
jira fields search "custom text"
jira fields pin "Custom text A"
jira fields pin "Custom text B"
jira fields update ABC-123 --field 'Custom text A=...' --field 'Custom text B=...'
```

Important behavior:

- `jira fields discover` always refreshes custom fields from Jira Cloud. There is no `--refresh` flag.
- `jira fields discover --search <query>` still saves the complete refreshed snapshot; search only filters the command output.
- `jira fields search <query>` searches the cached snapshot without network calls.
- Pinned fields are site-specific and stored under `~/.saptools/jira/clouds/<cloudId>/pinned-fields.json`.
- Pin, unpin, and update commands use exact case-insensitive Jira display names without aliases.
- The regular human-output footer lists display names only and never exposes `customfield_*` IDs, numeric custom IDs, aliases, schema details, or field values.
- `jira fields update` checks issue editability with Jira edit metadata before writing and fails before PUT when a pinned field is not editable on that issue.
- Treat cached field metadata as local user data. It must not contain access tokens, refresh tokens, Authorization headers, OAuth client secrets, raw Jira responses, or field values.

## Issue Images

`jira issue <key>` downloads inline Jira images from description and comments by default. It saves each verified image body under the operating system temp directory and reports local links; JSON output exposes:

- `images[].filePath`: local filesystem path.
- `images[].fileUrl`: `file://` URL for the saved image.
- `images[].source`: `description` or `comment`.
- Matching `attachments[].localPath` and `attachments[].fileUrl` reuse the same saved file.

The CLI fetches Jira attachment content first, falls back to thumbnails, and follows signed Atlassian media redirects without forwarding the Jira bearer token. Image bodies must have an image content type or sniff as PNG, JPEG, GIF, or WebP.

Defaults:

- up to 20 inline images per issue
- up to 10,000,000 bytes per saved image
- output directory from `os.tmpdir()` under `saptools-jira/issue-images/<issue-key>/...`

Use `--no-images` when the task only needs text or when local screenshot files would be too sensitive.

## Issue Attachments

`jira issue <key>` downloads every entry in `attachments[]` by default, regardless
of content type. Successful entries include `localPath` and `fileUrl`; failed,
empty, oversized, or count-limited entries retain metadata and include a neutral
`downloadError` while remaining downloads continue.

Defaults:

- up to 20 general attachments per issue
- up to 10,000,000 bytes per general attachment
- output directory from `os.tmpdir()` under `saptools-jira/issue-attachments/<issue-key>/...`

Use `--no-attachments` for metadata only. Use `--attachment-dir`,
`--max-attachments`, and `--max-attachment-bytes` to control location and bounds.
`--no-attachments` and `--no-images` are independent. When one physical attachment
is also an inline image, the CLI reuses that saved image and fetches its attachment
ID only once.

## Required Image Review

When using `jira issue <key>` and the JSON output contains `images[]`, inspect every saved `images[].filePath` before answering the user. Explain the visible content in each image carefully:

- Identify the screen, page, dialog, browser/tool panel, or application area shown.
- Call out selected filters, form values, table columns, highlighted rows, error text, request names, response fields, or any DevTools/F12 panels visible.
- Connect the image evidence back to the ticket's expected and actual behavior.
- State when a file path is missing, inaccessible, or the image cannot be inspected.

## Data Handling

Do not paste access tokens, refresh tokens, Authorization headers, OAuth client secrets, or raw token-store contents into chat. The token store is `~/.jira-oauth/tokens.json`.

Downloaded image and attachment files are local artifacts, not repository files. If they are sensitive, use `--image-dir <path>` or `--attachment-dir <path>` pointing to a controlled temporary folder and remove it after use.

Comment-delete backups contain the full original comment. Keep recovery files under
the existing private `~/.saptools/jira/clouds/<cloudId>/comments/...` tree.
