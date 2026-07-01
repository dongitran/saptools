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
- ⏱️ **Worklogs** — adds focused time entries with optional ADF text comments.
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

### `jira worklog <key>`

Add a worklog entry.

```bash
jira worklog OPS-123 --minutes 30
jira worklog OPS-123 --minutes 30 --comment "Reviewed rollout logs"
jira worklog OPS-123 --minutes 30 --started "2026-05-01T08:20:00.000+0000"
```

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
- Do not commit `~/.jira-oauth/tokens.json`, custom token stores, access tokens, refresh tokens, or Authorization headers.

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
