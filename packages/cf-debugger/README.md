<div align="center">

# 🐛 `@saptools/cf-debugger`

**Open a Node.js inspector tunnel to any SAP BTP Cloud Foundry app — in one command.**

Signal the remote process, enable SSH if needed, forward `9229` to a free local port, and hand you back a ready-to-attach debugger — with first-class support for **multiple concurrent tunnels** across terminals.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-debugger.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-debugger)
[![license](https://img.shields.io/npm/l/@saptools/cf-debugger.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-debugger.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/cf-debugger)](https://packagephobia.com/result?p=@saptools/cf-debugger)
[![types](https://img.shields.io/npm/types/@saptools/cf-debugger.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [How it works](#-how-it-works) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🚀 **One-shot tunnel** — auth, target, SSH-enable, USR1 signal, port forward, readiness probe — all hidden behind `cf-debugger start`
- 🧵 **Multi-debugger concurrency** — run N debuggers for N apps at once; each session gets its own local port, isolated `CF_HOME`, and an entry in the shared state file
- 🛡️ **Duplicate-session protection** — the same `region/org/space/app` cannot be debugged twice simultaneously (returns `SESSION_ALREADY_RUNNING`)
- 🧹 **Crash-proof state** — stale session entries are auto-pruned on next read using PID liveness checks
- 🔌 **Deterministic ports** — auto-assigned from a safe range (`20000–20999`), or pick your own with `--port`
- 🧩 **CLI & typed API** — every command has a zero-config Node.js equivalent with full TypeScript definitions
- 🪶 **Small + boring** — one runtime dep (`commander`), no daemons, no magic

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/cf-debugger

# Or as a dependency
npm install @saptools/cf-debugger
# pnpm add @saptools/cf-debugger
# yarn add @saptools/cf-debugger
```

> [!NOTE]
> Requires **Node.js ≥ 20** and the official **`cf` CLI** on `PATH` (v8 recommended).

---

## 🚀 Quick Start

```bash
# 1. Export your SAP SSO credentials (used for `cf auth` under the hood)
export SAP_EMAIL="you@company.com"
export SAP_PASSWORD="your-sap-password"

# 2. Open a debug tunnel for one app
cf-debugger start \
  --region eu10 \
  --org my-org \
  --space dev \
  --app my-srv \
  --verbose

# → Debugger ready for my-srv (eu10/my-org/dev).
#     Local port:  20142
#     Remote port: 9229
#     Session id:  01HXYZ...
#     PID:         83421
#   Press Ctrl+C to stop.

# 3. Attach your IDE (VSCode, Chrome DevTools, ...) to localhost:20142
```

Ctrl+C cleans everything up — the SSH subprocess is killed, the local port is released, and the session is removed from the shared state file.

---

## 🧰 CLI

### ▶️ `cf-debugger start`

Open a tunnel for one app and keep running until interrupted.

```bash
cf-debugger start --region eu10 --org my-org --space dev --app my-srv
cf-debugger start --region eu10 --org my-org --space dev --app my-srv --port 9230
cf-debugger start --region eu10 --org my-org --space dev --app my-srv --timeout 60 --verbose
```

| Flag | Description |
| --- | --- |
| `--region <key>` | **Required.** CF region key (e.g. `eu10`, `ap10`, `us10`) |
| `--org <name>` | **Required.** CF org name |
| `--space <name>` | **Required.** CF space name |
| `--app <name>` | **Required.** CF app name |
| `--port <number>` | Preferred local port (auto-assigned in `20000–20999` if omitted) |
| `--timeout <seconds>` | Tunnel-ready timeout (default: `30`) |
| `--verbose` | Print every status transition |

### ⏹️ `cf-debugger stop`

Stop a specific session or everything at once.

```bash
cf-debugger stop --region eu10 --org my-org --space dev --app my-srv
cf-debugger stop --session-id 01HXYZABCD...
cf-debugger stop --all
```

| Flag | Description |
| --- | --- |
| `--region` / `--org` / `--space` / `--app` | Match session by key (all four required together) |
| `--session-id <id>` | Match session by its ID |
| `--all` | Stop every active session on this machine |

### 📋 `cf-debugger list`

Print every active session this machine owns as JSON.

```bash
cf-debugger list | jq '.[] | {app, localPort, status}'
```

### 🔍 `cf-debugger status`

Print one session by key (or `null` if no active session matches).

```bash
cf-debugger status --region eu10 --org my-org --space dev --app my-srv
```

---

## 🧑‍💻 Programmatic Usage

```ts
import {
  startDebugger,
  stopDebugger,
  listSessions,
  getSession,
  resolveApiEndpoint,
} from "@saptools/cf-debugger";

const handle = await startDebugger({
  region: "eu10",
  org: "my-org",
  space: "dev",
  app: "my-srv",
  email: process.env["SAP_EMAIL"],
  password: process.env["SAP_PASSWORD"],
  verbose: true,
  onStatus: (status, message) => {
    console.log(`[${status}]`, message ?? "");
  },
});

console.log(`Attach your debugger to localhost:${handle.session.localPort}`);

// Later — shut the tunnel down and clean up state:
await handle.dispose();
```

<details>
<summary><b>📚 Full export list</b></summary>

| Export | Description |
| --- | --- |
| `startDebugger(options)` | Open a tunnel; returns a `DebuggerHandle` |
| `stopDebugger({ sessionId?, key? })` | Stop one session by id or by key |
| `stopAllDebuggers()` | Stop every session owned by this process/machine |
| `listSessions()` | Return every live session as `ActiveSession[]` |
| `getSession(key)` | Return one session matching `{ region, org, space, app }` |
| `resolveApiEndpoint(key, override?)` | Map a region key to its API endpoint |
| `sessionKeyString(key)` | Stable string form of a session key |
| `CfDebuggerError` | Rich error class with typed `code` |

</details>

<details>
<summary><b>🧪 Error codes</b></summary>

| Code | When |
| --- | --- |
| `MISSING_CREDENTIALS` | No `SAP_EMAIL` / `SAP_PASSWORD` in env or options |
| `SESSION_ALREADY_RUNNING` | A session already exists for the same `region/org/space/app` |
| `CF_LOGIN_FAILED` | `cf api` / `cf auth` rejected the credentials |
| `CF_TARGET_FAILED` | Org or space not reachable |
| `SSH_NOT_ENABLED` | SSH disabled at space or app level and could not be enabled |
| `USR1_SIGNAL_FAILED` | Remote `kill -s USR1` could not find the node PID |
| `TUNNEL_NOT_READY` | Inspector didn't respond on port 9229 before timeout |
| `PORT_UNAVAILABLE` | Preferred local port is taken and could not be freed |

</details>

---

## 🔭 How it works

```
┌────────────────────┐    1. cf api + cf auth (retry x3)
│ cf-debugger start  │    2. cf target -o <org> -s <space>
│  region/org/       │    3. cf ssh-enabled <app>
│  space/app         │ ─► 4. cf enable-ssh + cf restart (only if needed)
└────────────────────┘    5. cf ssh <app> -c 'kill -s USR1 $(pidof node)'
          │               6. cf ssh <app> -N -L <localPort>:localhost:9229
          ▼               7. TCP probe localhost:<localPort> until ready
    DebuggerHandle        8. Save ActiveSession to ~/.saptools/cf-debugger-state.json
```

Each step emits a status update (`logging-in`, `targeting`, `ssh-enabling`, `signaling`, `tunneling`, `ready`, …). `--verbose` prints them live; the programmatic API exposes the same stream via `onStatus`.

### Concurrency model

- **Atomic state** — `~/.saptools/cf-debugger-state.json` is written via temp-file + `rename`, guarded by a short-lived `.lock` file (`open(..., "wx")`).
- **Port allocation** — on register, ports already used by other sessions are excluded; the first free port in `20000–20999` wins.
- **Isolated CF homes** — each session runs with its own `CF_HOME` (`~/.saptools/cf-debugger-homes/<sessionId>/`), so `cf target` in one terminal can't clobber another.
- **Stale pruning** — reading the state file checks every recorded PID with `process.kill(pid, 0)`; dead entries are dropped before returning the list.
- **Duplicate guard** — trying to start a second tunnel for the same `region/org/space/app` fails fast with `SESSION_ALREADY_RUNNING` instead of racing for the port.

---

## 📁 Output Files

All state lives under your home directory:

```text
~/.saptools/cf-debugger-state.json       # active sessions (atomic JSON)
~/.saptools/cf-debugger-state.lock       # short-lived lock file
~/.saptools/cf-debugger-homes/<id>/      # per-session isolated CF_HOME
```

<details>
<summary><b>🔬 Shape of <code>cf-debugger-state.json</code></b></summary>

```jsonc
{
  "version": 1,
  "sessions": [
    {
      "sessionId": "01HXYZABCD...",
      "region": "eu10",
      "org": "my-org",
      "space": "dev",
      "app": "my-srv",
      "localPort": 20142,
      "remotePort": 9229,
      "pid": 83421,
      "status": "ready",
      "startedAt": "2026-04-18T00:00:00.000Z"
    }
  ]
}
```

</details>

> [!IMPORTANT]
> Prefer the CLI commands (`list` / `status`) or the exported APIs over parsing these files — the on-disk format is an implementation detail.

---

## ❓ FAQ

<details>
<summary><b>Can I run multiple debuggers at once?</b></summary>

Yes — that's a core feature. Open two terminals, pick two different apps, and both tunnels come up on separate local ports. `cf-debugger list` shows you everything at once. The only thing you can't do is debug the same app twice in parallel.

</details>

<details>
<summary><b>Does this modify the remote app?</b></summary>

Only if SSH is disabled. If it is, `cf-debugger` runs `cf enable-ssh` + `cf restart` to turn it on — otherwise it only sends a `SIGUSR1` to the Node.js process (which tells Node to start its inspector). No code, no env vars, no manifest is touched.

</details>

<details>
<summary><b>What if my app crashes while the tunnel is open?</b></summary>

The TCP probe will fail on reconnect and the CLI will exit with the SSH child's code. The state entry is removed on exit, so the next `start` for the same app works immediately.

</details>

<details>
<summary><b>Is there a way to reserve a specific local port?</b></summary>

Yes — pass `--port 9230` (CLI) or `preferredPort: 9230` (API). If it's occupied by a non-tunnel process, `cf-debugger` will try to free it once; if another tunnel already owns it, you'll get `PORT_UNAVAILABLE`.

</details>

<details>
<summary><b>Can I use this in CI for integration tests?</b></summary>

You can, but it's designed for interactive debugging. CI usually wants a short-lived request against the running app, not a persistent inspector tunnel — consider `cf ssh -L` directly for that case.

</details>

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-debugger build
pnpm --filter @saptools/cf-debugger typecheck
pnpm --filter @saptools/cf-debugger test:unit
pnpm --filter @saptools/cf-debugger test:e2e
```

The e2e suite hits live SAP BTP CF. Set `CF_DEBUGGER_E2E_REGIONS=eu10,ap10` (plus `SAP_EMAIL` / `SAP_PASSWORD`) to restrict which regions it searches for a running app.

---

## 🌐 Related

- ☁️ [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — snapshot every region / org / space / app you can reach into one JSON file
- 🔐 [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa) — fetch XSUAA credentials and cached OAuth2 tokens for any CF app
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
