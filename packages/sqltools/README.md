<div align="center">

# 🗄️ `@saptools/sqltools`

**Stop copy-pasting HANA credentials out of `VCAP_SERVICES`.**

One command turns a SAP BTP Cloud Foundry HANA service binding into a ready-to-use **VS Code SQLTools** connection — no cockpit clicking, no JSON surgery.

[![npm version](https://img.shields.io/npm/v/@saptools/sqltools.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/sqltools)
[![license](https://img.shields.io/npm/l/@saptools/sqltools.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/sqltools.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/sqltools)](https://packagephobia.com/result?p=@saptools/sqltools)
[![types](https://img.shields.io/npm/types/@saptools/sqltools.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🔌 **One-shot export** — pulls `VCAP_SERVICES` from any CF app and writes `.vscode/settings.json` with a valid SAPHana connection
- 🪄 **Four input paths** — read from a real CF app, a saved JSON file, stdin, or an already-targeted CF session
- 🧷 **Non-destructive** — preserves unrelated VS Code settings and, with `--merge`, unrelated SQLTools connections too
- 💾 **Backup JSON** — drops a `hana-credentials.json` beside the settings so HDI users / URLs / certificates stay within reach
- 🔒 **Type-safe** — shipped with full TypeScript definitions for every input and output shape
- 🪶 **Tiny** — two runtime deps (`@saptools/cf-sync`, `commander`) and zero runtime magic

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/sqltools

# Or as a dependency
npm install @saptools/sqltools
# pnpm add @saptools/sqltools
# yarn add @saptools/sqltools
```

> [!NOTE]
> Requires **Node.js ≥ 20**. The `from-cf` / `from-app` commands also need the **`cf` CLI** on `PATH`. For `from-app`, set `SAP_EMAIL` and `SAP_PASSWORD` so the tool can authenticate and target the org/space for you.

---

## Updates

Every command first checks npm for a newer `@saptools/sqltools` (at most once an hour, one small request
with a 2-second timeout) and, when one exists, installs that exact version with the package manager
that owns the running binary and re-runs the command you typed on the new version. Both steps are
announced on stderr; nothing is printed when the install is already current:

```text
sqltools-export: updating 0.2.0 -> 0.3.0 ...
sqltools-export: updated to 0.3.0; re-running the command
```

If the install cannot complete, one stderr line gives the manual command and the command runs on the
installed version; that version is not retried for a day. `sqltools-export self-update` forces the check and
install now; `sqltools-export self-update --check` only reports.

| Control | Effect |
| --- | --- |
| `SAPTOOLS_AUTO_UPDATE=on\|notify\|off` | `on` (default) installs and re-runs; `notify` prints the manual command once per version; `off` never checks. Applies to every `@saptools` CLI. |
| `SQLTOOLS_AUTO_UPDATE` | same values, this CLI only; wins over the global variable |
| `SAPTOOLS_UPDATE_INTERVAL_MINUTES` | minutes between checks (default `60`; `0` checks on every run) |
| `SAPTOOLS_NPM_REGISTRY` | registry to check and install from (default: npm's configured registry, then npmjs) |
| `SAPTOOLS_UPDATE_DEBUG=1` | explain on stderr why nothing happened |

The updater switches itself off in CI (`CI` set), under `NODE_ENV=test` or `NO_UPDATE_NOTIFIER`, when
the binary runs from a source checkout, an `npm link` or an `npx` cache, and inside the re-run itself.
It never writes to stdout, never asks for input, never uses `sudo`, and never moves onto a prerelease.
Its state lives in `~/.saptools/updates/`.

## 🚀 Quick Start

```bash
# Already logged in and targeted with `cf login`? One command is enough.
sqltools-export from-cf \
  --app my-srv --region eu10 --org my-org --space dev
```

Result:

```text
✔ Updated SQLTools connections (1) → /workspace/.vscode/settings.json
  Credentials JSON saved → /workspace/hana-credentials.json
  • my-srv (eu10) host.hana.ondemand.com:443 schema=SCHEMA_MY_SRV
```

Open the workspace in VS Code, install the **SQLTools** + **SQLTools SAP HANA driver** extensions, and the new connection is already wired up.

---

## 🧰 CLI

Every command identifies an app with the same four labels — they are written into the SQLTools connection name as `"<app> (<region>)"`.

| Flag | Description | Example |
| --- | --- | --- |
| `--app <name>` | CF app name (also the label) | `my-srv` |
| `--region <key>` | CF region key | `ap10`, `eu10`, `us10` |
| `--org <name>` | CF org name | `my-org` |
| `--space <name>` | CF space name | `dev` |

Common output options:

| Flag | Description |
| --- | --- |
| `--cwd <dir>` | Workspace root that owns `.vscode/settings.json` (default: `cwd`) |
| `--merge` | Merge with existing connections by name (default: overwrite) |
| `--credentials-out <path>` | Custom path for the backup JSON |
| `--no-credentials-file` | Skip writing `hana-credentials.json` |

### 🌐 `sqltools-export from-app`

Full end-to-end: `cf api` → `cf auth` → `cf target` → `cf env` → write settings. Great for CI and fresh machines.

```bash
export SAP_EMAIL="you@company.com"
export SAP_PASSWORD="your-sap-password"

sqltools-export from-app \
  --app my-srv --region eu10 --org my-org --space dev
```

### 📡 `sqltools-export from-cf`

Assumes you are **already targeted** (`cf login && cf target -o ... -s ...`). Shells out to `cf env <app>` and writes the settings.

```bash
sqltools-export from-cf --app my-srv --region eu10 --org my-org --space dev
```

### 📄 `sqltools-export from-file`

Already have a `VCAP_SERVICES` JSON saved somewhere? Point to it.

```bash
sqltools-export from-file --input ./vcap.json \
  --app my-srv --region eu10 --org my-org --space dev
```

### 📥 `sqltools-export from-stdin`

Classic pipe:

```bash
cf env my-srv | jq '."VCAP_SERVICES"' | sqltools-export from-stdin \
  --app my-srv --region eu10 --org my-org --space dev
```

### 🔁 `sqltools-export convert`

Print a single SQLTools connection JSON to stdout — no files written. Perfect for scripting.

```bash
sqltools-export convert --input ./vcap.json \
  --app my-srv --region eu10 --org my-org --space dev
```

> [!TIP]
> Use `--merge` to keep hand-crafted connections in `.vscode/settings.json` untouched while only overwriting the one matching `<app> (<region>)`.

---

## 📁 Output Files

After a successful export you get two files in the workspace root:

```text
.vscode/settings.json     # SQLTools connections + sqltools.useNodeRuntime
hana-credentials.json     # Backup of every extracted binding (HDI user, URL, cert…)
```

<details>
<summary><b>🔬 Shape of the SQLTools connection entry</b></summary>

```jsonc
{
  "sqltools.useNodeRuntime": true,
  "sqltools.connections": [
    {
      "name": "my-srv (eu10)",
      "driver": "SAPHana",
      "server": "host.hana.ondemand.com",
      "port": 443,
      "username": "USER_1",
      "password": "…",
      "database": "SCHEMA_MY_SRV",
      "connectionTimeout": 30,
      "previewLimit": 50,
      "hanaOptions": {
        "encrypt": true,
        "sslValidateCertificate": true,
        "sslCryptoProvider": "openssl"
      }
    }
  ]
}
```

</details>

> [!IMPORTANT]
> Both files contain live HANA credentials. They live inside your workspace, not under `~` — keep them out of git (add to `.gitignore` if your repo doesn't already exclude `hana-credentials.json`).

---

## ❓ FAQ

<details>
<summary><b>Do I still need the SQLTools SAP HANA driver extension?</b></summary>

Yes. `@saptools/sqltools` only writes the connection definition. You still need the [SQLTools](https://marketplace.visualstudio.com/items?itemName=mtxr.sqltools) extension and the [SQLTools SAP HANA driver](https://marketplace.visualstudio.com/items?itemName=SAPSE.sql-driver-hana) to actually run queries.

</details>

<details>
<summary><b>Will this overwrite my other connections in <code>settings.json</code>?</b></summary>

By default, yes — `sqltools.connections` is replaced with the newly-exported entries, while every other key in `settings.json` is preserved. Pass `--merge` to keep existing connections whose `name` does not match `<app> (<region>)`.

</details>

<details>
<summary><b>Is the backup file safe to commit?</b></summary>

**No.** `hana-credentials.json` contains the HANA password, schema, HDI user, and the certificate payload. Add it to `.gitignore`.

</details>

<details>
<summary><b>What does the CLI do with <code>SAP_EMAIL</code> / <code>SAP_PASSWORD</code>?</b></summary>

They are only read by `from-app`. The tool forwards them directly to `cf auth` — no storage, no logging. `from-cf` assumes you are already targeted and ignores both env vars.

</details>

<details>
<summary><b>My binding is not called <code>hana</code> in <code>VCAP_SERVICES</code>. Does this still work?</b></summary>

Not yet. The parser looks for the `hana` service label (the default for SAP HANA Cloud / HDI service bindings on BTP). If you have a bespoke label, open an issue and we'll add support.

</details>

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/sqltools... build
pnpm --filter @saptools/sqltools typecheck
pnpm --filter @saptools/sqltools lint
pnpm --filter @saptools/sqltools test:unit
pnpm --filter @saptools/sqltools test:e2e:fake
pnpm --filter @saptools/sqltools test:e2e:live   # needs SAP_EMAIL / SAP_PASSWORD
```

The **live e2e** suite auto-discovers a real CF app with a `hana` service binding by scoring candidates from `~/.saptools/cf-structure.json` (populated by [`cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync)). To pin a specific target:

```bash
export E2E_TARGET="eu10/my-org/my-space/my-srv"
```

Live e2e only performs **read-only** CF operations (`cf api`, `cf auth`, `cf target`, `cf env`) — nothing is created, updated, or deleted in Cloud Foundry.

---

## 🌐 Related

- 📦 [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — sync the CF `region → org → space → app` tree to disk
- 🔐 [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa) — fetch XSUAA client credentials and OAuth2 tokens
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
