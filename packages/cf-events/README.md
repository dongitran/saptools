<div align="center">

# ☁️ `@saptools/cf-events`

**Inspect SAP BTP Cloud Foundry application audit events and detect active SSH/debug sessions from the command line.**

Point it at a `region/org/space/app` (or a bare app name) and instantly answer: "what just happened?", "is anyone SSH'd in right now?", or "why did it crash?".

[![npm version](https://img.shields.io/npm/v/@saptools/cf-events.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-events)
[![license](https://img.shields.io/npm/l/@saptools/cf-events.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-events.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/cf-events)](https://packagephobia.com/result?p=@saptools/cf-events)
[![types](https://img.shields.io/npm/types/@saptools/cf-events.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 📜 **Audit event inspection** — list recent `audit.app.*` events (start/stop, scale, restarts, restage, route changes, env views, crashes, SSH authz)
- 🔐 **SSH & debug session detection** — surface authorized sessions + denied attempts; infer "likely active" ones from recent `ssh-authorized` events (CF has no live session or close events)
- 💥 **Crash summaries** — count, last crash time/reason/exit code, and per-instance detail
- ❤️ **One-glance status** — requested state, per-instance CPU/mem/uptime, SSH flag, and the most recent audit event
- 👀 **Live watch** — poll `/v3/audit_events` on an interval and stream new events (Ctrl+C to stop)
- 🧭 **Smart selectors** — full `region/org/space/app` or bare app name (resolved via the `cf-sync` snapshot; falls back to current `cf target` for bare names)
- 🔄 **Reuses cf-sync** — topology snapshot + current-target helpers from [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync)
- 🧪 **Isolated sessions** — every invocation uses a fresh ephemeral `CF_HOME`; never touches your interactive login
- 🧩 **CLI + typed library** — full TypeScript exports for `CfEventsRuntime`, parsers, formatters, and types
- 🪶 **Zero daemon, tiny deps** — commander + cf-sync only

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/cf-events

# Or use on demand
npx @saptools/cf-events --help

# As a library
npm install @saptools/cf-events
# pnpm add @saptools/cf-events
```

> [!NOTE]
> Requires **Node.js ≥ 20** and the official **Cloud Foundry CLI (v8+)** on `PATH`.

---

## 🚀 Quick Start

```bash
# 1. Provide SAP SSO credentials (used only for live CF calls)
export SAP_EMAIL="you@company.com"
export SAP_PASSWORD="your-sap-password"

# 2. Make sure you have a topology snapshot (or be logged into a CF target)
cf-sync sync --only ap10   # or cf-sync space ap10 my-org dev

# 3. Inspect events
cf-events events orders-srv
cf-events events ap10/my-org/dev/orders-srv --limit 100 --since 6h

# 4. Check for active SSH/debug sessions
cf-events ssh-status orders-srv --since 7d

# 5. Summarize recent crashes
cf-events crashes orders-srv

# 6. Quick health view
cf-events status orders-srv

# 7. Stream new events live
cf-events watch orders-srv --type crash
```

After a `cf-sync` snapshot exists, bare app names are resolved automatically (with current `cf target` expansion when no `/` present).

---

## 🧰 CLI

All commands accept a single positional **selector**:

- Full path: `ap10/my-org/dev/orders-srv`
- Bare app name: `orders-srv` — resolved against the cf-sync snapshot (and current `cf target` when the name is unique within the target scope). Ambiguous names list the candidates and fail.

Common credential flags (all commands):

| Flag            | Description                                      |
|-----------------|--------------------------------------------------|
| `--email`       | SAP email (falls back to `SAP_EMAIL` env)        |
| `--password`    | SAP password (falls back to `SAP_PASSWORD` env)  |
| `--json`        | Emit JSON instead of human text                  |

### `events <selector>`

List recent audit events for the app (deployments, restarts, scaling, crashes, SSH, routes, ...).

```bash
cf-events events ap10/my-org/dev/orders-srv
cf-events events orders-srv --limit 100 --since 6h
cf-events events orders-srv --type ssh --json
cf-events events orders-srv --type audit.app.start,audit.app.stop
```

| Flag     | Description                                      |
|----------|--------------------------------------------------|
| `--limit <n>` | Max events (default 50)                       |
| `--since <dur>` | Only newer than duration (e.g. `30m`, `6h`, `7d`) |
| `--type <types>` | Comma list of types or shorthands `ssh` / `crash` |

### `ssh-status <selector>`

Show the SSH-enabled flag for the app + recent SSH / debug activity (who authorized when) and denied attempts. Marks sessions that are "likely active" (within the last 60 minutes of an `ssh-authorized` event).

```bash
cf-events ssh-status orders-srv
cf-events ssh-status orders-srv --since 7d --json
```

| Flag          | Description                             |
|---------------|-----------------------------------------|
| `--since <dur>` | Look-back window (default `24h`)     |

> [!IMPORTANT]
> Cloud Foundry does not expose live sessions or emit `ssh-unauthorized` / close events. `cf-events` **infers** likely-active sessions from recent `audit.app.ssh-authorized` records. Treat as a strong signal, not definitive proof.

### `crashes <selector>`

Count and detail recent crash events (both `audit.app.crash` and `audit.app.process.crash`).

```bash
cf-events crashes orders-srv
cf-events crashes orders-srv --since 24h --json
```

| Flag          | Description                              |
|---------------|------------------------------------------|
| `--limit <n>` | Max crash events to inspect (default 50) |
| `--since <dur>` | Filter window                         |

### `status <selector>`

Compact health snapshot: GUID, requested state, SSH flag, instance table (index / state / uptime / cpu / mem), and the single most recent audit event.

```bash
cf-events status orders-srv
cf-events status orders-srv --json
```

### `watch <selector>`

Poll `/v3/audit_events` repeatedly and print (or emit NDJSON) fresh events as they arrive. Press Ctrl+C to stop.

```bash
cf-events watch orders-srv
cf-events watch orders-srv --interval 30000 --type crash --lookback 5m
```

| Flag             | Description                                      |
|------------------|--------------------------------------------------|
| `--interval <ms>` | Poll interval (default 15000, min 2000)         |
| `--lookback <dur>` | Initial fetch window on start (default `2m`)  |
| `--type <types>`  | Filter (supports `ssh` / `crash` shorthands)    |
| `--json`          | Line-delimited JSON output                      |

---

## 🧑‍💻 Programmatic Usage

```ts
import {
  CfEventsRuntime,
  // also re-exported for advanced use:
  // fetchAuditEvents, fetchApp, fetchSshEnabled, fetchWebProcessStats,
  // parseTypeFilter, durationToCreatedAfter,
  // formatEventsReport, formatSshStatusReport, formatCrashReport, formatStatusReport,
  // resolveSelector, parseSelector,
  // plus all types
} from "@saptools/cf-events";

const runtime = new CfEventsRuntime();

const events = await runtime.fetchEvents("orders-srv", {
  email: process.env.SAP_EMAIL ?? "",
  password: process.env.SAP_PASSWORD ?? "",
}, {
  limit: 50,
  since: "6h",
  types: [], // or ["audit.app.crash"] or use parseTypeFilter("crash")
});

console.log(events.length);

// SSH inference + enabled flag
const ssh = await runtime.getSshStatus("orders-srv", creds, "24h");

// Crash summary
const crashes = await runtime.getCrashes("orders-srv", creds, { limit: 20 });

// Health + instances
const health = await runtime.getStatus("ap10/my-org/dev/orders-srv", creds);

// Live polling (call with AbortSignal)
const ac = new AbortController();
await runtime.watchEvents("orders-srv", creds, { intervalMs: 15000, lookback: "2m", types: [] }, (ev) => {
  console.log(ev);
}, ac.signal);
```

The package is a full barrel; everything under `src/` (parsers, formatters, low-level CF session helpers, types) is exported for power users or custom tooling.

---

## 📁 Prerequisites & Snapshots

`cf-events` relies on a `cf-sync` snapshot at `~/.saptools/cf-structure.json` for bare-app-name resolution and validation of explicit paths.

- Run `cf-sync sync`, `cf-sync space ...`, or `cf-sync org ...` at least once.
- When you pass a bare app name, `cf-events` will also consult your current `cf target` (via `cf target` output) to build a full selector before validating against the snapshot.
- Pure `--json` + explicit full selectors still require the snapshot for safety.

All CF operations run inside a throw-away `CF_HOME`. Your interactive `cf` login is never affected.

---

## ❓ FAQ

<details>
<summary><b>Do I need to run cf target first?</b></summary>

Not required. Pass a full selector or make sure a cf-sync snapshot exists. Bare names will try to use your current `cf target` output to expand into `region/org/space/app`.

</details>

<details>
<summary><b>Why "likely active" instead of real sessions?</b></summary>

Cloud Foundry's audit log only records authorization. There is no "session closed" or live-process table exposed via the APIs `cf-events` consumes. The 60-minute window after `ssh-authorized` is a documented heuristic.

</details>

<details>
<summary><b>What durations are accepted?</b></summary>

`30s`, `5m`, `6h`, `7d` (positive integers + s/m/h/d). Used by `--since` and `--lookback`.

</details>

<details>
<summary><b>Can I filter only crashes or only SSH?</b></summary>

Yes: `--type crash` or `--type ssh`. You can also pass comma-separated full types: `--type audit.app.crash,audit.app.process.crash`.

</details>

<details>
<summary><b>Is the snapshot required even for JSON output?</b></summary>

Yes for safety and consistent resolution. The snapshot is the single source of truth for which apps exist in which spaces.

</details>

---

## 🛠️ Development

From monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-events build
pnpm --filter @saptools/cf-events typecheck
pnpm --filter @saptools/cf-events lint
pnpm --filter @saptools/cf-events test:unit
pnpm --filter @saptools/cf-events test:e2e
pnpm --filter @saptools/cf-events check   # cspell + lint + type + unit + e2e
```

E2E tests are fully fake-backed (no real CF or credentials needed).

---

## 🌐 Related

- 🗺️ [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — the topology snapshot and current-target helpers that power selector resolution
- 🔐 [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa)
- 🐛 [`@saptools/cf-debugger`](https://www.npmjs.com/package/@saptools/cf-debugger)
- Full toolbox: [saptools monorepo](https://github.com/dongitran/saptools)

---

## 👨‍💻 Author

**Dong Tran**

## 📄 License

MIT

---

Made with ❤️ for SAP BTP CF developers.
