<div align="center">

# 🗄️ `@saptools/sqltools`

**Stop copy-pasting HANA credentials out of `VCAP_SERVICES`.**

One command turns a SAP BTP Cloud Foundry HANA service binding into a ready-to-use **VS Code SQLTools** connection — no cockpit clicking, no JSON surgery.

[![npm version](https://img.shields.io/npm/v/@saptools/sqltools.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/sqltools)
[![license](https://img.shields.io/npm/l/@saptools/sqltools.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/sqltools.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/sqltools)](https://packagephobia.com/result?p=@saptools/sqltools)
[![types](https://img.shields.io/npm/types/@saptools/sqltools.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [FAQ](#-faq)

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

## 🧑‍💻 Programmatic Usage

```ts
import {
  exportFromApp,
  exportFromCf,
  exportFromFile,
  exportFromVcap,
  toSqlToolsConnection,
  buildEntryFromVcap,
} from "@saptools/sqltools";

const context = {
  app: "my-srv",
  region: "eu10",
  org: "my-org",
  space: "dev",
} as const;

// Full login → target → env → write flow
await exportFromApp(
  { context, email: process.env["SAP_EMAIL"]!, password: process.env["SAP_PASSWORD"]! },
  { merge: true },
);

// Or: already targeted, just run `cf env`
await exportFromCf({ context });

// Or: in-memory VCAP from your own source
const vcapServices = JSON.stringify({ hana: [/* … */] });
const result = await exportFromVcap({ vcapServices, context });
console.log(result.settingsPath, result.connectionCount);

// Or: one-off convert without touching the workspace
const entry = buildEntryFromVcap({ vcapServices, context });
if (entry !== null) {
  console.log(toSqlToolsConnection(entry));
}
```

<details>
<summary><b>📚 Full export list</b></summary>

| Export | Description |
| --- | --- |
| `exportFromApp(input, options?)` | CF login + target + env + write settings |
| `exportFromCf(input, options?)` | Shell `cf env <app>` and write settings |
| `exportFromFile(input, options?)` | Read VCAP JSON from disk and write settings |
| `exportFromVcap(input, options?)` | Accept in-memory VCAP JSON and write settings |
| `buildEntryFromVcap(input)` | Parse a VCAP payload into a typed `AppHanaEntry` |
| `toSqlToolsConnection(entry)` | Convert an entry into a single SQLTools connection |
| `updateVscodeConnections(entries, options?)` | Low-level `.vscode/settings.json` writer |
| `writeCredentials(entries, options?)` | Low-level `hana-credentials.json` writer |
| `parseVcapServices(raw)` | Strict VCAP JSON parser |
| `extractHanaCredentials(binding)` | Map `snake_case` → `camelCase` |
| `extractVcapServicesSection(stdout)` | Isolate the VCAP block from `cf env` output |
| `cfLoginAndTarget(input)` | `cf api` + `cf auth` + `cf target -o -s` |
| `cfAppVcapServices(app)` | Run `cf env` and return the VCAP JSON |
| `assertRegionKey(region)` | Guard an unknown string as a known CF region |
| Constants | `DRIVER`, `HANA_OPTIONS`, `CONNECTION_TIMEOUT`, `PREVIEW_LIMIT`, `SQLTOOLS_CONNECTIONS_KEY`, `SQLTOOLS_USE_NODE_RUNTIME_KEY`, `VSCODE_SETTINGS_REL_PATH`, `OUTPUT_FILENAME` |

</details>

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

<div align="center">

Made with ❤️ for SAP BTP developers who want to query HANA in VS Code without leaving the editor.

**License** · [MIT](./LICENSE)

</div>
