<div align="center">

# ☁️ `@saptools/cf-events`

**Inspect SAP BTP Cloud Foundry application and space audit events and detect active SSH/debug sessions from the command line.**

Point it at a `region/org/space/app`, `region/org/space`, or a bare app name and instantly answer: "what just happened?", "is anyone SSH'd in right now?", or "why did it crash?".

[![npm version](https://img.shields.io/npm/v/@saptools/cf-events.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-events)
[![license](https://img.shields.io/npm/l/@saptools/cf-events.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-events.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/cf-events)](https://packagephobia.com/result?p=@saptools/cf-events)
[![types](https://img.shields.io/npm/types/@saptools/cf-events.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 📜 **Audit event inspection** — list recent `audit.app.*` events for one app or all apps in a space
- 🔐 **SSH & debug session detection** — surface authorized sessions + denied attempts; infer "likely active" ones from recent `ssh-authorized` events (CF has no live session or close events)
- 💥 **Crash summaries** — count, last crash time/reason/exit code, and per-instance detail for an app or grouped by app across a space
- ❤️ **One-glance status** — requested state, per-instance CPU/mem/uptime, SSH flag, and the most recent audit event
- 👀 **Live watch** — poll `/v3/audit_events` on an interval and stream new events (Ctrl+C to stop)
- 🧭 **Smart selectors** — full app selectors (`region/org/space/app`), space selectors (`region/org/space`), or bare app names resolved from the current `cf target`
- 🧪 **Isolated sessions** — every invocation uses a fresh ephemeral `CF_HOME`; never touches your interactive login
- 🧩 **CLI + typed library** — full TypeScript exports for `CfEventsRuntime`, parsers, formatters, and types
- 🪶 **Zero daemon, tiny deps** — commander only

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

# 2. Inspect events
cf-events events orders-srv
cf-events events ap10/my-org/dev/orders-srv --limit 100 --since 6h
cf-events events ap10/my-org/dev --limit 200 --since 6h

# 4. Check for active SSH/debug sessions
cf-events ssh-status orders-srv --since 7d

# 5. Summarize recent crashes
cf-events crashes orders-srv

# 6. Quick health view
cf-events status orders-srv

# 7. Stream new events live
cf-events watch orders-srv --type crash
```

Bare app names use the current `cf target` for org/space/API context. Explicit app and space selectors do not require a topology snapshot.

---

## 🧰 CLI

All commands accept a single positional **selector**. `events`, `watch`, and `crashes` accept app or space selectors; `status` and `ssh-status` require an app selector.

- App path: `ap10/my-org/dev/orders-srv`
- Space path: `ap10/my-org/dev`
- Bare app name: `orders-srv` — resolved against the current `cf target`. Bare single-segment selectors are always app names, never spaces.

Common credential flags (all commands):

| Flag            | Description                                      |
|-----------------|--------------------------------------------------|
| `--email`       | SAP email (falls back to `SAP_EMAIL` env)        |
| `--password`    | SAP password (falls back to `SAP_PASSWORD` env)  |
| `--json`        | Emit JSON instead of human text                  |

### `events <selector>`

List recent audit events for the app or all apps in a space (deployments, restarts, scaling, crashes, SSH, routes, ...).

```bash
cf-events events ap10/my-org/dev/orders-srv
cf-events events orders-srv --limit 100 --since 6h
cf-events events orders-srv --type ssh --json
cf-events events orders-srv --type audit.app.start,audit.app.stop
cf-events events ap10/my-org/dev --type ssh --json
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

Count and detail recent crash events for an app or grouped by target app across a space (both `audit.app.crash` and `audit.app.process.crash`).

```bash
cf-events crashes orders-srv
cf-events crashes orders-srv --since 24h --json
cf-events crashes ap10/my-org/dev --since 24h --json
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

Poll `/v3/audit_events` repeatedly for an app or space and print (or emit NDJSON) fresh events as they arrive. Press Ctrl+C to stop.

```bash
cf-events watch orders-srv
cf-events watch orders-srv --interval 30000 --type crash --lookback 5m
cf-events watch ap10/my-org/dev --lookback 5m --type crash --json
```

| Flag             | Description                                      |
|------------------|--------------------------------------------------|
| `--interval <ms>` | Poll interval (default 15000, min 2000)         |
| `--lookback <dur>` | Initial fetch window on start (default `2m`)  |
| `--type <types>`  | Filter (supports `ssh` / `crash` shorthands)    |
| `--json`          | Line-delimited JSON output                      |

---

## 📁 Prerequisites & Selector Resolution

`cf-events` uses direct CF CLI/API calls and an isolated throw-away `CF_HOME`; it does not read or validate a `cf-sync` snapshot.

- Explicit app selectors (`region/org/space/app`) and space selectors (`region/org/space`) use the built-in SAP BTP region-to-API map, then authenticate and target that org/space.
- Bare app names use your current interactive `cf target` only to discover API endpoint, org, and space, then resolve the app GUID inside the isolated session.
- Space-wide audit event queries use the Cloud Foundry v3 `space_guids` audit-event filter after resolving org and space GUIDs with `/v3/organizations?names=...` and `/v3/spaces?names=...&organization_guids=...`.

For JSON output, `events --json` returns the same raw audit-event array shape for app and space selectors. Space events include target, space, and organization references from the CF response. `watch --json` emits newline-delimited JSON events.

## ❓ FAQ

<details>
<summary><b>Do I need to run cf target first?</b></summary>

Not required for explicit selectors. Bare app names require a current `cf target` so `cf-events` can discover the API endpoint, org, and space.

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

No. `cf-events` does not read a snapshot. Explicit selectors are resolved with the region map and live CF API/CLI calls; bare app names use the current `cf target`.

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

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

---

## 🌐 Related

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
