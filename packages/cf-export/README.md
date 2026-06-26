<div align="center">

# 📤 `@saptools/cf-export`

**Export CAP / Cloud Foundry project artifacts (package.json, lockfiles, .cdsrc.json, default-env.json, .npmrc) from a running SAP BTP Cloud Foundry application.**

Pull the exact files you need for local development or debugging directly from a live CF container using `cf ssh` + CF API.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-export.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-export)
[![license](https://img.shields.io/npm/l/@saptools/cf-export.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-export.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/cf-export)](https://packagephobia.com/result?p=@saptools/cf-export)
[![types](https://img.shields.io/npm/types/@saptools/cf-export.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [Development](#-development)

</div>

---

## ✨ Features

- 📦 **Selective artifact export** — default exports everything, or pick exactly what you need with `--file`
- 🌍 **Remote root support** — specify `--remote-root` (or "root url") to locate files when they are not at the standard `/home/vcap/app`
- 🔄 **Synthesized `default-env.json`** — built from live `cf curl /v3/apps/.../env` (full VCAP_SERVICES + env vars)
- 🛡️ **Best-effort for optional files** — missing files (package.json, locks, .cdsrc.json, .npmrc) are skipped gracefully
- 🧰 **CLI + typed library** — use from terminal or Node.js/TypeScript with full types
- 🔐 **Secure by default** — sensitive files (`default-env.json`, `.npmrc`) written with `0600` permissions
- 🪶 **Lightweight** — only depends on `commander` + reuses `@saptools/cf-files`

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/cf-export

# Or as a library
npm install @saptools/cf-export
# pnpm add @saptools/cf-export
```

> [!NOTE]
> Requires **Node.js ≥ 20** and the official **`cf` CLI** on `PATH`.

---

## 🚀 Quick Start

```bash
# Export credentials (used only during the operation)
export SAP_EMAIL="you@company.com"
export SAP_PASSWORD="your-sap-password"

# Export all artifacts for an app (default behavior)
saptools-cf-export -r ap10 -o my-org -s dev -a my-cap-app --out ./exported

# Export with a custom remote root
saptools-cf-export -r ap10 -o my-org -s dev -a my-cap-app \
  --remote-root /home/vcap/app/srv \
  --out ./exported

# Export only specific files
saptools-cf-export -r ap10 -o my-org -s dev -a my-cap-app \
  --file package.json --file pnpm-lock.yaml --file default-env.json
```

After export you will have the requested files locally, ready for local CAP development or attaching to tickets.

---

## 🧰 CLI

The default (and only) command is `export`.

```bash
saptools-cf-export [options]
```

### Common examples

**Export everything (recommended default)**

```bash
saptools-cf-export \
  -r ap10 \
  -o my-org \
  -s dev \
  -a my-cap-app \
  --out ./exported-artifacts
```

**With custom remote root**

```bash
saptools-cf-export -r ap10 -o my-org -s dev -a my-cap-app \
  --remote-root /home/vcap/app \
  --out ./out
```

**Selective export**

```bash
saptools-cf-export ... --file package.json --file default-env.json
```

### Options

| Flag                  | Description                                                                 | Required |
|-----------------------|-----------------------------------------------------------------------------|----------|
| `-r, --region <key>`  | CF region key (e.g. `ap10`, `eu10`)                                         | Yes      |
| `-o, --org <name>`    | CF org name                                                                 | Yes      |
| `-s, --space <name>`  | CF space name                                                               | Yes      |
| `-a, --app <name>`    | CF app name                                                                 | Yes      |
| `--out <dir>`         | Output directory (default: current working directory)                       | No       |
| `--remote-root <path>`| Hint for the base directory inside the container (the "root url")           | No       |
| `--file <name>`       | Artifact to export (repeatable). Omit to export all                         | No       |
| `--all`               | Explicitly request all supported artifacts (default behavior)               | No       |

**Supported artifact names** (use with `--file`):
- `package.json`
- `package-lock.json`
- `pnpm-lock.yaml`
- `.cdsrc.json`
- `default-env.json`
- `.npmrc`

Missing optional files are skipped (only `default-env.json` failures when explicitly selected will surface clearly).

---

## 🧑‍💻 Programmatic Usage

```ts
import { exportArtifacts, formatExportCompletionMessage } from "@saptools/cf-export";

const result = await exportArtifacts({
  target: {
    region: "ap10",
    org: "my-org",
    space: "dev",
    app: "my-cap-app",
  },
  outDir: "./export-dir",
  remoteRoot: "/home/vcap/app",           // optional "root url"
  // artifacts: ["default-env.json", "pnpm-lock.yaml"], // optional subset
});

console.log(
  formatExportCompletionMessage(
    "my-cap-app",
    result.writtenFiles,
    result.skipped
  )
);
```

**Exported types & helpers** (see `src/index.ts` for full list):
- `exportArtifacts(options)`
- `formatExportCompletionMessage(appName, written, skipped)`
- `CfTarget`, `ArtifactName`, `ExportArtifactsOptions`, etc.
- Low-level: `fetchDefaultEnvJson`, `fetchRemoteTextFile`, `buildRemoteFilePaths`, `openCfSession`, etc.

---

## Environment variables

| Variable             | Purpose                                                              |
|----------------------|----------------------------------------------------------------------|
| `SAP_EMAIL`          | SAP SSO email (required for `cf auth`)                               |
| `SAP_PASSWORD`       | SAP SSO password                                                     |
| `CF_EXPORT_CF_HOME`  | Reuse an existing `CF_HOME` (advanced)                               |
| `CF_EXPORT_CF_BIN`   | Override the `cf` binary path (mainly for testing / fake-cf)         |

---

## How remote root works

When `--remote-root` is provided, candidate paths are tried in this order:

1. `${remoteRoot}/<filename>`
2. `/home/vcap/app/<filename>`
3. `<filename>` (relative, last resort)

This matches the strategy used by the "Export" feature in the SAP Tools VS Code extension.

---

## Security

- `default-env.json` and `.npmrc` are always written with mode `0600`.
- Every operation uses an isolated temporary `CF_HOME` (unless you explicitly override via env).
- Credentials are never logged or written to disk by this tool.
- Treat any exported `default-env.json` as a secret.

---

## 🛠️ Development (inside monorepo)

```bash
pnpm install
pnpm --filter @saptools/cf-export build
pnpm --filter @saptools/cf-export typecheck
pnpm --filter @saptools/cf-export lint
pnpm --filter @saptools/cf-export test:unit
pnpm --filter @saptools/cf-export test:e2e:fake
```

The fake-backed e2e tests do not require real SAP credentials.

---

## 🌐 Related packages

- 📥 [`@saptools/cf-files`](https://www.npmjs.com/package/@saptools/cf-files) — download files & generate `default-env.json` from CF
- 🔄 [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — full CF topology + HANA binding sync
- 🧰 [Full saptools monorepo](https://github.com/dongitran/saptools)

---

## 📄 License

MIT © Dong Tran

---

Made to make SAP BTP CF development less painful ✨
