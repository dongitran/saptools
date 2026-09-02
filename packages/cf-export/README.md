<div align="center">

# 📤 `@saptools/cf-export`

**Export CAP / Cloud Foundry project artifacts (package.json, lockfiles, .cdsrc.json, default-env.json, .npmrc) from a running SAP BTP Cloud Foundry application.** (v0.1.1+)

Pull the exact files you need for local development or debugging directly from a live CF container using `cf ssh` + CF API.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-export.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-export)
[![license](https://img.shields.io/npm/l/@saptools/cf-export.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-export.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/cf-export)](https://packagephobia.com/result?p=@saptools/cf-export)
[![types](https://img.shields.io/npm/types/@saptools/cf-export.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [Development](#-development)

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

## Updates

Every command first checks npm for a newer `@saptools/cf-export` (at most once an hour, one small request
with a 2-second timeout) and, when one exists, installs that exact version with the package manager
that owns the running binary and re-runs the command you typed on the new version. Both steps are
announced on stderr; nothing is printed when the install is already current:

```text
cf-export: updating 0.2.0 -> 0.3.0 ...
cf-export: updated to 0.3.0; re-running the command
```

If the install cannot complete, one stderr line gives the manual command and the command runs on the
installed version; that version is not retried for a day. `cf-export self-update` forces the check and
install now; `cf-export self-update --check` only reports.

| Control | Effect |
| --- | --- |
| `SAPTOOLS_AUTO_UPDATE=on\|notify\|off` | `on` (default) installs and re-runs; `notify` prints the manual command once per version; `off` never checks. Applies to every `@saptools` CLI. |
| `CF_EXPORT_AUTO_UPDATE` | same values, this CLI only; wins over the global variable |
| `SAPTOOLS_UPDATE_INTERVAL_MINUTES` | minutes between checks (default `60`; `0` checks on every run) |
| `SAPTOOLS_NPM_REGISTRY` | registry to check and install from (default: npm's configured registry, then npmjs) |
| `SAPTOOLS_UPDATE_DEBUG=1` | explain on stderr why nothing happened |

The updater switches itself off in CI (`CI` set), under `NODE_ENV=test` or `NO_UPDATE_NOTIFIER`, when
the binary runs from a source checkout, an `npm link` or an `npx` cache, and inside the re-run itself.
It never writes to stdout, never asks for input, never uses `sudo`, and never moves onto a prerelease.
Its state lives in `~/.saptools/updates/`.

## 🚀 Quick Start

```bash
# Export credentials (used only during the operation)
export SAP_EMAIL="you@company.com"
export SAP_PASSWORD="your-sap-password"

# (Recommended) Set your CF target once — then you can skip region/org/space
cf target -o my-org -s dev

# Export all artifacts — region/org/space are auto-detected from `cf target`!
cf-export -a my-cap-app --out ./exported

# You can still pass them explicitly when needed
cf-export -r ap10 -o my-org -s dev -a my-cap-app --out ./exported

# Export with a custom remote root
cf-export -a my-cap-app \
  --remote-root /home/vcap/app/srv \
  --out ./exported

# Export only specific files
cf-export -a my-cap-app \
  --file package.json --file pnpm-lock.yaml --file default-env.json
```

After export you will have the requested files locally, ready for local CAP development or attaching to tickets.

---

## 🧰 CLI

The default (and only) command is `export`.

```bash
cf-export [options]
```

### Common examples

**Export everything (recommended default)**

```bash
cf-export \
  -r ap10 \
  -o my-org \
  -s dev \
  -a my-cap-app \
  --out ./exported-artifacts
```

**With custom remote root**

```bash
cf-export -r ap10 -o my-org -s dev -a my-cap-app \
  --remote-root /home/vcap/app \
  --out ./out
```

**Selective export**

```bash
cf-export ... --file package.json --file default-env.json
```

### Options

Region/org/space flags are **optional**. They are auto-detected from your current `cf target` (recommended: run `cf target -o ORG -s SPACE` first).

| Flag                  | Description                                                                 | Required |
|-----------------------|-----------------------------------------------------------------------------|----------|
| `-r, --region <key>`  | CF region key (e.g. `ap10`, `eu10`). Auto-detected from current `cf target` | No       |
| `-o, --org <name>`    | CF org name. Auto-detected from current `cf target`                         | No       |
| `-s, --space <name>`  | CF space name. Auto-detected from current `cf target`                       | No       |
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
