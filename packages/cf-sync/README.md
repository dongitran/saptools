<div align="center">

# ☁️ `@saptools/cf-sync`

**Map your entire SAP BTP Cloud Foundry landscape into a single JSON file — once.**

Walk every region, org, space, and app you have access to, write a stable snapshot to disk, and expose it to the rest of your toolchain via CLI or Node.js API — no more juggling `cf target`.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-sync.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-sync)
[![license](https://img.shields.io/npm/l/@saptools/cf-sync.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-sync.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/cf-sync)](https://packagephobia.com/result?p=@saptools/cf-sync)
[![types](https://img.shields.io/npm/types/@saptools/cf-sync.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🌍 **Full-landscape sync** — logs into CF once, walks **region → org → space → app** across every region you can reach
- ⚡ **Partial + streaming reads** — `read` / `regions` / `region` commands return whatever is already known, even while a long sync is in progress
- 🧠 **Smart fallbacks** — runtime state first, last stable snapshot next, on-demand fetch as a last resort
- 🧩 **CLI & typed API** — every command has a zero-config Node.js equivalent with full TypeScript definitions
- 📦 **Drop-in for other saptools** — the output file is the shared source of truth for packages like [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa)
- 🪶 **Small + boring** — two deps (`commander`, `ora`), no background daemons, no magic

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/cf-sync

# Or as a dependency
npm install @saptools/cf-sync
# pnpm add @saptools/cf-sync
# yarn add @saptools/cf-sync
```

> [!NOTE]
> Requires **Node.js ≥ 20** and the official **`cf` CLI** on `PATH` (v8 recommended).

---

## 🚀 Quick Start

```bash
# 1. Export your SAP SSO credentials (only used during sync)
export SAP_EMAIL="you@company.com"
export SAP_PASSWORD="your-sap-password"

# 2. Sync every accessible region in parallel
cf-sync sync --verbose

# 3. Read the snapshot back from anywhere — CLI, script, or Node process
cf-sync read | jq '.regions[] | {key, accessible}'
```

After the first sync, `~/.saptools/cf-structure.json` is ready for the rest of your tooling.

---

## 🧰 CLI

### 🔄 `cf-sync sync`

Run a live sync and write a new full snapshot. Use `--only` to limit which regions get walked.

```bash
cf-sync sync
cf-sync sync --verbose
cf-sync sync --no-interactive
cf-sync sync --only ap10,ap11,eu10
```

| Flag | Description |
| --- | --- |
| `--verbose` | Print progress lines |
| `--no-interactive` | Disable the spinner (use in CI) |
| `--only <keys>` | Sync only the listed region keys |

### 📖 `cf-sync read`

Print the best-available full structure as JSON — **always succeeds as long as something has been synced before.**

- Returns runtime state while a sync is in progress
- Falls back to the last stable snapshot otherwise

```bash
cf-sync read
```

### 🗺️ `cf-sync regions`

Print the list of regions (key + label + endpoint + accessibility).

- Returns the default SAP CF catalog while a first sync is still running
- Returns only synced regions with orgs once a snapshot exists

```bash
cf-sync regions
```

### 🎯 `cf-sync region <key>`

Print one region as JSON, fetching it on demand if it's missing.

```bash
cf-sync region eu10
cf-sync region eu10 --no-refresh
```

| Flag | Description |
| --- | --- |
| `--no-refresh` | Read cached data only, never call CF |

> [!TIP]
> `cf-sync region <key>` is the fastest way to answer *"what's in just this region right now?"* without walking everything.

---

## 🧑‍💻 Programmatic Usage

```ts
import {
  findRegion,
  getRegionView,
  readRegionsView,
  readStructure,
  readStructureView,
  runSync,
} from "@saptools/cf-sync";

// Run a sync from Node (great for scheduled jobs)
const result = await runSync({
  email: process.env["SAP_EMAIL"] ?? "",
  password: process.env["SAP_PASSWORD"] ?? "",
  onlyRegions: ["ap10", "ap11"],
  interactive: false,
});
console.log(`${result.accessibleRegions.length} regions reachable`);

// Read the last snapshot
const structure = await readStructure();
const ap10 = structure ? findRegion(structure, "ap10") : undefined;
console.log(`${ap10?.orgs.length ?? 0} orgs in ap10`);

// Partial / on-demand reads
const view = await readStructureView();           // best-available full view
const regions = await readRegionsView();          // region list only
const eu10 = await getRegionView({                // one region, auto-fetch if missing
  regionKey: "eu10",
  email: process.env["SAP_EMAIL"],
  password: process.env["SAP_PASSWORD"],
});
console.log(eu10?.source); // "runtime" | "stable" | "live"
```

<details>
<summary><b>📚 Full export list</b></summary>

| Export | Description |
| --- | --- |
| `runSync(options)` | Drive a full/partial sync |
| `readStructure()` | Last stable snapshot, or `undefined` |
| `readStructureView()` | Best-available full view with metadata |
| `readRegionsView()` | Region list only, with fallbacks |
| `readRegionView(key)` | One region from cached data |
| `getRegionView({ regionKey, ... })` | One region, fetching on demand if missing |
| `findRegion(structure, key)` | Look up a region by key |
| `findOrg(region, name)` | Look up an org within a region |
| `findSpace(org, name)` | Look up a space within an org |
| `findApp(space, name)` | Look up an app within a space |

</details>

---

## 📁 Output Files

All state lives under your home directory:

```text
~/.saptools/cf-structure.json     # last successful full sync (stable)
~/.saptools/cf-sync-state.json    # active runtime state, partial reads, sync metadata
~/.saptools/cf-sync-history.jsonl # append-only timeline of sync milestones for debugging
```

`cf-sync-history.jsonl` is newline-delimited JSON. Each entry records a timestamped milestone such as lock acquisition, region traversal, runtime merges, recoveries, and final completion/failure so you can reconstruct where a sync got stuck.

<details>
<summary><b>🔬 Shape of <code>cf-structure.json</code></b></summary>

```jsonc
{
  "syncedAt": "2026-04-18T00:00:00Z",
  "regions": [
    {
      "key": "ap10",
      "label": "Singapore",
      "apiEndpoint": "https://api.cf.ap10.hana.ondemand.com",
      "accessible": true,
      "orgs": [
        {
          "name": "my-org",
          "spaces": [
            {
              "name": "dev",
              "apps": [{ "name": "my-srv" }]
            }
          ]
        }
      ]
    }
  ]
}
```

</details>

> [!IMPORTANT]
> Prefer the CLI read commands or the exported APIs over parsing these files directly — the on-disk format is an implementation detail.

---

## ❓ FAQ

<details>
<summary><b>Do I have to re-enter my SAP credentials for every read?</b></summary>

No. `SAP_EMAIL` / `SAP_PASSWORD` are only used during `sync` (and by `cf-sync region <key>` when the region is missing locally). Pure read commands work offline.

</details>

<details>
<summary><b>How often should I sync?</b></summary>

As often as your CF topology changes in a way you care about — usually daily or weekly is plenty. `cf-sync sync --only ap10,eu10` keeps hot regions fresh without walking everything.

</details>

<details>
<summary><b>Is the output file safe to commit?</b></summary>

It doesn't contain secrets, but it **does** list every org, space, and app you can reach — so it leaks your landscape's structure. Keep it out of public repos.

</details>

<details>
<summary><b>How does this compare to <code>cf orgs</code> / <code>cf spaces</code>?</b></summary>

Those commands only act on the **currently targeted** region/org. `cf-sync` walks every region in one pass and gives you a unified, cached view — which is what every other saptools package consumes.

</details>

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-sync build
pnpm --filter @saptools/cf-sync typecheck
pnpm --filter @saptools/cf-sync test:unit
pnpm --filter @saptools/cf-sync test:e2e
```

The e2e suite hits live SAP BTP CF. Set `CF_SYNC_E2E_ONLY=ap10,eu10` (plus `SAP_EMAIL` / `SAP_PASSWORD`) to restrict the regions it walks in CI.

---

## 🌐 Related

- 🔐 [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa) — fetch XSUAA credentials and cached OAuth2 tokens for any CF app
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox

---

<div align="center">

Made with ❤️ for SAP BTP developers who'd rather script it than click it.

**License** · [MIT](./LICENSE)

</div>
