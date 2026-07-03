---
name: jira
description: Use when working with Jira Cloud through the jira CLI, including assigned issue lists, issue details with local inline image files, remote links, transitions, safe issue assignment, and worklogs.
---

# Jira

## Purpose

Use `jira` to read and update Jira Cloud issues from the terminal. Prefer it when the user needs assigned tickets, one issue's description/comments/attachments, locally saved inline issue images, remote links, available transitions, safe assignee changes, status changes, logout, or worklog entries.

If `jira` is missing, install it from `@saptools/jira`: `npm install -g @saptools/jira`.

## First Steps

1. Identify whether the user needs auth status, assigned issues, one issue detail, remote links, transitions, a transition write, or a worklog write.
2. Prefer `--json` for agent workflows and downstream parsing.
3. Reuse the default token store at `~/.jira-oauth/tokens.json` when available.
4. Use write commands only when the user explicitly asks to assign an issue, transition an issue, or add worklog time.
5. Treat access tokens, refresh tokens, Authorization headers, OAuth client secrets, and raw token-store contents as sensitive.

## Authentication

Check whether the default Jira token is present and usable:

```bash
jira status --json
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
jira --token-store ./tmp/jira-tokens.json status --json
```

Log out by removing the local shared token file:

```bash
jira logout
```

Avoid `jira token` unless the user explicitly needs a bearer token for a script. It prints a live access token.

## Command Choice

List assigned, not-done issues:

```bash
jira issues --json
```

- `--max <number>`: maximum issue count.
- `--json`: return structured output for parsing.

Read one issue:

```bash
jira issue OPS-123 --json
```

- `--json`: return summary, status, priority, assignee, description text, paginated comments, attachments, clone links, and saved image metadata.
- `--no-images`: skip downloading inline Jira images.
- `--image-dir <path>`: save inline images in a specific folder instead of the OS temp directory.
- `--max-images <number>`: cap the number of inline images saved.
- `--max-image-bytes <number>`: cap each saved image body size.

List remote links:

```bash
jira links OPS-123 --json
```

- `--json`: return structured remote-link objects.

List available transitions:

```bash
jira transitions OPS-123 --json
```

- `--json`: return transition IDs and destination statuses.

Apply a transition by ID:

```bash
jira transition OPS-123 --id 31
```

- `--id <id>`: required transition ID from `jira transitions <key> --json`.

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
jira worklogs --day 2026-05-01 --json
jira worklogs --issue OPS-123 --month 202605 --json
jira worklogs --month 202605 --group-by issue
```

Use `--api-root <url>` only for deterministic tests or compatible fake Atlassian API roots:

```bash
jira --api-root http://127.0.0.1:4010/ex/jira issue OPS-123 --json
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

`jira issue <key>` downloads inline Jira images from description and comments by default. It saves each verified image body under the operating system temp directory and returns local links in JSON:

- `images[].filePath`: local filesystem path.
- `images[].fileUrl`: `file://` URL for the saved image.
- `images[].source`: `description` or `comment`.
- `attachments[].localPath` and `attachments[].fileUrl`: populated for matched saved images.

The CLI fetches Jira attachment content first, falls back to thumbnails, and follows signed Atlassian media redirects without forwarding the Jira bearer token. Image bodies must have an image content type or sniff as PNG, JPEG, GIF, or WebP.

Defaults:

- up to 20 inline images per issue
- up to 10,000,000 bytes per saved image
- output directory from `os.tmpdir()` under `saptools-jira/issue-images/<issue-key>/...`

Use `--no-images` when the task only needs text or when local screenshot files would be too sensitive.

## Required Image Review

When using `jira issue <key>` and the JSON output contains `images[]`, inspect every saved `images[].filePath` before answering the user. Explain the visible content in each image carefully:

- Identify the screen, page, dialog, browser/tool panel, or application area shown.
- Call out selected filters, form values, table columns, highlighted rows, error text, request names, response fields, or any DevTools/F12 panels visible.
- Connect the image evidence back to the ticket's expected and actual behavior.
- State when a file path is missing, inaccessible, or the image cannot be inspected.

## Data Handling

Do not paste access tokens, refresh tokens, Authorization headers, OAuth client secrets, or raw token-store contents into chat. The token store is `~/.jira-oauth/tokens.json`.

Downloaded image files are local temp artifacts, not repository files. If the images are sensitive, use `--image-dir <path>` pointing to a controlled temporary folder and remove it after use.
