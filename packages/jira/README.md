<div align="center">

# 🧭 `@saptools/jira`

**Jira Cloud CLI and typed API that reuse the same OAuth token store as JiraOps.**

Use the JiraOps browser login once, then script Jira reads and focused write actions from the terminal without copying tokens between tools.

[![npm version](https://img.shields.io/npm/v/@saptools/jira.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/jira)
[![license](https://img.shields.io/npm/l/@saptools/jira.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/jira.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![types](https://img.shields.io/npm/types/@saptools/jira.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Authentication](#-authentication) • [CLI](#-cli) • [Security](#-security)

</div>

---

## ✨ Features

- 🔁 **Shared JiraOps token** — reads and refreshes `~/.jira-oauth/tokens.json`, the default `jira-oauth-client` store used by JiraOps.
- 🎫 **Assigned issue list** — uses the same assigned-ticket JQL as JiraOps.
- 📖 **Issue details** — returns summary, status, priority, assignee, ADF description text, paginated comments, attachments, and clone-linked issues.
- 🔗 **Remote links** — lists Jira remote links such as GitLab MRs, runbooks, or dashboard URLs.
- 🔄 **Transitions** — lists available status transitions and applies a selected transition ID.
- 👤 **Safe assignment** — assigns one issue only after resolving exactly one active issue-assignable Jira account.
- ⏱️ **Worklogs** — adds focused time entries with optional ADF text comments and records successful writes in local history.
- 🧭 **Custom fields** — discovers Jira Cloud custom fields, pins useful display names, and updates editable pinned fields without hard-coded site IDs.
- 🧩 **Typed API** — every CLI workflow is available as a TypeScript function.
- 🧪 **Fake-backed E2E** — test coverage validates the real built CLI without calling Atlassian.

---

## 📦 Install

```bash
npm install -g @saptools/jira

# Or as a project dependency
npm install @saptools/jira
# pnpm add @saptools/jira
```

> [!NOTE]
> Requires **Node.js ≥ 20** and a Jira Cloud account. This package targets Atlassian Cloud's `api.atlassian.com/ex/jira` API, not Jira Data Center.

---

## 🔐 Authentication

`@saptools/jira` intentionally uses the same token store as JiraOps and `jira-oauth-client`:

```text
~/.jira-oauth/tokens.json
```

If JiraOps already connected successfully, this CLI can read the same stored access token immediately:

```bash
jira status
jira issues
```

When the token expires, refresh and connect flows need the Atlassian OAuth app credentials in the CLI environment:

```bash
export JIRA_CLIENT_ID="your-atlassian-oauth-client-id"
export JIRA_CLIENT_SECRET="your-atlassian-oauth-client-secret"

jira connect
```

To remove the local shared token file:

```bash
jira logout
```

Your Atlassian OAuth app must allow the `jira-oauth-client` callback URL:

```text
http://localhost:30129/callback
```

Use a custom token file only when you deliberately do not want to share the JiraOps token:

```bash
jira --token-store ./tmp/jira-tokens.json status
```

---

## 🧰 CLI

### `jira status`

Show whether a shared Jira token is present and still usable.

```bash
jira status
jira status --json
```

### `jira connect`

Run the browser OAuth flow and write tokens to the shared token store.

```bash
jira connect
jira connect --json
```

### `jira disconnect`

Delete the shared token file.

```bash
jira disconnect
```

### `jira logout`

Delete the shared token file. This is equivalent to `jira disconnect`.

```bash
jira logout
```

### `jira token`

Print the current access token for scripts.

```bash
jira token
```

> [!IMPORTANT]
> `jira token` prints a live bearer token. Do not paste it into tickets, logs, commits, shell history captures, or screenshots.

### `jira issues`

List assigned, not-done issues ordered by update time.

```bash
jira issues
jira issues --max 10
jira issues --json
```

### `jira issue <key>`

Read one issue's detail payload.

```bash
jira issue OPS-123
jira issue OPS-123 --json
jira issue OPS-123 --no-images
```

Inline Jira images in the description or comments are saved to the OS temp directory by default. Downloaded local image metadata is returned only in the top-level `images[]` array as `fileUrl`/`filePath` entries plus attachment metadata; join images to `attachments[]` with `image.attachmentId === attachment.id`. Use `--image-dir <path>`, `--max-image-bytes <number>`, or `--max-images <number>` to control local image capture.

### `jira links <key>`

List remote links attached to an issue.

```bash
jira links OPS-123
jira links OPS-123 --json
```

### `jira transitions <key>`

List available status transitions.

```bash
jira transitions OPS-123
jira transitions OPS-123 --json
```

### `jira transition <key> --id <id>`

Apply a transition by ID.

```bash
jira transition OPS-123 --id 31
```

### `jira assign <key>`

Assign one Jira issue after deterministic assignee resolution:

```bash
jira assign OPS-123 --me
jira assign OPS-123 --to "Example User"
jira assign OPS-123 --account-id "account-id-from-ambiguity"
jira assign OPS-123 --to "Example User" --json
```

Exactly one selector is required: `--me`, `--to <name-or-query>`, or `--account-id <account-id>`. The CLI rejects missing, combined, or blank selectors before calling Jira.

- `--me` fetches `GET /rest/api/3/myself`, then verifies that active account through the issue-scoped assignable-user search before writing.
- `--to` is an approximate Jira display-name query. The CLI searches only users assignable to the target issue with `issueKey=<KEY>`, `query=<name-or-query>`, and `maxResults=1000`.
- `--account-id` is the deterministic retry path. It still verifies the account through the same issue-scoped assignable-user endpoint with `accountId=<account-id>` before assignment.

Jira can return broad name matches. The CLI never auto-selects among multiple unresolved candidates. A unique normalized exact display-name match wins over weaker fuzzy matches, and a single fuzzy candidate is accepted only when no exact full-name match exists. Multiple exact display-name matches or multiple fuzzy candidates are ambiguous and no Jira mutation occurs.

Human ambiguity output lists the candidate display names and account IDs and recommends retrying with `--account-id`:

```text
Multiple active assignable Jira users match "Example"; no assignment was changed.
2 candidates:
Example One    account-id-1
Example Two    account-id-2
Retry with: jira assign OPS-123 --account-id <account-id>
```

JSON ambiguity is written to stderr with a non-zero exit status:

```json
{
  "error": "ambiguous_assignee",
  "issueKey": "OPS-123",
  "query": "Example",
  "message": "Multiple active assignable Jira users matched; no assignment was changed.",
  "candidates": [
    { "accountId": "account-id-1", "displayName": "Example One" },
    { "accountId": "account-id-2", "displayName": "Example Two" }
  ]
}
```

Successful JSON output has no hint footer:

```json
{
  "issueKey": "OPS-123",
  "assignee": { "accountId": "account-id-1", "displayName": "Example One" },
  "resolution": "exact"
}
```

Assignment requires Jira Browse Projects and Assign Issues permissions, any applicable issue-security access, and OAuth scopes that allow user lookup and assignment (`read:jira-user` and `write:jira-work` for classic scopes). Jira user search operations are documented around a first-1,000-user search window, so the CLI requests `maxResults=1000`; zero results mean only that no active assignable candidate was returned for that issue and query.


### `jira fields`

Discover, cache, pin, and update site-specific Jira custom fields by display name. Field IDs such as `customfield_10101` are Jira-site-specific, so agents should discover and pin names for each connected cloud instead of hard-coding IDs.

```bash
jira fields discover
jira fields discover --search "custom text"
jira fields search "custom text"
jira fields pin "Custom text A"
jira fields pin "Custom text B"
jira fields pinned
jira fields unpin "Custom text A"
jira fields update OPS-123 --field 'Custom text A=analysis notes'
jira fields update OPS-123 --field 'Custom text A=analysis notes' --field-file 'Custom text B=./review.md'
```

`jira fields discover` always refreshes from Jira Cloud and has no `--refresh` flag. `jira fields discover --search <query>` still fetches and saves the complete refreshed snapshot; the search only filters the terminal output so agents can inspect candidates immediately. `jira fields search <query>` searches the cached snapshot without calling Jira and fails clearly if discovery has not run.

Local custom field metadata is stored under the current user's home directory with Node path handling:

```text
~/.saptools/jira/clouds/<cloudId>/fields.json
~/.saptools/jira/clouds/<cloudId>/pinned-fields.json
```

The cache stores normalized field metadata only. It never stores access tokens, refresh tokens, Authorization headers, OAuth client secrets, request headers, field values, or raw Jira responses. Pinned fields are cloud/site-specific and persist the resolved Jira field ID internally, but normal pin, unpin, update, and footer workflows use Jira display names only; aliases are not generated or accepted.

`jira fields update <KEY>` resolves names against `pinned-fields.json`, fetches `editmeta` for that issue, verifies every target field is editable before writing, and then sends a Jira issue field update. Textarea custom fields are sent as Atlassian Document Format; single-line text fields are sent as strings. Success output lists only display names and does not echo field values.

After fields are pinned, normal human output includes a display-name-only footer such as:

```text
Updatable custom fields: Custom text A, Custom text B. Use: jira fields update <KEY> --field 'FIELD NAME=value'
```

The footer never includes `customfield_*` IDs, custom numeric IDs, schema details, aliases, or values. It is never appended to `--json`, `jira token`, help, or version output; use global `--no-hints` to suppress it in human output.

### `jira worklog <key>`

Add a worklog entry.

```bash
jira worklog OPS-123 --minutes 30
jira worklog OPS-123 --minutes 30 --comment "Reviewed rollout logs"
jira worklog OPS-123 --minutes 30 --started "2026-05-01T08:20:00.000+0000"
```

Successful worklog writes are also appended to a local, human-readable Markdown history file under:

```text
~/.saptools/jira/worklog-history/YYYYMM.md
```

The monthly file is chosen from the worklog `started` timestamp, so logging time today for a previous month updates that previous month file. If local history cannot be written after Jira accepts the worklog, the CLI prints a warning and does not retry or undo the Jira write. The history stores only the logged-at timestamp, started timestamp, issue key, minutes, hours, and sanitized comment text; it never stores OAuth tokens, refresh tokens, client secrets, Authorization headers, request headers, or raw Jira responses.

### `jira worklogs`

Summarize local worklog history without calling Jira, reading tokens, or requiring a network connection. Missing history files produce zero totals.

```bash
jira worklogs --day 2026-05-01
jira worklogs --day 2026-05-01 --json
jira worklogs --issue OPS-123 --month 202605 --json
jira worklogs --issue OPS-123 --from 2026-05-01 --to 2026-05-31
jira worklogs --month 202605 --group-by day
jira worklogs --month 202605 --group-by issue
```

Human output includes total minutes/hours and grouped totals. `--json` returns the parsed local entries plus structured totals for agents and scripts.

### Test API root

For deterministic integration tests, point the CLI at a fake Atlassian-compatible API root:

```bash
jira --api-root http://127.0.0.1:4010/ex/jira issues --json
```

---

## 🧪 Development

```bash
pnpm install
pnpm --filter @saptools/jira build
pnpm --filter @saptools/jira lint
pnpm --filter @saptools/jira typecheck
pnpm --filter @saptools/jira cspell
pnpm --filter @saptools/jira test:unit
pnpm --filter @saptools/jira test:e2e
```

E2E tests pre-seed a temp `HOME/.jira-oauth/tokens.json` and run the built `dist/cli.js` against a fake Jira HTTP server.

---

## 🔒 Security

- OAuth app credentials come from `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, or explicit flags.
- Access and refresh tokens are stored only in the shared token file, with owner-only permissions when this package writes it.
- Jira HTTP errors are reported as neutral messages and do not include response bodies.
- Custom field snapshots and pinned-field configs under `~/.saptools/jira/clouds/<cloudId>/` store only normalized metadata, never credentials, Authorization headers, raw Jira responses, or field values.
- Do not commit `~/.jira-oauth/tokens.json`, custom token stores, access tokens, refresh tokens, or Authorization headers.

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
