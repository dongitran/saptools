<div align="center">

# 🐛 `@saptools/cf-debugger`

**Open a Node.js inspector tunnel to any SAP BTP Cloud Foundry app — in one command.**

Signal the remote process, enable SSH if needed, forward `9229` to a free local port, and hand you back a ready-to-attach debugger — with first-class support for **multiple concurrent tunnels** across terminals.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-debugger.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-debugger)
[![license](https://img.shields.io/npm/l/@saptools/cf-debugger.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-debugger.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/cf-debugger)](https://packagephobia.com/result?p=@saptools/cf-debugger)
[![types](https://img.shields.io/npm/types/@saptools/cf-debugger.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [How it works](#-how-it-works) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🚀 **One-shot tunnel** — auth, target, SSH-enable, USR1 signal, port forward, readiness probe — all hidden behind `cf-debugger start`
- 🧵 **Multi-debugger concurrency** — run N debuggers for N apps at once; each session gets its own local port, isolated `CF_HOME`, and an entry in the shared state file
- 🎯 **Exact process targeting** — select a CF process, instance, and optional Node PID; ambiguous Node processes fail closed
- 🛡️ **Duplicate-session protection** — the same `region/org/space/app/process/instance` cannot be debugged twice simultaneously (returns `SESSION_ALREADY_RUNNING`)
- 🧹 **Crash-proof state** — provably dead entries are pruned, while ownership mismatches are retained for safe recovery instead of being deleted blindly
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
> Requires **Node.js ≥ 20** and the official **`cf` CLI** on `PATH`. Default `web`
> process targets work with CF CLI v6+; non-web process targeting uses `--process` and requires
> CF CLI v7+ (v8 recommended).

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
  --app my-app \
  --verbose

# → Debugger ready for my-app (eu10/my-org/dev).
#     Local port:  20142
#     Remote port: 9229
#     Session id:  01HXYZ...
#     Tunnel PID:  83421
#   Press Ctrl+C to stop.

# 3. Attach your IDE (VSCode, Chrome DevTools, ...) to localhost:20142
```

Ctrl+C cleans everything up after tunnel termination is confirmed. If the PID or process group does
not terminate, `cf-debugger` reports an error and retains its state and isolated CF home for safe
recovery instead of hiding an unmanaged tunnel.

---

## 🧰 CLI

### ▶️ `cf-debugger start`

Open a tunnel for one app and keep running until interrupted.

```bash
cf-debugger start --region eu10 --org my-org --space dev --app my-app
cf-debugger start --region eu10 --org my-org --space dev --app my-app --port 9230
cf-debugger start --region eu10 --org my-org --space dev --app my-app --process worker --instance 2 --node-pid 4312
cf-debugger start --region eu10 --org my-org --space dev --app my-app --timeout 180 --verbose
```

| Flag | Description |
| --- | --- |
| `--region <key>` | **Required.** CF region key (e.g. `eu10`, `ap10`, `us10`) |
| `--org <name>` | **Required.** CF org name |
| `--space <name>` | **Required.** CF space name |
| `--app <name>` | **Required.** CF app name |
| `--process <name>` | CF process name (default: `web`) |
| `-i, --instance <index>` | Zero-based CF process instance (default: `0`) |
| `--node-pid <pid>` | Exact remote Node.js PID; otherwise one unambiguous PID is discovered |
| `--port <number>` | Preferred local port (auto-assigned in `20000–20999` if omitted) |
| `--timeout <seconds>` | Tunnel-ready timeout (default: `180`) |
| `--verbose` | Print every status transition |

Cloud Foundry startup commands (`api`, `auth`, `target`, SSH checks, app
restart, and the one-shot SIGUSR1 SSH command) each allow up to 300 seconds.
`--timeout` controls the subsequent local tunnel-readiness probe separately.

When `--node-pid` is explicit and SSH is disabled, `cf-debugger` fails with
`NODE_PID_RESTART_UNSAFE` before enabling SSH or restarting the app. A restart replaces the
container process identity, so enable SSH and restart manually, then resolve and pass the new PID.

### ⏹️ `cf-debugger stop`

Stop a specific session or everything at once. A stop received during startup records an atomic
stop intent and asks the startup owner to cancel and clean up; the command reports `Stop requested`
instead of claiming the tunnel has already stopped. If a matching entry is provably stale,
`stop --session-id` removes it idempotently. For bare app names, matching still uses the current CF
target; use `--session-id` or the full `region/org/space/app` selector when the listed session belongs
to a different target.

```bash
cf-debugger stop --region eu10 --org my-org --space dev --app my-app
cf-debugger stop --region eu10 --org my-org --space dev --app my-app --process worker --instance 2
cf-debugger stop --session-id 01HXYZABCD...
cf-debugger stop --all
```

| Flag | Description |
| --- | --- |
| `--region` / `--org` / `--space` / `--app` | Match session by key (all four required together) |
| `--process <name>` / `--instance <index>` | Match the process-instance target (defaults: `web` / `0`) |
| `--session-id <id>` | Match session by its ID |
| `--all` | Stop every active session on this machine |

### 📋 `cf-debugger list`

Print active and conservatively retained sessions as JSON. During startup, a live controller retains
the record; after `ready`, tunnel process-group and port ownership determine health. An entry is
pruned only when the owners relevant to its phase are gone and the recorded port is closed. If a
relevant PID/group is alive or the port has an unexpected owner, the entry is retained so a later
command cannot target or delete an unrelated process.

```bash
cf-debugger list | jq '.[] | {app, localPort, status}'
```

### 🔍 `cf-debugger status`

Print one retained session by key (or `null` if no session matches after the same safe pruning used
by `list`).

```bash
cf-debugger status --region eu10 --org my-org --space dev --app my-app
cf-debugger status --region eu10 --org my-org --space dev --app my-app --process worker --instance 2
```

---

## 🔭 How it works

```
┌────────────────────┐    1. cf api + cf auth (retry x3)
│ cf-debugger start  │    2. cf target -o <org> -s <space>
│  region/org/       │    3. Probe one exact/unambiguous Node PID through cf ssh
│  space/app         │ ─► 4. Signal/verify inspector ownership on remote port 9229
└────────────────────┘    5. If SSH is disabled: enable + restart only for automatic PID selection
          │               6. Retry the probe, then record its verified remote Node PID
          │               7. Open cf ssh [--process <non-web>] -i <instance> with -L
          ▼               8. Verify the local listener PID and TCP readiness
    DebuggerHandle        9. Save ready state to ~/.saptools/cf-debugger-state-v2.json
```

Each step emits a status update (`logging-in`, `targeting`, `ssh-enabling`, `signaling`, `tunneling`, `ready`, …). `--verbose` prints them live; the programmatic API exposes the same stream via `onStatus`.

### Concurrency model

- **Atomic state** — `~/.saptools/cf-debugger-state-v2.json` is written via temp-file + `rename`, guarded by a short-lived v2 lock file (`open(..., "wx")`).
- **Port allocation** — on register, ports already used by other sessions are excluded; the first free port in `20000–20999` wins.
- **Isolated CF homes** — each session runs with its own `CF_HOME` (`~/.saptools/cf-debugger-homes-v2/<sessionId>/`), so `cf target` in one terminal can't clobber another.
- **Ownership-aware lifecycle** — startup records separate controller and tunnel PIDs, polls an atomic stop intent, and lets the startup owner clean up. A tunnel PID is signalled only after exact listener ownership is verified.
- **Conservative stale pruning** — state is removed automatically only when recorded owners are dead and the port is closed. Unknown or mismatched ownership is retained and reported instead of risking an unrelated process.
- **Exact Node selection** — the fixed remote probe reads numeric `/proc` entries, never reads command lines, verifies the chosen PID owns inspector port `9229`, and fails closed when automatic selection finds zero or multiple Node processes.
- **Duplicate guard** — trying to start a second healthy tunnel for the same `region/org/space/app/process/instance` fails fast with `SESSION_ALREADY_RUNNING` instead of racing for the port; stale same-key entries are pruned so a fresh tunnel can recover.

---

## 📁 Output Files

All state lives under your home directory:

```text
~/.saptools/cf-debugger-state-v2.json       # active sessions (atomic JSON)
~/.saptools/cf-debugger-state-v2.lock       # short-lived lock file
~/.saptools/cf-debugger-homes-v2/<id>/      # per-session isolated CF_HOME
```

<details>
<summary><b>🔬 Shape of <code>cf-debugger-state-v2.json</code></b></summary>

```jsonc
{
  "version": "2",
  "sessions": [
    {
      "sessionId": "01HXYZABCD...",
      "region": "eu10",
      "org": "my-org",
      "space": "dev",
      "app": "my-app",
      "process": "web",
      "instance": 0,
      "hostname": "developer-host",
      "apiEndpoint": "https://api.cf.eu10.hana.ondemand.com",
      "localPort": 20142,
      "remotePort": 9229,
      "pid": 83421,
      "controllerPid": 83390,
      "tunnelPid": 83421,
      "remoteNodePid": 4312,
      "cfHomeDir": "/home/developer/.saptools/cf-debugger-homes-v2/01HXYZABCD...",
      "status": "ready",
      "startedAt": "2026-04-18T00:00:00.000Z"
    }
  ]
}
```

</details>

> [!IMPORTANT]
> Prefer the CLI commands (`list` / `status`) or the exported APIs over parsing these files — the on-disk format is an implementation detail.

> [!WARNING]
> State v2 intentionally does not adopt or modify legacy `cf-debugger-state.json` and
> `cf-debugger-homes/` artifacts. Stop all sessions owned by the older CLI before upgrading or
> downgrading. Separate namespaces prevent cross-version state overwrite and cross-stop, but an old
> CLI can still compete for the same local ports because it does not understand v2 reservations.

---

## ❓ FAQ

<details>
<summary><b>Can I run multiple debuggers at once?</b></summary>

Yes — that's a core feature. Open two terminals, pick different apps or process instances, and the tunnels come up on separate local ports. `cf-debugger list` shows everything at once. One exact app/process/instance target can have only one healthy tunnel.

</details>

<details>
<summary><b>Does this modify the remote app?</b></summary>

Only if SSH is disabled and Node PID selection is automatic. In that case, `cf-debugger` runs
`cf enable-ssh` + `cf restart`; otherwise it only sends `SIGUSR1` to the selected Node.js process.
With an explicit `--node-pid`, automatic restart is rejected because the old PID cannot identify the
new process after restart. No code, environment variable, or manifest is changed.

</details>

<details>
<summary><b>What if my app crashes while the tunnel is open?</b></summary>

The TCP probe will fail on reconnect and the CLI will exit with the SSH child's code. The state entry is removed on exit, so the next `start` for the same app works immediately.

</details>

<details>
<summary><b>Is there a way to reserve a specific local port?</b></summary>

Yes — pass `--port 9230` (CLI) or `preferredPort: 9230` (API). If any process already owns that port, `cf-debugger` fails closed with `PORT_UNAVAILABLE`; it never terminates an unrelated listener to claim a port.

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
