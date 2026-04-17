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

This repository is now organized as a monorepo under [`packages/`](./packages).

Current tracked package:

- [`@saptools/cf-sync`](./packages/cf-sync) syncs **region → org → space → app** from SAP BTP Cloud Foundry into `~/.saptools/cf-structure.json`

Archived code snapshot:

- [`_backup/`](./_backup) keeps the previous single-package implementation for reference during the migration

---

## 🚀 Package Focus

### ☁️ `@saptools/cf-sync`

`@saptools/cf-sync` is the first package being moved into the monorepo. It provides:

- 🌍 SAP BTP CF region discovery
- 🏢 org / space / app traversal
- 💾 structured JSON output for local tooling
- 🛠️ both a CLI and a reusable TypeScript API

Package docs live here:

- [`packages/cf-sync/README.md`](./packages/cf-sync/README.md)

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
│   └── cf-sync/
├── _backup/
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

---

## 🔗 GitHub

- Repository: https://github.com/dongitran/saptools
- Issues: https://github.com/dongitran/saptools/issues

---

## 🤝 Author

Maintained by [dongtran](https://github.com/dongitran).

