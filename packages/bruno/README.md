<div align="center">

# 🎯 `@saptools/bruno`

### A smart runner for [Bruno](https://www.usebruno.com) collections on **SAP BTP Cloud Foundry.**

Scaffold a CF-aware collection. Resolve requests by `region/org/space/app` shorthand. Let every `bru run` start with a fresh XSUAA token already injected and written back to the selected env file — no more pasting `Authorization` headers into env files, no more manual token refresh dances.

[![npm version](https://img.shields.io/npm/v/@saptools/bruno.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/bruno)
[![downloads](https://img.shields.io/npm/dm/@saptools/bruno.svg?style=flat&color=success&logo=npm)](https://www.npmjs.com/package/@saptools/bruno)
[![license](https://img.shields.io/npm/l/@saptools/bruno.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/bruno.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![types](https://img.shields.io/npm/types/@saptools/bruno.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![build](https://img.shields.io/github/actions/workflow/status/dongitran/saptools/bruno.yml?style=flat&logo=github&label=CI)](https://github.com/dongitran/saptools/actions/workflows/bruno.yml)

[**Install**](#-install) · [**Quick Start**](#-quick-start) · [**CLI**](#-cli) · [**API**](#-programmatic-usage) · [**FAQ**](#-faq) · [**Roadmap**](#-roadmap)

</div>

---

## ⚡ At a glance

```console
$ saptools-bruno use ap10/demo-prod/api/orders-srv
✔ Default context set to ap10/demo-prod/api/orders-srv

$ saptools-bruno run --env dev
▶ bru run --env dev --env-var accessToken=eyJhbGciOi…  (cwd=…/orders-srv)
Running Folder Recursively
✓ GET /orders              204 OK   54ms
✓ POST /orders             201 Created 120ms
✓ GET /orders/:id          200 OK   48ms
All assertions passed ✓
```

You just ran Bruno against a production-grade XSUAA-protected service **without ever touching a token**. That's the entire pitch.

---

## ✨ Features

- 🏗️ **Interactive `setup-app`** — pick a region → org → space, then **search apps as you type** before choosing exactly the environments you want (or typing a custom name like `qa-eu`). Every env file is seeded with `__cf_*` metadata so the runner knows where to fetch a token.
- 🧭 **Shorthand paths** — `region/org/space/app[/folder/file.bru]` expands to the right filesystem path. No more `cd`-ing through nested folders.
- 🔐 **Automatic XSUAA tokens** — every `run` fetches (or reuses) a cached token via [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa), writes it into the selected env file as `accessToken`, and still injects it for `bru` at execution time.
- 📦 **Bundled Bruno CLI fallback** — if `bru` is already on your `PATH`, `saptools-bruno` uses it. If not, it falls back to the bundled [`@usebruno/cli`](https://www.npmjs.com/package/@usebruno/cli).
- 🎯 **Default context** — `saptools-bruno use <shorthand>` pins a target so subsequent `run` calls need zero arguments. Feels like `cf target` for Bruno.
- 🧩 **CLI & typed API** — every command has a zero-config Node.js equivalent. Full TypeScript definitions shipped. Bring your own prompts for headless/CI use.
- 🧪 **Fully tested** — 90 unit tests + 8 offline e2e tests (stub `bru` binary + fixture CF snapshot). No network required in CI.
- 🪶 **Small + boring** — three runtime deps, no background daemons, no plugin system, no magic.

---

## 😩 Before → 😎 After

<table>
<tr>
<th width="50%">Without <code>@saptools/bruno</code></th>
<th width="50%">With <code>@saptools/bruno</code></th>
</tr>
<tr>
<td valign="top">

```bash
# 1. Find the service creds on Cockpit
# 2. cf target -o demo-prod -s api
# 3. cf create-service-key orders-srv bruno-key
# 4. cf service-key orders-srv bruno-key
# 5. Copy clientid / clientsecret / url
# 6. curl -X POST $URL/oauth/token \
#    -u $CLIENT_ID:$CLIENT_SECRET \
#    -d grant_type=client_credentials
# 7. Copy access_token
# 8. Paste into environments/dev.bru
# 9. bru run --env dev
# 10. Token expires → goto 6
```

</td>
<td valign="top">

```bash
saptools-bruno use ap10/demo-prod/api/orders-srv
saptools-bruno run --env dev
```

*That's it. Token is cached, refreshed on expiry, written back to the env file, and injected automatically.*

</td>
</tr>
</table>

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/bruno

# Or as a project dependency
npm install @saptools/bruno
# pnpm add @saptools/bruno
# yarn add @saptools/bruno
```

> [!NOTE]
> Requires **Node.js ≥ 20** and a cached CF landscape from [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync). `@saptools/bruno` now bundles [`@usebruno/cli`](https://www.npmjs.com/package/@usebruno/cli) automatically, but still prefers an existing `bru` on `PATH` if you already have one installed.

---

## 🚀 Quick Start

```bash
# 1. Sync your CF landscape once (from @saptools/cf-sync)
cf-sync sync

# 2. Scaffold an app folder with seeded __cf_* metadata
saptools-bruno setup-app

# 3. Pin a default CF context so future runs need zero args
saptools-bruno use ap10/my-org/dev/my-srv

# 4. Run — XSUAA token is fetched, written to the env file, and injected automatically
saptools-bruno run --env dev
```

After `setup-app`, your workspace looks like this:

```text
.
└── region__ap10/
    └── org__my-org/
        └── space__dev/
            └── my-srv/
                ├── bruno.json
                └── environments/
                    ├── dev.bru
                    └── prod.bru
```

Each env file starts with the CF coordinates needed for token lookup:

```text
vars {
  __cf_region: ap10
  __cf_org:    my-org
  __cf_space:  dev
  __cf_app:    my-srv
  environment: dev
  baseUrl:
}
```

Your `.bru` requests reference `{{accessToken}}` like any other Bruno variable — the runner refreshes it into the selected env file before spawning Bruno.

---

## 🧰 CLI

### 🏗️ `saptools-bruno setup-app`

Interactively scaffold a Bruno app folder inside the current Bruno collection directory. Walks you through **region → org → space → app**, with the **app step using a searchable picker** for large spaces, then lets you **pick which environments to create** and add custom names without leaving the environment picker.

```bash
saptools-bruno setup-app
saptools-bruno --collection ./collections setup-app
```

> [!TIP]
> `--collection` only applies to the current command. If you omit it, `saptools-bruno` falls back to `$SAPTOOLS_BRUNO_COLLECTION`, then to your current working directory.

**What you get**

- An app-level `bruno.json` inside `region__<key>/org__<org>/space__<space>/<app>/`
- Folder tree: `region__<key>/org__<org>/space__<space>/<app>/environments/`
- One `.bru` env file per selection, each seeded with `__cf_region`, `__cf_org`, `__cf_space`, `__cf_app`, `environment`, and an empty `baseUrl`
- Existing env files are preserved; only missing `__cf_*` vars are patched back in

> [!TIP]
> The env prompt shows the common names (`local`, `dev`, `staging`, `prod`) plus any envs already on disk. Pre-existing envs are **pre-checked**; common ones are **not** — so you only create what you actually need. The menu also includes **Add custom environment**, and once you enter a value like `qa-eu` or `uat.us`, it appears back in the same checklist already selected so you can review the full set before finishing.

### ▶️ `saptools-bruno run`

Run a Bruno request or folder, refreshing `accessToken` in the chosen env file and auto-injecting the same token for the current execution.

```bash
# Use the default context
saptools-bruno run --env dev

# Explicit shorthand
saptools-bruno run ap10/my-org/dev/my-srv --env dev

# Drill into a subfolder or a single file
saptools-bruno run ap10/my-org/dev/my-srv/users/get-all.bru --env dev

# Or pass a real filesystem path (absolute or relative)
saptools-bruno run ./region__ap10/org__my-org/space__dev/my-srv --env dev
```

| Flag | Description |
| --- | --- |
| `-e, --env <name>` | Environment name (default: current context or first discovered env) |
| `--collection <dir>` | Bruno collection directory (default: `$SAPTOOLS_BRUNO_COLLECTION` or cwd) |

Under the hood this:
- fetches or reuses a token via `@saptools/cf-xsuaa`
- writes `accessToken: <token>` into the selected `.bru` env file
- spawns `bru run <target> --env <name> --env-var accessToken=<token>`

### 🎯 `saptools-bruno use`

Pin a default CF context so `run` can be called without arguments.

```bash
saptools-bruno use ap10/my-org/dev/my-srv
saptools-bruno use ap10/my-org/dev/my-srv --no-verify
```

| Flag | Description |
| --- | --- |
| `--no-verify` | Skip verifying the shorthand against the cached CF structure |

The context lives at `~/.saptools/bruno-context.json`.

---

## 🧑‍💻 Programmatic Usage

```ts
import {
  buildRunPlan,
  readContext,
  runBruno,
  scanCollection,
  setupApp,
  useContext,
} from "@saptools/bruno";

// 1. Scaffold an app folder (BYO prompts — perfect for headless/CI)
const result = await setupApp({
  root: "./collections",
  prompts: {
    selectRegion: async (choices) => choices[0]!.value,
    selectOrg:    async (choices) => choices[0]!.value,
    selectSpace:  async (choices) => choices[0]!.value,
    selectApp:    async (choices) => choices[0]!.value,
    confirmCreate: async () => true,
    selectEnvironments: async ({ common }) => [...common, "qa-eu"],
  },
});
console.log(`Created ${result.environments.length} env files at ${result.appPath}`);

// 2. Pin a default context for later runs
await useContext({ shorthand: "ap10/my-org/dev/my-srv" });

// 3. Run Bruno — token is fetched and injected for you
const run = await runBruno({
  root: "./collections",
  target: "ap10/my-org/dev/my-srv",
  environment: "dev",
});
process.exit(run.code);

// 4. Need the plan without spawning `bru`? (CI dry-runs, IDE integrations)
const plan = await buildRunPlan({
  root: "./collections",
  target: "ap10/my-org/dev/my-srv",
  environment: "dev",
});
console.log(plan.bruArgs);
// → ["run", "--env", "dev", "--env-var", "accessToken=..."]

// 5. Walk a whole collection to build a UI tree
const tree = await scanCollection("./collections");
console.log(tree.regions.map((r) => r.key));

// 6. Inspect the active default context
const ctx = await readContext();
console.log(ctx?.app);
```

<details>
<summary><b>📚 Full export list</b></summary>

| Export | Description |
| --- | --- |
| `setupApp(options)` | Interactive app-folder scaffolder with pluggable prompts |
| `COMMON_ENVIRONMENTS` | Default environment-name suggestions (`local`, `dev`, `staging`, `prod`) |
| `runBruno(options)` | Build a plan and spawn `bru run` with token injected |
| `buildRunPlan(options)` | Build the plan (args, cwd, env file, token) without spawning |
| `useContext({ shorthand, verify })` | Pin a default region/org/space/app context |
| `readContext()` | Read the pinned context, or `undefined` |
| `writeContext(ctx)` | Persist a new default context |
| `scanCollection(root)` | Walk the folder tree and return a typed `region → org → space → app → env` view |
| `parseShorthandPath(shorthand)` | Split `region/org/space/app[/file]` into a typed ref |
| `parseBruEnvFile(raw)` / `writeBruEnvFile(...)` | Minimal `.bru` env reader/writer |
| `readCfMetaFromFile(path)` / `writeCfMetaToFile(path, ref)` | Round-trip `__cf_*` vars in an env file |

</details>

---

## 📁 Folder Layout

All state lives under your home directory or your collection root:

```text
~/.saptools/bruno-context.json              # pinned region/org/space/app + updatedAt

<root>/
├── bruno.json
└── region__<key>/
    └── org__<org>/
        └── space__<space>/
            └── <app>/
                ├── environments/
                │   ├── dev.bru              # vars { __cf_region, __cf_org, ... }
                │   └── prod.bru
                └── <your .bru requests>
```

<details>
<summary><b>🔬 Shape of an env file after <code>setup-app</code></b></summary>

```text
vars {
  __cf_region: ap10
  __cf_org:    my-org
  __cf_space:  dev
  __cf_app:    my-srv
  environment: dev
  baseUrl:
}
```

The `__cf_*` vars drive XSUAA lookup. `run` adds `accessToken` on the fly via `bru --env-var`, so your requests can simply reference `{{accessToken}}`.

</details>

> [!IMPORTANT]
> Prefer the CLI or the exported APIs over hand-editing these files — the on-disk format is parsed and rewritten by `setup-app`, and re-setup will patch missing `__cf_*` vars back in.

---

## 🌱 Environment Variables

| Variable | Purpose |
| --- | --- |
| `SAPTOOLS_BRUNO_COLLECTION` | Default Bruno collection directory when `--collection` isn't passed |
| `SAPTOOLS_ACCESS_TOKEN` | Exported to the spawned `bru` process (alongside `--env-var accessToken=…`) |
| `SAP_EMAIL` / `SAP_PASSWORD` | Consumed by `@saptools/cf-xsuaa` when the token cache is cold |

---

## 🧭 How it compares

| Approach | XSUAA handling | Shorthand paths | CF-aware scaffolding | Cache/refresh | Works in CI |
| --- | :-: | :-: | :-: | :-: | :-: |
| Hand-edit `environments/*.bru` | ❌ manual | ❌ | ❌ | ❌ | ❌ |
| Bruno GUI OAuth2 | ✅ | ❌ | ❌ | partial | ❌ (GUI) |
| `bru run` alone | ❌ | ❌ | ❌ | ❌ | ✅ |
| **`saptools-bruno`** | ✅ **automatic** | ✅ | ✅ | ✅ | ✅ |

---

## 🧪 Quality

- **74** unit tests via Vitest (strict TS · ESLint · 80%+ branch coverage on core flows)
- **4** end-to-end tests via Playwright's test runner — stubbed `bru` binary, fixture CF snapshot, **zero network**
- Type-checked under `strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess` — the strictest realistic TS profile
- CI on every push (lint · typecheck · build · unit · e2e · `npm pack --dry-run`)
- npm publishes with **provenance** via GitHub OIDC trusted publishing

---

## ❓ FAQ

<details>
<summary><b>Why does Bruno need a wrapper — can't I just call <code>bru run</code>?</b></summary>

You can, but every CF service behind XSUAA needs a fresh OAuth2 token, and Bruno doesn't mint them. `saptools-bruno run` fetches the token (cached when possible), injects it as `accessToken`, and gets out of the way. Your `.bru` requests stay portable.

</details>

<details>
<summary><b>Do I have to re-run <code>setup-app</code> when CF changes?</b></summary>

Only when you add a new app folder. `setup-app` on an existing app is idempotent — it pre-checks existing envs, preserves their contents, and patches missing `__cf_*` vars back in.

</details>

<details>
<summary><b>How do I add an env that isn't <code>local</code> / <code>dev</code> / <code>staging</code> / <code>prod</code>?</b></summary>

Choose **Add custom environment** inside the checkbox list. After you type any `[A-Za-z0-9._-]+` name (for example `qa-eu` or `uat.us`), the prompt returns to the same checklist with that new environment already selected.

</details>

<details>
<summary><b>Where does the token come from?</b></summary>

[`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa). `runBruno` calls `getTokenCached({ region, org, space, app })` and reuses the local cache until it expires. You can inject your own fetcher via the `getTokenCached` option when using the API.

</details>

<details>
<summary><b>Can I use this without the CF-structured folder layout?</b></summary>

`run` accepts both shorthand (`region/org/space/app/...`) and real filesystem paths. However, `__cf_region/__cf_org/__cf_space/__cf_app` must be present in the env file — those are what drive the XSUAA lookup. Run `setup-app` once to bootstrap them.

</details>

<details>
<summary><b>How do I use this in CI?</b></summary>

Use the programmatic API with your own prompt stubs (every field just returns the value you want), or drive the CLI after injecting `SAP_EMAIL` / `SAP_PASSWORD` so the token cache can be populated on first run. The e2e suite of this repo is itself a CI-safe example.

</details>

---

## 🗺️ Roadmap

- [x] `setup-app` with selectable environments and custom-name input
- [x] Shorthand path resolution (`region/org/space/app[/file]`)
- [x] Default CF context via `use`
- [x] Offline e2e via stubbed `bru`
- [ ] `saptools-bruno doctor` — diagnose missing `__cf_*` vars, stale tokens, missing `bru`
- [ ] `saptools-bruno migrate` — move collections from a flat layout into the CF-aware layout
- [ ] First-class `--reporter json` support for piping test results into dashboards

Have an idea? [Open an issue](https://github.com/dongitran/saptools/issues/new) — the roadmap is driven by real use.

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/bruno build
pnpm --filter @saptools/bruno typecheck
pnpm --filter @saptools/bruno test:unit
pnpm --filter @saptools/bruno test:e2e
```

The e2e suite uses a stub `bru` binary and fixture CF snapshots, so it runs fully offline. Contributions, bug reports, and feature requests are all welcome — see the [issues tab](https://github.com/dongitran/saptools/issues).

---

## 🌐 Related

- ☁️ [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — sync every region / org / space / app into a single cached JSON file
- 🔐 [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa) — XSUAA credentials and cached OAuth2 tokens for any CF app
- 🐛 [`@saptools/cf-debugger`](https://www.npmjs.com/package/@saptools/cf-debugger) — open an SSH debug tunnel to any CF Node.js app from your terminal
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox

---

## 🤝 Contributors

<a href="https://github.com/dongitran/saptools/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=dongitran/saptools" alt="Contributors" />
</a>

---

<div align="center">

**Made with ❤️ for SAP BTP developers who'd rather script their API tests than click them.**

If this saved you an afternoon, consider ⭐ starring the [repo](https://github.com/dongitran/saptools) — it's the main thing that tells me to keep shipping.

**License** · [MIT](./LICENSE)

</div>
