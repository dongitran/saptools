<div align="center">

# 🎯 `@saptools/bruno`

**A smart runner for [Bruno](https://www.usebruno.com) collections on SAP BTP Cloud Foundry.**

Scaffold a CF-aware collection, resolve requests by `region/org/space/app` shorthand, and let every `bru run` start with a fresh XSUAA token already injected — no more pasting `Authorization` headers into env files.

[![npm version](https://img.shields.io/npm/v/@saptools/bruno.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/bruno)
[![license](https://img.shields.io/npm/l/@saptools/bruno.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/bruno.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/bruno)](https://packagephobia.com/result?p=@saptools/bruno)
[![types](https://img.shields.io/npm/types/@saptools/bruno.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🏗️ **Interactive `setup-app`** — pick a region, org, space, and app from your cached CF landscape; get a ready-to-run Bruno folder with `__cf_*` metadata seeded into every env file
- 🧭 **Shorthand paths** — run by `region/org/space/app` (or `.../folder/file.bru`) instead of deep relative paths
- 🔐 **Automatic XSUAA tokens** — every `run` fetches (or reuses the cached) token via [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa) and passes it to `bru` as `--env-var accessToken=…`
- 🗂️ **Default context** — `saptools-bruno use <shorthand>` pins a target so subsequent `run` calls need zero arguments
- 🧩 **CLI & typed API** — every command has a zero-config Node.js equivalent with full TypeScript definitions
- 🪶 **Small + boring** — three deps (`commander`, `@inquirer/prompts`, `@saptools/*`), no background daemons, no magic

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/bruno

# Or as a dependency
npm install @saptools/bruno
# pnpm add @saptools/bruno
# yarn add @saptools/bruno
```

> [!NOTE]
> Requires **Node.js ≥ 20**, the official **[`bru` CLI](https://www.npmjs.com/package/@usebruno/cli)** on `PATH`, and a cached CF landscape from [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync).

---

## 🚀 Quick Start

```bash
# 1. Sync your CF landscape once (from @saptools/cf-sync)
cf-sync sync

# 2. Scaffold an app folder with seeded __cf_* metadata
saptools-bruno setup-app

# 3. Pin a default CF context so future runs need zero args
saptools-bruno use ap10/my-org/dev/my-srv

# 4. Run — XSUAA token is fetched and injected automatically
saptools-bruno run --env dev
```

After `setup-app` your workspace looks like this:

```text
.
└── region__ap10/
    └── org__my-org/
        └── space__dev/
            └── my-srv/
                └── environments/
                    ├── dev.bru
                    └── prod.bru
```

Every env file starts with the CF coordinates needed for token lookup:

```text
vars {
  __cf_region: ap10
  __cf_org: my-org
  __cf_space: dev
  __cf_app: my-srv
  environment: dev
  baseUrl:
}
```

---

## 🧰 CLI

### 🏗️ `saptools-bruno setup-app`

Interactively scaffold a Bruno app folder inside the current root. Walks you through **region → org → space → app**, then lets you **pick which environments to create** and optionally **enter a custom env name**.

```bash
saptools-bruno setup-app
saptools-bruno --root ./collections setup-app
```

What you get:

- Folder tree: `region__<key>/org__<org>/space__<space>/<app>/environments/`
- One `.bru` env file per selection, each seeded with `__cf_region`, `__cf_org`, `__cf_space`, `__cf_app`, `environment`, and an empty `baseUrl`
- Existing env files are preserved; only missing `__cf_*` vars are patched back in

> [!TIP]
> The env prompt shows the common names (`local`, `dev`, `staging`, `prod`) plus any envs already on disk. Pre-existing envs are pre-checked; common ones are not — just check what you need. The custom-name field accepts `[A-Za-z0-9._-]+` for names like `qa-eu` or `uat.us`.

### ▶️ `saptools-bruno run`

Run a Bruno request or folder, auto-injecting a fresh XSUAA token as `accessToken`.

```bash
# Use the default context
saptools-bruno run --env dev

# Explicit shorthand
saptools-bruno run ap10/my-org/dev/my-srv --env dev

# Drill into a subfolder or file
saptools-bruno run ap10/my-org/dev/my-srv/users/get-all.bru --env dev

# Or pass a real path (absolute or relative)
saptools-bruno run ./region__ap10/org__my-org/space__dev/my-srv --env dev
```

| Flag | Description |
| --- | --- |
| `-e, --env <name>` | Environment name (default: current context or first discovered env) |
| `--root <dir>` | Root of the Bruno collection (default: `$SAPTOOLS_BRUNO_ROOT` or cwd) |

Under the hood this spawns `bru run <target> --env <name> --env-var accessToken=<token>` — your `.bru` requests reference `{{accessToken}}` like any normal Bruno variable.

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

// 1. Scaffold an app folder (BYO prompts)
const result = await setupApp({
  root: "./collections",
  prompts: {
    selectRegion: async (choices) => choices[0]!.value,
    selectOrg: async (choices) => choices[0]!.value,
    selectSpace: async (choices) => choices[0]!.value,
    selectApp: async (choices) => choices[0]!.value,
    confirmCreate: async () => true,
    selectEnvironments: async ({ common }) => [...common],
    inputCustomEnvName: async () => null,
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

// 4. Need the plan without actually spawning `bru`? (CI dry-runs, IDE integrations)
const plan = await buildRunPlan({
  root: "./collections",
  target: "ap10/my-org/dev/my-srv",
  environment: "dev",
});
console.log(plan.bruArgs); // ["run", "--env", "dev", "--env-var", "accessToken=..."]

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
| `COMMON_ENVIRONMENTS` | The default environment-name suggestions (`local`, `dev`, `staging`, `prod`) |
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
  __cf_org: my-org
  __cf_space: dev
  __cf_app: my-srv
  environment: dev
  baseUrl:
}
```

The `__cf_*` vars drive XSUAA lookup. `run` adds `accessToken` on the fly via `bru --env-var`, so your requests can simply reference `{{accessToken}}`.

</details>

> [!IMPORTANT]
> Prefer the CLI or the exported APIs over hand-editing these files — the on-disk format is parsed/rewritten by `setup-app` and re-setup will patch missing `__cf_*` vars back in.

---

## 🌱 Environment Variables

| Variable | Purpose |
| --- | --- |
| `SAPTOOLS_BRUNO_ROOT` | Default root for the Bruno collection when `--root` isn't passed |
| `SAPTOOLS_ACCESS_TOKEN` | Exported to the spawned `bru` process (alongside `--env-var accessToken=…`) |
| `SAP_EMAIL` / `SAP_PASSWORD` | Consumed by `@saptools/cf-xsuaa` when the token cache is cold |

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

After the checkbox prompt you'll see a **Custom environment name** field. Type any `[A-Za-z0-9._-]+` name (for example `qa-eu` or `uat.us`) and it gets scaffolded alongside the common ones.

</details>

<details>
<summary><b>Where does the token come from?</b></summary>

`@saptools/cf-xsuaa`. `runBruno` calls `getTokenCached({ region, org, space, app })` and reuses the local cache until it expires. You can inject your own fetcher via the `getTokenCached` option when using the API.

</details>

<details>
<summary><b>Can I use this without the CF-structured folder layout?</b></summary>

`run` accepts both shorthand (`region/org/space/app/...`) and real filesystem paths. However, `__cf_region/__cf_org/__cf_space/__cf_app` must be present in the env file — those are what drive the XSUAA lookup. Run `setup-app` once to bootstrap them.

</details>

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

The e2e suite uses a stub `bru` binary and fixture CF snapshots, so it runs fully offline.

---

## 🌐 Related

- ☁️ [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — sync every region / org / space / app into a single cached JSON file
- 🔐 [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa) — XSUAA credentials and cached OAuth2 tokens for any CF app
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox

---

<div align="center">

Made with ❤️ for SAP BTP developers who'd rather script their API tests than click them.

**License** · [MIT](./LICENSE)

</div>
