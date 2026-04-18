<div align="center">

# 🔐 `@saptools/cf-xsuaa`

**Stop copy-pasting XSUAA tokens from the BTP cockpit.**

Fetch XSUAA credentials and OAuth2 access tokens from SAP BTP Cloud Foundry apps — straight from your terminal, with intelligent caching built in.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-xsuaa.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-xsuaa)
[![license](https://img.shields.io/npm/l/@saptools/cf-xsuaa.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-xsuaa.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/cf-xsuaa)](https://packagephobia.com/result?p=@saptools/cf-xsuaa)
[![types](https://img.shields.io/npm/types/@saptools/cf-xsuaa.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🔑 **Zero-config OAuth2** — fetches `client_credentials` tokens straight from the XSUAA binding of any CF app
- 💾 **Smart caching** — reuses tokens until they expire, with a 45-second safety buffer so you never ship a stale JWT
- 🧩 **CLI & API** — drop into shell scripts, Node pipelines, or your favorite test runner
- 🔗 **CF-aware** — resolves CF API endpoints from region keys via `@saptools/cf-sync`, no manual URLs
- 🔒 **Type-safe** — shipped with full TypeScript definitions
- 🪶 **Tiny** — one dependency (`commander`) and zero runtime magic

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/cf-xsuaa

# Or as a dependency
npm install @saptools/cf-xsuaa
# pnpm add @saptools/cf-xsuaa
# yarn add @saptools/cf-xsuaa
```

> [!NOTE]
> Requires **Node.js ≥ 20** and the **`cf` CLI** on `PATH`. For the first secret fetch, set `SAP_EMAIL` and `SAP_PASSWORD`.

---

## 🚀 Quick Start

```bash
# 1. Tell cf-xsuaa who you are (only needed for the first secret fetch)
export SAP_EMAIL="you@company.com"
export SAP_PASSWORD="your-sap-password"

# 2. Grab a token (auto-fetches the XSUAA binding on first call, caches it forever)
cf-xsuaa get-token-cached \
  --region ap10 --org my-org --space dev --app my-srv
```

That's it. Copy the printed JWT into `curl`, `Postman`, `bruno`, or wherever you need it. Next call reuses the cached token until it expires.

---

## 🧰 CLI

Every command identifies an app with the same four flags:

| Flag | Description | Example |
| --- | --- | --- |
| `-r, --region <key>` | CF region key | `ap10`, `eu10`, `us10` |
| `-o, --org <name>` | CF org name | `my-org` |
| `-s, --space <name>` | CF space name | `dev` |
| `-a, --app <name>` | CF app name | `my-srv` |

### 🔎 `cf-xsuaa fetch-secret`

Pull the XSUAA client credentials out of the app's `VCAP_SERVICES` and cache them to disk. Run this once per app, or whenever the binding rotates.

```bash
cf-xsuaa fetch-secret --region ap10 --org my-org --space dev --app my-srv
```

### 🎟️ `cf-xsuaa get-token`

Fetch a **fresh** OAuth2 `client_credentials` token and print the JWT to stdout. Auto-runs `fetch-secret` first if the binding isn't cached yet.

```bash
cf-xsuaa get-token --region ap10 --org my-org --space dev --app my-srv
```

### ⚡ `cf-xsuaa get-token-cached`

Return the cached token if it's still valid, otherwise fetch a new one. **This is what you want 99% of the time.**

```bash
TOKEN=$(cf-xsuaa get-token-cached --region ap10 --org my-org --space dev --app my-srv)
curl -H "Authorization: Bearer $TOKEN" https://my-srv.cfapps.ap10.hana.ondemand.com/api/health
```

> [!TIP]
> Tokens are treated as expired 45 seconds before their `exp` claim, so callers never hand out a nearly-expired JWT.

---

## 🧑‍💻 Programmatic Usage

```ts
import {
  fetchSecret,
  getToken,
  getTokenCached,
  readStore,
  xsuaaDataPath,
} from "@saptools/cf-xsuaa";

const ref = {
  region: "ap10",
  org: "my-org",
  space: "dev",
  app: "my-srv",
} as const;

// One-time: cache the client credentials
await fetchSecret(ref);

// Every call: reuse a cached token when possible
const token = await getTokenCached(ref);

// Or: force a fresh token
const freshToken = await getToken(ref);

// Introspect the cache
const store = await readStore();
console.log(`${store.entries.length} apps cached in ${xsuaaDataPath()}`);
```

### 🧪 Dependency injection (great for tests)

```ts
await getToken(ref, {
  fetchCredentials: async () => ({
    clientId: "cid",
    clientSecret: "csec",
    url: "https://uaa.example.com",
  }),
  fetchToken: async () => "fake-jwt",
  now: new Date("2026-04-18T00:00:00Z"),
});
```

<details>
<summary><b>📚 Full export list</b></summary>

| Export | Description |
| --- | --- |
| `fetchSecret(ref)` | Cache a freshly-fetched XSUAA binding |
| `getToken(ref)` | Force a new OAuth2 token |
| `getTokenCached(ref)` | Reuse cache, fall through on expiry |
| `readStore()` / `writeStore(store)` | Read / write the on-disk store |
| `findEntry(store, ref)` | Look up a single entry |
| `upsertSecret(store, ref, creds)` | Merge credentials into a store |
| `upsertToken(store, ref, token)` | Merge a token into a store |
| `fetchClientCredentialsToken(creds)` | Low-level UAA call |
| `parseXsuaaFromVcap(stdout)` | Parse `cf env` output |
| `decodeJwtPayload(jwt)` | Decode the JWT payload without verification |
| `computeExpiryIso(jwt)` / `isExpired(iso)` | Expiry math |
| `xsuaaDataPath()` / `saptoolsDir()` | Resolve on-disk paths |

</details>

---

## 📁 Output File

All state lives in a single JSON file under your home directory:

```text
~/.saptools/xsuaa-data.json
```

<details>
<summary><b>🔬 Shape of <code>xsuaa-data.json</code></b></summary>

```jsonc
{
  "version": 1,
  "entries": [
    {
      "region": "ap10",
      "org": "my-org",
      "space": "dev",
      "app": "my-srv",
      "credentials": {
        "clientId": "sb-xsappname!t123",
        "clientSecret": "<redacted>",
        "url": "https://my-org.authentication.ap10.hana.ondemand.com",
        "xsappname": "my-app!t123"
      },
      "token": {
        "accessToken": "eyJhbGciOi...",
        "expiresAt": "2026-04-18T12:34:56.000Z"
      },
      "fetchedAt": "2026-04-18T12:20:00.000Z"
    }
  ]
}
```

</details>

> [!IMPORTANT]
> Prefer the CLI or exported APIs over parsing this file directly — the on-disk format is an implementation detail.

---

## ❓ FAQ

<details>
<summary><b>Do I need <code>SAP_EMAIL</code> / <code>SAP_PASSWORD</code> on every call?</b></summary>

No. Those are only read when `cf-xsuaa` has to refresh the VCAP-bound **client secret**. Once the secret is cached, token refreshes go straight to the UAA with `client_credentials` — no SAP user credentials required.

</details>

<details>
<summary><b>How is this different from <code>cf oauth-token</code>?</b></summary>

`cf oauth-token` returns **your personal UAA token**. `cf-xsuaa` returns the **app's own service token** (issued to the XSUAA `clientId` in `VCAP_SERVICES`), which is what you actually need when calling the app's protected endpoints.

</details>

<details>
<summary><b>Is the cached token safe to commit?</b></summary>

**No.** `~/.saptools/xsuaa-data.json` contains `clientSecret` and live JWTs. It lives under your home directory and should never be checked into git.

</details>

<details>
<summary><b>How do I invalidate a cached secret?</b></summary>

Run `cf-xsuaa fetch-secret` again with the same `--region/--org/--space/--app` flags and the entry will be overwritten.

</details>

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-xsuaa build
pnpm --filter @saptools/cf-xsuaa typecheck
pnpm --filter @saptools/cf-xsuaa test:unit
pnpm --filter @saptools/cf-xsuaa test:e2e
```

The e2e suite **auto-discovers** a real CF app with an `xsuaa` service binding by scoring candidates from `~/.saptools/cf-structure.json`. To pin a specific target:

```bash
export E2E_TARGET="ap10/my-org/my-space/my-srv"
```

---

## 🌐 Related

- 📦 [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — sync the CF `region → org → space → app` tree to disk
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox

---

<div align="center">

Made with ❤️ for SAP BTP developers who refuse to click through the cockpit one more time.

**License** · [MIT](./LICENSE)

</div>
