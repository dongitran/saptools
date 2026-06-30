<div align="center">

# ☁️ `@saptools/cf-sync`

**Map your SAP BTP Cloud Foundry topology and HANA app bindings into package-managed JSON files.**

Walk every region, org, space, and app you have access to, cache the topology, then optionally collect app-level HANA credentials in a background sync — no more juggling `cf target` or hand-running `cf env`.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-sync.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-sync)
[![license](https://img.shields.io/npm/l/@saptools/cf-sync.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-sync.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/cf-sync)](https://packagephobia.com/result?p=@saptools/cf-sync)
[![types](https://img.shields.io/npm/types/@saptools/cf-sync.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🌍 **Full-landscape sync** — logs into CF once, walks **region → org → space → app** across every region you can reach
- 🟢 **App runtime metadata** — snapshots include requested state, instance counts, and routes from `cf apps`
- ⚡ **Partial + streaming reads** — `read` / `regions` / `region` commands return whatever is already known, even while a long sync is in progress
- 🧭 **Region org refresh** — `orgs` refreshes one region's org list without walking spaces or apps
- 🗄️ **Background DB binding sync** — `db-sync` can collect `VCAP_SERVICES.hana` credentials for every cached app or one app selector in the background
- 🧠 **Smart fallbacks** — runtime state first, last stable snapshot next, on-demand fetch as a last resort
- 🧩 **CLI & typed API** — every command has a zero-config Node.js equivalent with full TypeScript definitions
- 📦 **Drop-in for other saptools** — the output file is the shared source of truth for packages like [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa)
- 🪶 **Small + boring** — two deps (`commander`, `ora`), one-shot background workers only when requested, no resident daemon

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

# 3. Read the topology snapshot back from anywhere — CLI, script, or Node process
cf-sync read | jq '.regions[] | {key, accessible}'

# 4. Optionally collect HANA DB bindings for every cached app in the background
cf-sync db-sync
cf-sync db-read | jq '.metadata'
```

After the first topology sync, `~/.saptools/cf-structure.json` is ready for the rest of your tooling. If you run `db-sync`, the HANA binding snapshot is stored separately.

---

## 🧰 CLI

### 🔄 `cf-sync sync`

Run a live sync and write a topology snapshot. A full sync replaces the snapshot; `--only` refreshes the listed regions and merges them into the existing snapshot without removing other cached regions.

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

### 🧭 `cf-sync orgs <region>`

Refresh only the Cloud Foundry org names for one region and merge that list back into the shared topology snapshot.

- Updates only the requested region
- Preserves cached spaces/apps for orgs that still exist
- Removes stale org entries from that region only
- Adds newly discovered orgs with empty `spaces` until a targeted org, space, or full sync fills them in
- Uses an isolated `CF_HOME`, so it does not clobber your interactive CF CLI target

```bash
cf-sync orgs ap10
cf-sync orgs eu10 --verbose
```

### 🧭 `cf-sync org <region> <org>`

Refresh exactly one Cloud Foundry org and merge every refreshed space/app in that org back into the shared topology snapshot.

- Updates only the requested `region/org`
- Preserves sibling orgs and regions already present in the snapshot
- Fails without changing the stable snapshot when the requested org cannot be targeted
- Uses an isolated `CF_HOME`, so it does not clobber your interactive CF CLI target

```bash
cf-sync org ap10 my-org
cf-sync org eu10 my-org --verbose
```

### 🔁 `cf-sync space <region> <org> <space>`

Refresh exactly one Cloud Foundry space and merge the latest app metadata back into the shared topology snapshot.

- Updates only the requested `region/org/space`
- Preserves sibling orgs and spaces already present in the snapshot
- Uses an isolated `CF_HOME`, so it does not clobber your interactive CF CLI target
- Can run while a full `cf-sync sync` is active; the merge is serialized through the same runtime-state lock

```bash
cf-sync space ap10 my-org dev
cf-sync space eu10 my-org app --verbose
```

### 🗄️ `cf-sync db-sync [selector]`

Start a detached background worker that collects `VCAP_SERVICES.hana` credentials.

- with no selector: sync every app in the cached topology snapshot
- with `<app>`: sync one uniquely named app from the cached topology snapshot
- with `region/org/space/app`: sync one explicit app even if no topology snapshot exists yet

```bash
cf-sync db-sync
cf-sync db-sync orders-srv
cf-sync db-sync ap10/my-org/dev/orders-srv
```

> [!IMPORTANT]
> `cf-sync db-sync` persists HANA credentials to local disk under `~/.saptools/`. Treat that file like a secret.

### 📚 `cf-sync db-read [selector]`

Read the best available HANA binding snapshot as JSON.

- `cf-sync db-read` returns the full runtime/stable DB snapshot view
- `cf-sync db-read <selector>` returns one app binding view

```bash
cf-sync db-read
cf-sync db-read orders-srv
cf-sync db-read ap10/my-org/dev/orders-srv
```

---

## 📁 Output Files

All state lives under your home directory:

```text
~/.saptools/cf-structure.json     # last successful full sync (stable)
~/.saptools/cf-sync-state.json    # active runtime state, partial reads, sync metadata
~/.saptools/cf-sync-history.jsonl # append-only timeline of sync milestones for debugging
~/.saptools/cf-db-bindings.json   # last successful HANA binding snapshot (contains credentials)
~/.saptools/cf-db-sync-state.json # active DB binding runtime state
~/.saptools/cf-db-sync-history.jsonl # append-only DB sync milestones
```

`cf-sync-history.jsonl` is newline-delimited JSON. Each entry records a timestamped milestone such as lock acquisition, region traversal, runtime merges, recoveries, and final completion/failure so you can reconstruct where a sync got stuck.

`cf-db-bindings.json` is also newline-free JSON, but unlike the topology files it contains HANA credentials. Do not commit it, attach it to tickets, or paste it into logs.

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

No. `SAP_EMAIL` / `SAP_PASSWORD` are only used during `sync`, `db-sync`, and `cf-sync region <key>` when the region is missing locally. Pure read commands work offline.

</details>

<details>
<summary><b>How often should I sync?</b></summary>

As often as your CF topology changes in a way you care about — usually daily or weekly is plenty. `cf-sync sync --only ap10,eu10` keeps hot regions fresh without walking everything.

</details>

<details>
<summary><b>Is the output file safe to commit?</b></summary>

`cf-structure.json` does not contain secrets, but it **does** list every org, space, and app you can reach — so it leaks your landscape's structure. Keep it out of public repos.

`cf-db-bindings.json` is more sensitive: it contains HANA credentials by design. Treat it like a secret and never commit it.

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

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
