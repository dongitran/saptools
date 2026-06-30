<div align="center">

# 📜 `@saptools/cf-logs`

**Turn SAP BTP Cloud Foundry logs into a reusable engine, not a one-off UI feature.**

Fetch snapshots, stream live output, normalize plain-text and JSON rows, emit compact high-signal context, and persist bounded log state to disk through one CLI and one typed Node.js API.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-logs.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-logs)
[![license](https://img.shields.io/npm/l/@saptools/cf-logs.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-logs.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/cf-logs)](https://packagephobia.com/result?p=@saptools/cf-logs)
[![types](https://img.shields.io/npm/types/@saptools/cf-logs.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [Store](#-store-file) • [Security](#-security-notes)

</div>

---

## ✨ Features

- 📥 **Recent snapshots** — run `cf logs --recent`, normalize the result, and optionally persist it
- 📡 **Live streams** — wrap `cf logs <app>` with batching, reconnection, bounded in-memory state, and typed events
- 🧠 **Log normalization** — handle plain text, JSON logs, multiline continuations, and router access metadata such as method, request, status, latency, tenant, client IP, and request ID
- 🪶 **Compact output** — project logs into concise rows with optional refs back to full saved rows
- 🗃️ **Bounded local store** — write snapshots to `~/.saptools/cf-logs-store.json` with atomic file updates and locking
- 🧩 **CLI and typed API** — use the package from shell scripts, VSCode extensions, Node services, or test runners
- 🧪 **Fake-backed E2E coverage** — snapshot and stream flows are verified without live SAP access

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/cf-logs

# Or as a dependency
npm install @saptools/cf-logs
# pnpm add @saptools/cf-logs
# yarn add @saptools/cf-logs
```

> [!NOTE]
> Requires **Node.js >= 20** and the official **`cf` CLI** on `PATH`.

---

## 🚀 Quick Start

```bash
# 1. Export credentials used for cf api/auth
export SAP_EMAIL="operator@example.test"
export SAP_PASSWORD="credential-placeholder"

# 2. Fetch a structured snapshot
cf-logs snapshot \
  --region ap10 \
  --org sample-org \
  --space sample \
  --app demo-app \
  --json

# 3. Start a live stream as line-delimited JSON events
cf-logs stream \
  --region ap10 \
  --org sample-org \
  --space sample \
  --app demo-app \
  --json

# 4. Stream compact rows and keep refs for drill-down
cf-logs stream \
  --region ap10 \
  --org sample-org \
  --space sample \
  --app demo-app \
  --compact \
  --save
```

If you already know the CF API endpoint, replace `--region ap10` with `--api-endpoint https://api.cf.ap10.hana.ondemand.com`.

---

## 🧰 CLI

### Shared targeting flags

Most commands use the same target shape:

| Flag | Description |
| --- | --- |
| `--region <key>` | CF region key such as `ap10` |
| `--api-endpoint <url>` | Explicit CF API endpoint instead of a region key |
| `--org <name>` | CF org name |
| `--space <name>` | CF space name |
| `--app <name>` | CF app name |
| `--email <value>` | Override `SAP_EMAIL` |
| `--password <value>` | Override `SAP_PASSWORD` |

`--region` or `--api-endpoint` is required. Credentials default to `SAP_EMAIL` and `SAP_PASSWORD`.

> [!WARNING]
> Prefer the environment variables over `--password <value>`. Process arguments are visible to other users on the machine via tools like `ps`, so passing credentials inline can leak them. The `--password` flag is kept as an explicit override for one-off scripts only.

### `cf-logs snapshot`

Fetch recent logs for one app. By default the command prints bounded raw text. Use `--json` for structured rows, `--compact` for condensed output, and `--save` to persist. Cloud Foundry controls the `--recent` window; `--since`, `--search`, and `--min-level` filter rows after those logs are returned.

```bash
cf-logs snapshot \
  --region ap10 \
  --org sample-org \
  --space sample \
  --app demo-app \
  --json \
  --save
```

| Flag | Description |
| --- | --- |
| `--json` | Emit a full JSON snapshot object |
| `--compact` | Emit compact rows instead of raw text or a full snapshot |
| `--compact-message-limit <count>` | Maximum characters per compact message/body (default: 500) |
| `--compact-ttl-minutes <count>` | Minutes before compact drill-down refs expire (default: 60) |
| `--save` | Persist to the local store; with `--compact`, create temporary full-row refs instead |
| `--since <duration>` | Filter rows after CF returns recent logs; accepts `15m`, `45m`, `1h`, or `1d` |
| `--search <text>` | Keep rows matching text case-insensitively |
| `--min-level <level>` | Keep rows at or above `trace`, `debug`, `info`, `warn`, `error`, or `fatal` |
| `--log-limit <count>` | Maximum parsed rows and bounded raw-text budget |

### `cf-logs stream`

Start a live log stream for one app. In JSON mode the command emits line-delimited events:

- `{"type":"state",...}`
- `{"type":"lines",...}`

```bash
cf-logs stream \
  --region ap10 \
  --org sample-org \
  --space sample \
  --app demo-app \
  --json
```

Useful stream options:

| Flag | Description |
| --- | --- |
| `--json` | Emit line-delimited JSON events |
| `--compact` | Emit compact parsed rows instead of raw CF lines |
| `--compact-message-limit <count>` | Maximum characters per compact message/body (default: 500) |
| `--compact-ttl-minutes <count>` | Minutes before compact drill-down refs expire (default: 60) |
| `--save` | Persist to the local store; with `--compact`, create temporary full-row refs instead |
| `--max-lines <count>` | Stop after emitting N streamed lines |
| `--search <text>` | Keep rows matching text case-insensitively |
| `--min-level <level>` | Keep rows at or above `trace`, `debug`, `info`, `warn`, `error`, or `fatal` |
| `--log-limit <count>` | Maximum parsed rows and bounded raw-text budget |
| `--flush-interval-ms <ms>` | Batch window before append events are emitted |
| `--retry-initial-ms <ms>` | Initial reconnect delay after unexpected stream exits |
| `--retry-max-ms <ms>` | Maximum reconnect delay |

### `cf-logs show`

Retrieve a full saved compact row by ref. Refs are emitted only when `--compact --save` is used.

```bash
cf-logs show 7f3a9c2b:42
cf-logs show 7f3a9c2b:42 --json
```

### `cf-logs session`

Inspect or clear temporary compact drill-down sessions. Sessions expire after 60 minutes by default.

```bash
cf-logs session list
cf-logs session list --json
cf-logs session prune
cf-logs session clear
```

### `cf-logs apps`

List started apps with running instances for one org/space.

```bash
cf-logs apps --region ap10 --org sample-org --space sample --json
```

### `cf-logs store path`

Print the package-managed log store path.

```bash
cf-logs store path
```

### `cf-logs store list`

Inspect cached store entries.

```bash
cf-logs store list
cf-logs store list --json
```

### `cf-logs store clear`

Remove every cached entry from the package-managed log store. The store file remains in place but is rewritten with an empty entries list.

```bash
cf-logs store clear
```

### `cf-logs --version`

Print the installed `@saptools/cf-logs` semantic version.

```bash
cf-logs --version
```

---

## 📁 Store File

The package-managed store lives here:

```text
~/.saptools/cf-logs-store.json
```

It contains bounded full-fidelity entries keyed by:

- `apiEndpoint`
- `org`
- `space`
- `app`

Each entry stores:

- `rawText`
- `fetchedAt`
- `updatedAt`
- `rowCount`
- `truncated`

The store is an implementation detail. Prefer `readStore()`, `persistSnapshot()`, `cf-logs store path`, or `cf-logs store list` over parsing the file directly.

---

## 🔐 Data Notes

- The CLI and runtime do not redact log content.
- Persisted snapshots are bounded and written with file locking plus atomic replace semantics.
- Store and session files can contain credentials, tokens, personal data, or business data if the application logs them.
- The store file and compact session files are not safe for public repositories.
- Compact mode reduces token volume only; it is not a privacy feature.
- Temporary compact sessions live under `~/.saptools/cf-logs-sessions/` and are pruned after their TTL.

---

## ❓ FAQ

<details>
<summary><b>Does this package depend on VSCode?</b></summary>

No. The package is intentionally UI-agnostic. It exposes a CLI, a runtime engine, normalization helpers, and store helpers that can be used by VSCode, terminal tools, tests, or backend processes.

</details>

<details>
<summary><b>Why separate this from an extension?</b></summary>

Because log normalization, streaming, compact projection, and store management are reusable engine concerns. Keeping them in a package makes the IDE layer smaller, easier to test, and easier to evolve.

</details>

<details>
<summary><b>Does <code>snapshot</code> or <code>stream</code> save data automatically?</b></summary>

No. Persistence is opt-in. Use `--save` in the CLI or enable `persistSnapshots` / `persistStreamAppends` in `CfLogsRuntime`.

</details>

<details>
<summary><b>Can I use an explicit API endpoint instead of a region key?</b></summary>

Yes. Pass `--api-endpoint <url>` in the CLI or `apiEndpoint` in the Node.js API.

</details>

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-logs cspell
pnpm --filter @saptools/cf-logs lint
pnpm --filter @saptools/cf-logs typecheck
pnpm --filter @saptools/cf-logs test:unit
pnpm --filter @saptools/cf-logs test:e2e
pnpm --filter @saptools/cf-logs build
pnpm --filter @saptools/cf-logs check
```

---

## 🤝 Author

Maintained by [dongtran](https://github.com/dongitran).
