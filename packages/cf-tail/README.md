<div align="center">

# 🛰️ `@saptools/cf-tail`

**Tail every app in a Cloud Foundry space at once — chronologically merged, filtered, and redacted.**

Built on top of [`@saptools/cf-logs`](../cf-logs). Discover all started apps in
a `region/org/space`, fetch their recent logs in parallel, and stream them live
into a single multiplexed feed with strong filtering and bounded local
persistence.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-tail.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-tail)
[![license](https://img.shields.io/npm/l/@saptools/cf-tail.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-tail.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [Store](#-store-file) • [Security](#-security-notes)

</div>

---

## ✨ Features

- 📥 **Space-wide snapshots** — fetch recent logs for every started app in a CF
  space in parallel, with a configurable concurrency limit.
- 🧬 **Chronological merge** — every row carries its `appName` and rows from all
  apps are merged by timestamp into a single timeline.
- 📡 **Multiplexed live stream** — one `cf-tail stream` process tails every app
  at once, with per-app color, prefixed labels, and auto-rediscovery as apps
  appear or disappear.
- 🎯 **Powerful selection** — `--apps a,b`, `--include-regex`, `--exclude`,
  `--exclude-regex` to scope the fan-out.
- 🧰 **Cross-app filtering** — level, search, source, tenant, status range,
  stream (`out`/`err`), `--since`/`--until` time windows, `--max-rows`.
- 📊 **Summary view** — `cf-tail summary` aggregates level counts, source
  buckets, status buckets, tenants, first/last timestamps per app.
- 🚨 **Errors shortcut** — `cf-tail errors` is `snapshot --level error` across
  the whole space.
- 🔐 **Redaction** — SAP credentials are redacted before any output or
  persistence; you can add custom secrets via `--extra-secret` or programmatic
  options.
- 🗃️ **Bounded local store** — aggregate snapshots cached at
  `~/.saptools/cf-tail-store.json` with atomic writes and locking. Per-app raw
  logs continue to live in the cf-logs store.
- 🧪 **Fake-backed e2e** — discovery, snapshot, stream, summary flows all pass
  without live SAP access.

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/cf-tail

# Or as a dependency
npm install @saptools/cf-tail
# pnpm add @saptools/cf-tail
# yarn add @saptools/cf-tail
```

> [!NOTE]
> Requires **Node.js >= 20** and the official **`cf` CLI** on `PATH`.

---

## 🚀 Quick Start

```bash
# 1. Export credentials used for cf api/auth
export SAP_EMAIL="sample@example.com"
export SAP_PASSWORD="sample-password"

# 2. List every started app in a space
cf-tail apps --region ap10 --org sample-org --space sample

# 3. One-shot snapshot of every app, merged by timestamp
cf-tail snapshot --region ap10 --org sample-org --space sample

# 4. Live tail of every app, with per-app colors
cf-tail stream --region ap10 --org sample-org --space sample
```

---

## 🧰 CLI

### Shared session flags

| Flag | Description |
| --- | --- |
| `--region <key>` | CF region key such as `ap10` |
| `--api-endpoint <url>` | Explicit CF API endpoint instead of a region key |
| `--org <name>` | CF org name |
| `--space <name>` | CF space name |
| `--email <value>` | Override `SAP_EMAIL` |
| `--password <value>` | Override `SAP_PASSWORD` |

### App-selection flags

| Flag | Description |
| --- | --- |
| `--apps <a,b>` | Comma-separated app names to include (alias for `--include`) |
| `--include <name>` | Include a specific app name (repeatable) |
| `--exclude <name>` | Exclude a specific app name (repeatable) |
| `--include-regex <pattern>` | Include apps matching the regex (repeatable) |
| `--exclude-regex <pattern>` | Exclude apps matching the regex (repeatable) |

### Row filter flags (snapshot, errors, summary, stream)

| Flag | Description |
| --- | --- |
| `--level <name>` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `all` |
| `--search <text>` | Case-insensitive substring filter against the searchable row text |
| `--source <text>` | Filter rows whose CF source contains the given text |
| `--tenant <id>` | Filter rows whose parsed router tenant id matches |
| `--status <range>` | Filter router status: `500`, `5xx`, or `400-499` |
| `--stream <value>` | Filter by `out`, `err`, or `all` |
| `--since <duration>` | Keep rows newer than `now - duration` (e.g. `30s`, `5m`, `1h`) |
| `--until <duration>` | Drop rows older than `now - duration` |
| `--max-rows <count>` | Maximum rows in the rendered output |
| `--newest-first` | Render newest-first instead of oldest-first |

### Output flags

| Flag | Description |
| --- | --- |
| `--json` | Emit a single structured JSON object (snapshot, summary) |
| `--ndjson` | Emit line-delimited JSON rows (snapshot, stream) |
| `--by-app` | Group rendered rows by app instead of merged timeline |
| `--no-color` | Disable ANSI colors. Honors `NO_COLOR` env; `FORCE_COLOR` overrides for non-TTY pipelines |
| `--show-source` | Include the CF source segment in text output |
| `--truncate <chars>` | Truncate text-mode messages longer than the given character count |

### Redaction flags

| Flag | Description |
| --- | --- |
| `--extra-secret <value>` | Add a custom redaction (repeatable). Each occurrence is replaced with `***` in output and storage |

### `cf-tail apps`

```bash
cf-tail apps \
  --region ap10 \
  --org sample-org \
  --space sample \
  --include-regex "^demo-" \
  --exclude demo-canary \
  --json
```

### `cf-tail snapshot`

Fetches recent logs for every matching app in parallel, merges into a single
chronological timeline, applies row filters, and optionally persists.

```bash
cf-tail snapshot \
  --region ap10 \
  --org sample-org \
  --space sample \
  --apps demo-app,api-app \
  --level error \
  --since 30m \
  --max-rows 100 \
  --json
```

| Snapshot-only flag | Description |
| --- | --- |
| `--save` | Persist redacted per-app snapshots to the cf-logs store and an aggregate entry to the cf-tail store |
| `--concurrency <n>` | Maximum apps fetched in parallel (default 4) |
| `--log-limit <count>` | Maximum parsed rows and bounded raw-text size per app |

### `cf-tail errors`

Shortcut for `snapshot --level error`:

```bash
cf-tail errors --region ap10 --org sample-org --space sample --since 1h
```

### `cf-tail summary`

Aggregate counts for every matching app:

```bash
cf-tail summary \
  --region ap10 \
  --org sample-org \
  --space sample \
  --json
```

### `cf-tail stream`

Multiplex live logs for every matching app. By default, the runtime
re-discovers the app list every 30 seconds, picking up newly started apps and
dropping stopped ones. Use `--rediscover off` (or `--rediscover 0s`) to disable.

```bash
cf-tail stream \
  --region ap10 \
  --org sample-org \
  --space sample \
  --include-regex "^api-" \
  --rediscover 60s
```

| Stream-only flag | Description |
| --- | --- |
| `--max-lines <count>` | Stop after emitting N rows |
| `--rediscover <duration>` | Re-discover the app list at this interval (e.g. `30s`, `2m`, `off`) |
| `--flush-interval-ms <ms>` | Batch window before append events are emitted |
| `--retry-initial-ms <ms>` | Initial reconnect delay after unexpected stream exits |
| `--retry-max-ms <ms>` | Maximum reconnect delay |
| `--log-limit <count>` | Maximum parsed rows and bounded raw-text size per app |
| `--save` | Persist bounded redacted stream appends into the cf-logs store |
| `-q, --quiet` | Suppress discovery and stream-state messages on stderr (text mode only) |

### `cf-tail store path | list | clear`

```bash
cf-tail store path
cf-tail store list
cf-tail store list --json
cf-tail store clear
```

### `cf-tail --version`

Prints the installed `@saptools/cf-tail` semantic version.

---

## 🧑‍💻 Programmatic Usage

### Multi-app snapshot

```ts
import { fetchMultiSnapshot, filterTailRows, summarizeRows } from "@saptools/cf-tail";

const result = await fetchMultiSnapshot({
  region: "ap10",
  org: "sample-org",
  space: "sample",
  email: process.env["SAP_EMAIL"] ?? "",
  password: process.env["SAP_PASSWORD"] ?? "",
  includeRegex: ["^api-"],
  concurrency: 6,
  persist: true,
});

const errors = filterTailRows(result.merged, {
  level: "error",
  sinceMs: 60 * 60 * 1000,
});
const summary = summarizeRows(result.merged);
console.log(summary.total, errors.length);
```

### Multiplexed stream

```ts
import { CfTailRuntime } from "@saptools/cf-tail";

const runtime = new CfTailRuntime({
  rediscoverIntervalMs: 30_000,
  flushIntervalMs: 150,
});

runtime.setSession({
  region: "ap10",
  email: process.env["SAP_EMAIL"] ?? "",
  password: process.env["SAP_PASSWORD"] ?? "",
  org: "sample-org",
  space: "sample",
});

runtime.setAppFilter({ includeRegex: ["^demo-"] });

runtime.subscribe((event) => {
  if (event.type === "lines") {
    process.stdout.write(`[${event.appName}] ${event.lines.join("\n")}\n`);
  }
  if (event.type === "discovery") {
    process.stderr.write(
      `[discovery] +${event.addedApps.length} -${event.removedApps.length}\n`,
    );
  }
});

await runtime.start();

process.once("SIGINT", () => {
  void runtime.stop();
});
```

### Lower-level helpers

```ts
import {
  buildAppFilter,
  applyAppFilter,
  discoverMatchingApps,
  fetchSnapshotsForApps,
  mergeAppRows,
} from "@saptools/cf-tail";

const apps = await discoverMatchingApps({
  region: "ap10",
  email: process.env["SAP_EMAIL"] ?? "",
  password: process.env["SAP_PASSWORD"] ?? "",
  org: "sample-org",
  space: "sample",
  excludeRegex: ["-canary$"],
});

const filter = buildAppFilter({ excludeRegex: ["-canary$"] });
const allowed = applyAppFilter(apps, filter);

const result = await fetchSnapshotsForApps({
  session: {
    region: "ap10",
    email: process.env["SAP_EMAIL"] ?? "",
    password: process.env["SAP_PASSWORD"] ?? "",
    org: "sample-org",
    space: "sample",
  },
  apps: allowed,
  concurrency: 4,
});

const rowsByApp = new Map(result.apps.map((entry) => [entry.appName, entry.rows]));
const timeline = mergeAppRows(rowsByApp);
console.log(timeline.length);
```

---

## 📁 Store File

The aggregate cf-tail store lives here:

```text
~/.saptools/cf-tail-store.json
```

It contains one entry per `(apiEndpoint, org, space)` with:

- `fetchedAt`, `updatedAt`
- `appCount`, `rowCount`
- `apps: [{ appName, rowCount, truncated }, ...]`

Per-app raw text continues to live in the existing cf-logs store at
`~/.saptools/cf-logs-store.json` (used when you pass `--save`). The cf-tail
store is metadata only.

Prefer `readTailStore()`, `persistTailSnapshot()`, `cf-tail store path`, or
`cf-tail store list` over parsing the file directly.

---

## 🔐 Security Notes

- The runtime redacts the current SAP email and password before emitting or
  persisting log content. Pass `extraSecrets` (programmatic) or
  `--extra-secret <value>` (CLI, repeatable) to add custom redaction rules.
- Persisted snapshots are bounded and written with file locking plus atomic
  replace semantics.
- Neither store file is safe for public repositories. Even after redaction,
  they still reveal app names, org names, spaces, endpoints, and log content.
- If your application logs contain additional secrets beyond SAP credentials,
  add custom runtime redaction rules before persisting or forwarding output.

---

## ❓ FAQ

<details>
<summary><b>How is this different from <code>@saptools/cf-logs</code>?</b></summary>

`cf-logs` is single-app focused: one `--app` per CLI invocation, one key per
store entry, one redaction set. `cf-tail` is multi-app: discovery, parallel
snapshot, multiplexed live stream, chronological merge, cross-app filtering,
and an aggregate store. It builds on `cf-logs`, not against it.

</details>

<details>
<summary><b>Do I still need <code>cf-logs</code> installed?</b></summary>

`cf-tail` depends on `@saptools/cf-logs` automatically. Install
`@saptools/cf-tail` and you get both.

</details>

<details>
<summary><b>Does <code>stream</code> automatically pick up new apps?</b></summary>

Yes — every `--rediscover` interval the runtime re-runs `cf apps`, computes the
diff, starts streams for new apps, and stops streams for apps that are no
longer started.

</details>

<details>
<summary><b>How do I scope to a single app?</b></summary>

`--apps demo-app` (or `--include demo-app`). Same shape as `cf-logs`'s
single-app commands once you scope down.

</details>

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-tail cspell
pnpm --filter @saptools/cf-tail lint
pnpm --filter @saptools/cf-tail typecheck
pnpm --filter @saptools/cf-tail test:unit
pnpm --filter @saptools/cf-tail test:e2e
pnpm --filter @saptools/cf-tail build
pnpm --filter @saptools/cf-tail check
```

---

## 🤝 Author

Maintained by [dongtran](https://github.com/dongitran).
