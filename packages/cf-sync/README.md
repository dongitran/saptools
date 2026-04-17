<div align="center">

# ☁️ `@saptools/cf-sync`

**Sync your SAP BTP Cloud Foundry landscape into a clean local JSON snapshot.**

[![GitHub Repo](https://img.shields.io/badge/repo-dongitran%2Fsaptools-181717?style=flat-square&logo=github)](https://github.com/dongitran/saptools)
[![GitHub Stars](https://img.shields.io/github/stars/dongitran/saptools?style=flat-square)](https://github.com/dongitran/saptools/stargazers)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](https://github.com/dongitran/saptools)

`@saptools/cf-sync` authenticates against SAP BTP Cloud Foundry, walks **region → org → space → app**, and exposes the result through both package APIs and package-managed snapshots.

Built for automation, local tooling, and other `@saptools/*` packages that need a reliable view of your CF topology.

</div>

---

## ✨ Why This Package Exists

Cloud Foundry structure is easy to inspect manually, but painful to reuse in scripts and local tools. `@saptools/cf-sync` gives you a repeatable way to:

- 🧭 discover which CF regions are accessible with your account
- 🏢 enumerate orgs, spaces, and deployed apps
- 💾 persist the result as a stable JSON file for later use
- 🔌 let other tools call the package for reads instead of parsing JSON files themselves
- ⚡ serve targeted region reads even while a long sync is still running

---

## 🚀 Highlights

- 🌍 **Cross-region sync** with a curated SAP BTP CF region catalog
- 🧱 **Stable snapshot** written to `~/.saptools/cf-structure.json`
- 🪄 **Package-managed runtime state** for partial reads during an active sync
- 🛠️ **CLI and library API** in one package
- 🔎 **Focused sync** with `--only` when you want a smaller region subset
- 🧯 **Resilient traversal** that records inaccessible regions instead of crashing the whole run
- 🚦 **Concurrent-safe reads** with isolated `CF_HOME` sessions for background syncs and on-demand region fetches
- 🤖 **Automation-friendly** for CI jobs, local scripts, and dependent packages

---

## 📦 Installation

Install globally if you want the CLI on your shell path:

```bash
npm install -g @saptools/cf-sync
```

Or install it as a dependency:

```bash
npm install @saptools/cf-sync
```

---

## ✅ Requirements

Before running the sync:

- `Node.js >= 20`
- the `cf` CLI must be installed and available on `PATH`
- `SAP_EMAIL` must be set
- `SAP_PASSWORD` must be set

Example:

```bash
export SAP_EMAIL="your.name@company.com"
export SAP_PASSWORD="your-password"
```

---

## ⚡ Quick Start

Run a full sync:

```bash
cf-sync sync
```

Show progress lines instead of only the spinner:

```bash
cf-sync sync --verbose
```

Limit the run to specific regions:

```bash
cf-sync sync --only ap10,ap11
```

Read the best available package-managed structure view:

```bash
cf-sync read
```

Read one region, fetching it immediately if it is not already cached and credentials are available:

```bash
cf-sync region eu10
```

Typical success output:

```text
✔ Structure written to /Users/you/.saptools/cf-structure.json
  Accessible regions: 2
  Inaccessible regions: 39
```

---

## 🧾 Output

The package keeps two package-managed snapshots:

```text
~/.saptools/cf-structure.json
~/.saptools/cf-sync-state.json
```

- `cf-structure.json` is the last successful full sync
- `cf-sync-state.json` is the active runtime state used internally for partial reads and sync metadata

Shape:

```json
{
  "syncedAt": "2026-04-17T21:18:08.124Z",
  "regions": [
    {
      "key": "ap10",
      "label": "Australia (Sydney) - AWS (ap10)",
      "apiEndpoint": "https://api.cf.ap10.hana.ondemand.com",
      "accessible": true,
      "orgs": [
        {
          "name": "my-org",
          "spaces": [
            {
              "name": "dev",
              "apps": [{ "name": "orders-api" }]
            }
          ]
        }
      ]
    }
  ]
}
```

Services should prefer the package APIs and CLI read commands instead of parsing these files directly.

---

## 🖥️ CLI Reference

### `cf-sync sync`

Authenticate and walk **region → org → space → app** for all accessible CF regions.

Options:

- `--verbose` print progress lines to stdout
- `--no-interactive` disable the spinner, useful in CI or non-TTY environments
- `--only <keys>` comma-separated region keys such as `ap10,ap11`

Examples:

```bash
cf-sync sync --verbose
cf-sync sync --no-interactive
cf-sync sync --only eu10,eu20,us10
```

### `cf-sync read`

Print the current package-managed structure view as JSON.

When a sync is running, this returns the runtime view with metadata such as completed and pending regions. When no runtime state exists, it falls back to the stable snapshot.

### `cf-sync region <key>`

Print a single region as JSON.

Behavior:

- returns the region immediately from runtime state when already available
- falls back to the stable snapshot when no refresh is possible
- fetches the region immediately when it is missing and credentials are available

Options:

- `--no-refresh` read only from cached package-managed state

---

## 🧠 Programmatic Usage

Use the package directly from Node.js:

```ts
import {
  findRegion,
  getRegionView,
  readStructure,
  readStructureView,
  runSync,
} from "@saptools/cf-sync";

const result = await runSync({
  email: process.env["SAP_EMAIL"] ?? "",
  password: process.env["SAP_PASSWORD"] ?? "",
  interactive: false,
  onlyRegions: ["ap10", "ap11"],
});

console.log(result.accessibleRegions);

const structure = await readStructure();
if (structure) {
  const ap10 = findRegion(structure, "ap10");
  console.log(ap10?.orgs.length ?? 0);
}

const view = await readStructureView();
console.log(view?.metadata?.status);

const eu10 = await getRegionView({
  regionKey: "eu10",
  email: process.env["SAP_EMAIL"],
  password: process.env["SAP_PASSWORD"],
});
console.log(eu10?.source);
```

Exports include:

- `runSync`
- `readStructure`
- `readStructureView`
- `readRegionView`
- `getRegionView`
- `readRuntimeState`
- `writeStructure`
- `findRegion`
- `findOrg`
- `findSpace`
- `findApp`
- region metadata and TypeScript types

---

## 🛡️ Failure Model

The sync is intentionally tolerant:

- if a region cannot be authenticated, it is marked `accessible: false`
- if an org or space cannot be targeted, that branch is skipped and the run continues
- if the output directory does not exist, it is created automatically
- if another full sync is already running in the same package state directory, the next caller reuses that in-flight result instead of starting a duplicate global scan
- if a specific region is requested while the full sync is still busy elsewhere, the package can hydrate that region immediately without sharing the same mutable `cf` CLI session

That gives you a useful partial snapshot instead of an all-or-nothing failure for routine CF access issues.

---

## 🔗 Related Packages

This package is part of the [`dongitran/saptools`](https://github.com/dongitran/saptools) monorepo.

- [`@saptools/cf-xsuaa`](https://github.com/dongitran/saptools/tree/main/packages/cf-xsuaa) for extracting XSUAA credentials and access tokens
- `@saptools/bruno` for CF-aware Bruno workflows

---

## 🧪 Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-sync build
pnpm --filter @saptools/cf-sync typecheck
pnpm --filter @saptools/cf-sync test:unit
pnpm --filter @saptools/cf-sync test:e2e
```

---

## 🤝 Author

Maintained by [dongtran](https://github.com/dongitran).

---

## 📄 License

MIT
