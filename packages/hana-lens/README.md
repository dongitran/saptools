<div align="center">

# 🔎 `@saptools/hana-lens`

**Build a compact SAP CAP CSN cache for fast entity search and dense schema descriptions.**

Scan every matching CAP package in a workspace, virtually link local siblings, compile each package in an isolated `@sap/cds` worker, then query one minified `.hana-lens-cache.json` — no more opening huge CSN files or loading an entire monorepo just to answer *"where is this entity and what columns does it have?"*

[![npm version](https://img.shields.io/npm/v/@saptools/hana-lens.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/hana-lens)
[![license](https://img.shields.io/npm/l/@saptools/hana-lens.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/hana-lens.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/hana-lens)](https://packagephobia.com/result?p=@saptools/hana-lens)
[![types](https://img.shields.io/npm/types/@saptools/hana-lens.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🧭 **Workspace package discovery** — recursively finds `package.json` files whose `name` starts with your CAP package prefix
- 🔗 **Virtual sibling links** — creates local `node_modules/<scope>` symlinks so cross-package CDS references resolve without publishing packages
- 🧪 **Isolated CAP compilation** — resolves `@sap/cds` from the analyzed workspace first, then runs one fresh Node.js worker per package
- 🧯 **Resilient cache builds** — skips individual model failures by default, reports them, and provides `--strict` CI enforcement
- 🏷️ **Origin-aware CSN** — injects `@hanaLens.packageName` into definitions so results show the package that produced each entity
- 🪶 **Minified mega cache** — writes `.hana-lens-cache.json` with plain `JSON.stringify(ast)` and no formatting whitespace
- 🔍 **Fuzzy + regex search** — returns deterministic definition and field matches, with explicit totals whenever bounded CLI output is truncated
- 🧾 **Dense descriptions** — preserves type parameters, arrays, enum members, keys, and computed markers in compact terminal-friendly lines
- 🛡️ **Safe association expansion** — follows `cds.Association` and `cds.Composition` targets with depth and circular-reference guards
- 🧩 **CLI & typed API** — core cache, search, describe, package scanning, and build functions are exported for scripts
- 🪶 **Small + boring** — zero bundled runtime dependencies, explicit CAP compiler requirements, and no resident daemon

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/hana-lens

# Or as a dependency
npm install @saptools/hana-lens
# pnpm add @saptools/hana-lens
# yarn add @saptools/hana-lens
```

> [!NOTE]
> Requires **Node.js ≥ 20**. `build-cache` requires **`@sap/cds`** in the analyzed workspace (recommended) or alongside the `hana-lens` CLI. The regex parser is available only with `--allow-fallback`; it is degraded and omits aspect-inheriting entities, projections, enums, and numeric precision.

---

## 🚀 Quick Start

```bash
# 1. Build one compact cache for every matching CAP package
hana-lens build-cache --dir ./workspace --prefix @my-cap/

# 2. Search definitions with typo-tolerant fuzzy matching
hana-lens search BusinesReq

# 3. Describe an entity in dense form
hana-lens describe my.service.BusinessRequest

# 4. Expand associations/compositions when you need nearby columns too
hana-lens describe my.service.BusinessRequest --expand
```

After the first cache build, `./workspace/.hana-lens-cache.json` is ready for offline `search` and `describe` commands. Run those commands from the directory that contains the cache.

---

## 🧰 CLI

### 🏗️ `hana-lens build-cache --dir <workspace_path> --prefix <package_prefix> [--allow-fallback] [--strict]`

Scan a CAP workspace, compile every matching package in isolation, and write a minified mega CSN cache.

```bash
hana-lens build-cache --dir ./workspace --prefix @my-cap/
hana-lens build-cache --dir ~/code/customer-cap --prefix @customer/
hana-lens build-cache --dir ./workspace --prefix @my-cap/ --strict
```

| Flag | Description |
| --- | --- |
| `--dir <workspace_path>` | Root directory to scan recursively |
| `--prefix <package_prefix>` | Package-name prefix to include, for example `@my-cap/` |
| `--allow-fallback` | Opt into the degraded regex parser only for packages where `@sap/cds` cannot be resolved |
| `--strict` | Abort if any package fails to compile or any definition name has conflicting shapes |

What it does:

- ignores `node_modules`, `.git`, `dist`, and `gen`
- stops recursion once it finds a matching package root
- resolves duplicate package names by folder match, then uses folder-derived fallbacks and excludes only fallbacks that still collide
- creates virtual sibling links under each package's `node_modules/<scope>`
- removes broken symlinks before relinking
- spawns one worker process per package before calling `@sap/cds.compile(['*'])`
- resolves `@sap/cds` from each analyzed package/workspace before trying the CLI installation
- skips failed packages with a bounded stderr summary by default; `--strict` restores abort-on-any-failure behavior
- annotates definitions with `@hanaLens.packageName`
- silently collapses identical shared definitions, while different definitions with the same fully qualified name warn and deterministically keep one, preferring persistence definitions over projections (`--strict` makes conflicts fatal)
- writes `.hana-lens-cache.json` as newline-free minified JSON

The success summary preserves `cached=`, `packages=`, and `file=`, then reports `compiled=`, `skipped=`, and `via=`. `packages=` is the discovered total, `compiled=` counts successful workers (including empty CSN payloads), and `skipped=` counts failed workers. `via=cds` means every successful package used CAP compilation; `via=fallback` means every successful package used the degraded parser; mixed builds report `via=cds+fallback(<count>)`. Any fallback use also prints a prominent degraded-cache warning to stderr.

> [!TIP]
> `build-cache` is the expensive step. Run it after model changes, then use `search` and `describe` repeatedly without recompiling the workspace.

### 🔍 `hana-lens search <keyword> [--regex]`

Search through cached `csn.definitions` keys and print up to 10 matches in dense `entity|package` form.

```bash
hana-lens search BusinesReq
hana-lens search businessrequest
hana-lens search '^my\.service\..*Request$' --regex
```

| Flag | Description |
| --- | --- |
| `--regex` | Treat `<keyword>` as a JavaScript regular expression and disable fuzzy matching |

Example output:

```text
my.service.BusinessRequest|@my-cap/sales
my.service.BusinessRequestItem|@my-cap/sales
```

Default mode is case-insensitive and typo-tolerant, ordered by fuzzy score and then definition name. Regex mode is best when you need exact namespaces, suffixes, or naming conventions; its matches are ordered by definition name. The typed API returns the full sorted set. When the CLI has more than 10 results, it appends `... showing 10 of M matches` after the visible rows.

### 🔎 `hana-lens search-field <keyword> [--regex]`

Search cached element names and report every matching field, including multiple matches from the same entity. Results are ordered by score, entity name, and field name; the CLI prints up to 25 rows and appends `... showing 25 of M matches` when more are available.

```text
Field matching "status" found in:
- my.service.BusinessRequest (exact match)
- my.service.BusinessRequest (matched: statusText)
```

### 🧾 `hana-lens describe <entity_name> [--expand]`

Print one cached entity's elements without padded columns, tables, or emojis.

```bash
hana-lens describe my.service.BusinessRequest
hana-lens describe my.service.BusinessRequest --expand
```

| Flag | Description |
| --- | --- |
| `--expand` | Follow `cds.Association` and `cds.Composition` targets with a safety depth limit |

Dense output example:

```text
[PK] reqID: cds.String(36)
[computed] createdAt: cds.Timestamp
amount: cds.Decimal(3, 1)
history: array of cds.Map
labels: array of { value, label }
customer: cds.Association
- [PK] ID: cds.Integer
- name: cds.String(80)
```

`[PK]` is printed only for `key: true` elements; `[computed]` marks `@Core.Computed` elements. Named enum definitions render their base type and keys, for example `cds.String enum[SUBMITTED, REJECTED]`. Expansion reports compact `missing` or `circular` markers when a target cannot be expanded safely.

---

## 📁 Output Files

`hana-lens` writes one cache file in the workspace directory you pass to `build-cache`:

```text
<workspace>/.hana-lens-cache.json # minified merged CSN definitions with @hanaLens.packageName metadata
```

The cache is intentionally newline-free JSON to reduce disk I/O and make follow-up reads cheap. It is generated state and should not be committed.

<details>
<summary><b>🔬 Shape of <code>.hana-lens-cache.json</code></b></summary>

```jsonc
{
  "definitions": {
    "my.service.BusinessRequest": {
      "kind": "entity",
      "@hanaLens.packageName": "@my-cap/sales",
      "elements": {
        "reqID": { "key": true, "type": "cds.String", "length": 36 },
        "customer": { "type": "cds.Association", "target": "my.master.Customer" }
      }
    }
  }
}
```

</details>

> [!IMPORTANT]
> Prefer the CLI commands or exported APIs over hand-editing the cache. Rebuild it from source CAP models whenever the workspace changes.

---

## 🧩 Typed API

```ts
import { describeEntity, readCache, searchDefinitions } from "@saptools/hana-lens";

const cache = await readCache("./workspace");
const matches = searchDefinitions(cache, "BusinesReq", false);
const description = describeEntity(cache, matches[0].name, true);
```

Exported helpers include cache IO, workspace package scanning/linking, cache building, search, and describe functions.

---

## ❓ FAQ

<details>
<summary><b>Why does <code>build-cache</code> create symlinks?</b></summary>

CAP workspaces often reference sibling packages before they are published or installed. The virtual auto-linker mirrors those siblings into each package's `node_modules/<scope>` so `@sap/cds` can resolve local models during isolated compilation.

</details>

<details>
<summary><b>Why compile each package in a separate process?</b></summary>

`@sap/cds` keeps process-level compiler state. Compiling many packages in one Node.js process can merge models incorrectly or crash. `hana-lens` avoids that by spawning one worker per package.

</details>

<details>
<summary><b>Is <code>.hana-lens-cache.json</code> safe to commit?</b></summary>

Usually no. It is generated local state and may reveal internal entity names, namespaces, associations, and package structure. Keep it out of git and rebuild it locally or in CI when needed.

</details>

<details>
<summary><b>Does <code>search</code> recompile CAP models?</b></summary>

No. `search` and `describe` only read `.hana-lens-cache.json`. Re-run `build-cache` after changing CDS models or package boundaries.

</details>

<details>
<summary><b>What happens with circular associations?</b></summary>

`describe --expand` tracks visited targets and prints a compact `circular` marker instead of recursing forever.

</details>

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/hana-lens build
pnpm --filter @saptools/hana-lens typecheck
pnpm --filter @saptools/hana-lens lint
pnpm --filter @saptools/hana-lens test:unit
pnpm --filter @saptools/hana-lens test:e2e
```

The e2e suite uses temporary mock CAP workspaces and the built `dist/cli.js`; it does not require live SAP BTP, CF, or SharePoint credentials.

---

## 🗒️ Changelog

### `0.3.2` — RC2-B

- preserves CAP type fidelity in `describe` for Decimal precision/scale, scalar and anonymous-struct arrays, and named enum definitions
- separates `[PK]` (`key: true`) from `[computed]` (`@Core.Computed`)
- returns full deterministic definition and field search results from the APIs while bounding CLI output to 10/25 rows with honest `... showing N of M matches` totals
- leaves compilation, cache schema, and `build-cache` package scope unchanged

### `0.3.1` — RC1

- resolves `@sap/cds` workspace-first and CLI-second, fails closed when CDS is entirely unavailable, and makes degraded fallback explicit with `--allow-fallback` plus `via=` reporting
- isolates per-package compiler failures with deterministic settled outcomes and summaries; `--strict` aborts for CI
- replaces unconditional duplicate-name failures with signature-aware identical-definition collapse and visible conflict handling
- keeps cache reads and the `search`, `search-field`, `references`, and `describe` output formats unchanged

---

## 🌐 Related

- ☁️ [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — cache SAP BTP Cloud Foundry topology and HANA DB bindings
- 🔐 [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa) — fetch XSUAA credentials and cached OAuth2 tokens for CF apps
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
