<div align="center">

# ⚙️ `@saptools/cf-ops`

**Operate SAP BTP Cloud Foundry apps with safe, explicit lifecycle and scaling workflows.**

Restart, restage, start/stop, and scale app instances, memory, or disk from one focused CLI — without mixing mutating production operations into the read-only diagnostic packages in the saptools monorepo.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-ops.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-ops)
[![license](https://img.shields.io/npm/l/@saptools/cf-ops.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-ops.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![types](https://img.shields.io/npm/types/@saptools/cf-ops.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [Programmatic Usage](#-programmatic-usage) • [Safety](#-safety-model) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🔁 **Lifecycle operations** — `restart`, `restage`, `start`, and `stop` map directly to official `cf` CLI commands.
- 📈 **Instance scaling** — update app instance count with deterministic `cf scale -i` arguments.
- 🧠 **Memory and disk scaling** — validate Cloud Foundry sizes such as `512M`, `1024MB`, `1G`, and `2GB` before invoking `cf`.
- 🟢 **Rolling restart support** — use `--strategy rolling` for restart workflows that should ask CF for rolling deployment semantics.
- 🧩 **Composable plan layer** — parsing and validation produce typed plans before execution, making behavior easy to test and review.
- 🔐 **No credential persistence** — the package uses your current `cf` target and strips `SAP_EMAIL` / `SAP_PASSWORD` from the child-process environment.
- 🧪 **Fake-CF friendly** — `CF_OPS_CF_BIN` can point at a JS test double, matching patterns used by other saptools packages.
- 🧾 **Dry-run first** — add `--dry-run` to print exact `cf` command arrays before mutating an app.
- 🪶 **Small + focused** — one runtime dependency (`commander`) and no background daemon, local state store, or credential cache.

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/cf-ops

# Or as a project dependency
npm install @saptools/cf-ops
# pnpm add @saptools/cf-ops
# yarn add @saptools/cf-ops
```

> [!NOTE]
> Requires **Node.js ≥ 20** and the official **Cloud Foundry `cf` CLI** available on `PATH`.

---

## 🚀 Quick Start

`cf-ops` intentionally runs against your currently targeted Cloud Foundry org and space.

```bash
# 1. Authenticate and target the app's org/space with the official CF CLI
cf login
cf target -o <org> -s <space>

# 2. Restart an app
cf-ops restart --app orders-srv

# 3. Scale to three instances
cf-ops scale --app orders-srv --instances 3

# 4. Increase memory and restart with rolling strategy
cf-ops scale --app orders-srv --memory 1G --restart --strategy rolling

# Preview commands before touching CF
cf-ops scale --app orders-srv --instances 3 --restart --strategy rolling --dry-run
```

Use `cf target` whenever you need to confirm the org/space that will receive the operation.

---

## 🧰 CLI

### 🔁 `cf-ops restart`

Restart the app in the current CF target.

```bash
cf-ops restart --app orders-srv
cf-ops restart --app orders-srv --strategy rolling
```

| Flag | Description |
| --- | --- |
| `-a, --app <name>` | App name in the currently targeted org and space |
| `--strategy <default\|rolling>` | Restart strategy; `rolling` invokes `cf restart <app> --strategy rolling` |
| `--dry-run` | Print the planned `cf` command without executing it |

> [!TIP]
> Prefer `--strategy rolling` for production apps when your platform, app type, and route setup support rolling deployment semantics.

### 🧱 `cf-ops restage`

Restage the app after buildpack, stack, dependency, or relevant environment changes.

```bash
cf-ops restage --app orders-srv
```

| Flag | Description |
| --- | --- |
| `-a, --app <name>` | App name in the currently targeted org and space |
| `--dry-run` | Print the planned `cf` command without executing it |

### ▶️ `cf-ops start`

Start a stopped app.

```bash
cf-ops start --app orders-srv
```

| Flag | Description |
| --- | --- |
| `-a, --app <name>` | App name in the currently targeted org and space |
| `--dry-run` | Print the planned `cf` command without executing it |

### ⏹️ `cf-ops stop`

Stop a running app.

```bash
cf-ops stop --app orders-srv
```

| Flag | Description |
| --- | --- |
| `-a, --app <name>` | App name in the currently targeted org and space |
| `--dry-run` | Print the planned `cf` command without executing it |

> [!WARNING]
> `stop` is intentionally direct: it does not prompt and it does not inspect routes or dependencies. Confirm your `cf target` first.

### 📈 `cf-ops scale`

Scale one or more app dimensions with a single `cf scale` call.

```bash
cf-ops scale --app orders-srv --instances 3
cf-ops scale --app orders-srv --memory 1024M
cf-ops scale --app orders-srv --disk 2G
cf-ops scale --app orders-srv --instances 4 --memory 1G --disk 2G
cf-ops scale --app orders-srv --memory 1G --restart
cf-ops scale --app orders-srv --memory 1G --restart --strategy rolling

# Preview commands before touching CF
cf-ops scale --app orders-srv --instances 3 --restart --strategy rolling --dry-run
```

| Flag | Description |
| --- | --- |
| `-a, --app <name>` | App name in the currently targeted org and space |
| `-i, --instances <count>` | Desired instance count; accepts `0` or any positive integer |
| `-m, --memory <size>` | Memory limit, e.g. `512M`, `1024MB`, `1G`, or `2GB` |
| `-k, --disk <size>` | Disk quota, e.g. `1G` or `2048M` |
| `--restart` | Restart after scaling so memory/disk changes are applied immediately |
| `--strategy <default\|rolling>` | Restart strategy used only when `--restart` is present |
| `--dry-run` | Print all planned `cf` commands without executing them |

`scale` requires at least one of `--instances`, `--memory`, or `--disk`.

---

## 🧑‍💻 Programmatic Usage

```ts
import {
  buildLifecyclePlan,
  buildScalePlan,
  lifecycleCommandArgs,
  runLifecycle,
  runScale,
  scaleCommandArgs,
} from "@saptools/cf-ops";

// Review a typed plan before invoking CF
const scalePlan = buildScalePlan({
  appName: "orders-srv",
  instances: 3,
  memory: "1G",
  restart: true,
  strategy: "rolling",
});

console.log(scaleCommandArgs(scalePlan));
await runScale(scalePlan);

// Or run lifecycle operations explicitly
const restartPlan = buildLifecyclePlan("orders-srv", "restart", "rolling");
console.log(lifecycleCommandArgs(restartPlan));
await runLifecycle(restartPlan);
```

### Test doubles and alternate CF binaries

Set `CF_OPS_CF_BIN` to override the executable used by the command runner. If the value ends with `.js`, `.mjs`, or `.cjs`, it is executed through the current Node.js binary.

```bash
CF_OPS_CF_BIN=./tests/fixtures/fake-cf.mjs cf-ops scale --app orders-srv --instances 2
```

---

## 🔐 Safety Model

- `cf-ops` does **not** run `cf login`, store credentials, or create a private `CF_HOME`.
- Operations apply to the user's active `cf target`, making the target explicit and inspectable with `cf target`.
- `SAP_EMAIL` and `SAP_PASSWORD` are removed from the child-process environment before invoking `cf`.
- The package uses `execFile` with argument arrays rather than shell command strings.
- Size and instance inputs are validated before execution.
- The CLI does not write Cloud Foundry app metadata, credentials, or operation history to the repository.

> [!IMPORTANT]
> These commands mutate live Cloud Foundry apps. Run `cf target` and, when needed, `cf app <name>` before operating on production spaces.

---

## 🧭 When should I use this package?

Use `cf-ops` when you want a small saptools-style wrapper around common official CF app operations:

- Increase or reduce instances during support windows.
- Increase memory or disk and immediately restart the app.
- Run a rolling restart without remembering exact CF CLI argument order.
- Keep operational commands separate from read-only tools such as logs, events, files, exports, and inspectors.

If you need topology discovery, use [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync). If you need log snapshots or streams, use `@saptools/cf-logs` / `@saptools/cf-tail`. If you need runtime debugging, use `@saptools/cf-debugger` or `@saptools/cf-inspector`.

---

## 🛠️ Troubleshooting

### `Error: --app is required.`

Every command intentionally requires an explicit app name.

```bash
cf-ops restart --app orders-srv
```

### `scale requires at least one of --instances, --memory, or --disk.`

Add at least one scale dimension.

```bash
cf-ops scale --app orders-srv --instances 2
```

### `memory must use a Cloud Foundry size...`

Use CF-style size units.

```bash
cf-ops scale --app orders-srv --memory 1024M
cf-ops scale --app orders-srv --memory 1G
```

### CF says the app cannot be found

Confirm your target and app name with the official CLI.

```bash
cf target
cf apps
cf app orders-srv
```

---

## ❓ FAQ

### Does `cf-ops` log in for me?

No. Use the official `cf login` flow. This avoids credential persistence and keeps authentication behavior exactly where CF operators expect it.

### Does `cf-ops` change my target?

No. It operates on the active target. Use `cf target -o <org> -s <space>` before running operations.

### Why is this not part of `cf-sync`, `cf-logs`, or `cf-events`?

Those packages are primarily discovery, diagnostic, or read-oriented tools. Scaling and restarts are mutating operations, so a focused package makes the risk boundary clearer.

### Does memory or disk scaling always require restart?

Cloud Foundry applies some scale dimensions differently depending on app state and platform behavior. `cf-ops` keeps restart explicit: add `--restart` when you want scale followed by restart in one workflow.

### Can I use this in CI?

Yes, as long as the CI job has the official `cf` CLI authenticated and targeted before invoking `cf-ops`. For tests, point `CF_OPS_CF_BIN` at a fake CF executable.

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
