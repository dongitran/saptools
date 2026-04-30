<div align="center">

# 🧰 `saptools`

**A focused monorepo for SAP BTP Cloud Foundry tooling.**

[![GitHub Repo](https://img.shields.io/badge/repo-dongitran%2Fsaptools-181717?style=flat-square&logo=github)](https://github.com/dongitran/saptools)
[![GitHub Stars](https://img.shields.io/github/stars/dongitran/saptools?style=flat-square)](https://github.com/dongitran/saptools/stargazers)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/workspace-pnpm-f69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io)

Utilities in this repository are designed to make SAP BTP Cloud Foundry workflows easier to automate, easier to script, and easier to reuse across local developer tools.

</div>

---

## ✨ What This Repo Contains

This repository is organized as a monorepo under [`packages/`](./packages).

| Package | Purpose | npm |
| --- | --- | --- |
| [`@saptools/cf-sync`](./packages/cf-sync) | Sync **region → org → space → app** from SAP BTP CF into `~/.saptools/cf-structure.json` | [![npm](https://img.shields.io/npm/v/@saptools/cf-sync.svg?style=flat-square&color=CB3837&logo=npm&label=)](https://www.npmjs.com/package/@saptools/cf-sync) |
| [`@saptools/cf-xsuaa`](./packages/cf-xsuaa) | Fetch XSUAA credentials and cached OAuth2 tokens for any CF app | [![npm](https://img.shields.io/npm/v/@saptools/cf-xsuaa.svg?style=flat-square&color=CB3837&logo=npm&label=)](https://www.npmjs.com/package/@saptools/cf-xsuaa) |
| [`@saptools/cf-debugger`](./packages/cf-debugger) | Open an SSH debug tunnel to any CF Node.js app from your terminal | [![npm](https://img.shields.io/npm/v/@saptools/cf-debugger.svg?style=flat-square&color=CB3837&logo=npm&label=)](https://www.npmjs.com/package/@saptools/cf-debugger) |
| [`@saptools/bruno`](./packages/bruno) | Smart runner for [Bruno](https://www.usebruno.com) collections with CF-aware env metadata and automatic XSUAA token injection | [![npm](https://img.shields.io/npm/v/@saptools/bruno.svg?style=flat-square&color=CB3837&logo=npm&label=)](https://www.npmjs.com/package/@saptools/bruno) |
| [`@saptools/sqltools`](./packages/sqltools) | Export SAP HANA service bindings (VCAP_SERVICES) into VS Code SQLTools connections | [![npm](https://img.shields.io/npm/v/@saptools/sqltools.svg?style=flat-square&color=CB3837&logo=npm&label=)](https://www.npmjs.com/package/@saptools/sqltools) |
| [`@saptools/gitport`](./packages/gitport) | Port a GitLab source MR into a destination Draft MR with sequential cherry-picks | [![npm](https://img.shields.io/npm/v/@saptools/gitport.svg?style=flat-square&color=CB3837&logo=npm&label=)](https://www.npmjs.com/package/@saptools/gitport) |

Archived code snapshot: [`_backup/`](./_backup) keeps the previous single-package implementation for reference during the migration.

---

## 🚀 Package Focus

### ☁️ `@saptools/cf-sync`

Reads the CF topology once, so every downstream tool can skip the `cf target` dance.

- 🌍 SAP BTP CF region discovery
- 🏢 org / space / app traversal
- 💾 structured JSON output for local tooling
- 🛠️ both a CLI and a reusable TypeScript API

Docs → [`packages/cf-sync/README.md`](./packages/cf-sync/README.md)

### 🔐 `@saptools/cf-xsuaa`

Turns explicit CF app coordinates into a usable bearer token.

- 🔑 zero-config OAuth2 `client_credentials` from the app's XSUAA binding
- 🌍 region-key based CF API resolution via `@saptools/cf-sync`
- 💾 disk-cached tokens with automatic expiry handling
- 🧩 CLI (`cf-xsuaa get-token-cached ...`) and ergonomic Node API

Docs → [`packages/cf-xsuaa/README.md`](./packages/cf-xsuaa/README.md)

### 🐛 `@saptools/cf-debugger`

Open an SSH debug tunnel to any Cloud Foundry Node.js app from your terminal — no IDE required.

- 🚇 `cf ssh`-based tunnel to the app's Node inspector
- 🔁 session lifecycle handling (start, wait, cleanup)
- 🧰 CLI-first, usable from any shell or editor

Docs → [`packages/cf-debugger/README.md`](./packages/cf-debugger/README.md)

### 🎯 `@saptools/bruno`

Runs [Bruno](https://www.usebruno.com) collections against XSUAA-protected CF services with zero token juggling.

- 🏗️ interactive `setup-app` scaffolds a CF-aware folder tree with seeded `__cf_*` metadata
- 🧭 shorthand `region/org/space/app` path resolution
- 🔐 automatic XSUAA token injection via `@saptools/cf-xsuaa`
- 🎯 pin a default CF context with `use`, then run with zero args

Docs → [`packages/bruno/README.md`](./packages/bruno/README.md)

### 🗄️ `@saptools/sqltools`

Exports SAP HANA service bindings from VCAP_SERVICES into VS Code SQLTools connections — from a file, stdin, or a live CF app.

- 📦 parse VCAP_SERVICES JSON and extract HANA credentials
- 🔌 write `.vscode/settings.json` with `sqltools.connections` ready to use
- ☁️ `from-app` pulls VCAP directly from a running CF app via `@saptools/cf-sync`
- 🔁 merge mode preserves existing unrelated connections

Docs → [`packages/sqltools/README.md`](./packages/sqltools/README.md)

### 🔁 `@saptools/gitport`

Ports one GitLab source MR into another repository as a Draft MR, preserving review context for clean ports and incoming auto-resolved conflicts.

- 🔗 source MR URL input, including GitLab tab URLs like `/diffs`
- 🍒 sequential `git cherry-pick -x` replay into a destination branch
- 📝 Draft MR creation with conflict excerpts for review

Docs → [`packages/gitport/README.md`](./packages/gitport/README.md)

---

## 🧱 Monorepo Tooling

The workspace uses:

- `pnpm` for package management
- `turbo` for task orchestration
- TypeScript + ESLint across packages

Common root commands:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test:unit
pnpm test:e2e
```

Run a command for one package only:

```bash
pnpm --filter @saptools/cf-sync build
pnpm --filter @saptools/cf-sync test:unit
```

---

## 🗂️ Repository Layout

```text
.
├── packages/
│   ├── cf-sync/
│   ├── cf-xsuaa/
│   ├── cf-debugger/
│   ├── bruno/
│   ├── sqltools/
│   └── gitport/
├── _backup/
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
