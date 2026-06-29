<div align="center">

# 🏃 `@saptools/cf-request-runner`

**Auto-discover all API endpoints of an SAP CAP CDS service deployed on Cloud Foundry.**

Automatically walk your remote CAP `$metadata` and `endpoints` catalog, perform deep entity expansion, and safely fall back to container SSH to parse `.cds` files — no more guessing routes or reading manual documentation.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-request-runner.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-request-runner)
[![license](https://img.shields.io/npm/l/@saptools/cf-request-runner.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-request-runner.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![types](https://img.shields.io/npm/types/@saptools/cf-request-runner.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🌍 **Root Endpoint Discovery** — fetches root metadata and catalogs from a deployed CAP service dynamically.
- 🟢 **Deep Entity Discovery** — crawls and expands endpoints to discover all nested sub-entities and resources automatically.
- ⚡ **CF SSH Fallback** — if runtime requests are blocked or hidden, falls back to `cf ssh` to run a headless script parsing `.cds` definitions.
- 🧭 **Zero Configuration** — seamlessly integrates with your active Cloud Foundry CLI (`cf target`) session. No complex credential management required.
- 🗄️ **Programmatic API** — exports fully typed methods for deep integrations in other Node.js apps.
- 🧠 **Smart Fallbacks** — safely handles missing `cf` CLI sessions, invalid tokens, or restricted network environments.

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/cf-request-runner

# Or as a dependency
npm install @saptools/cf-request-runner
# pnpm add @saptools/cf-request-runner
# yarn add @saptools/cf-request-runner
```

> [!NOTE]
> Requires **Node.js ≥ 20** and the official **`cf` CLI** installed and targeted to a space.

---

## 🚀 Quick Start

```bash
# 1. Target your CF space
cf target -o my-org -s dev

# 2. Run the request runner discovery
cf-request-runner --app my-cap-app --url https://my-cap-app.cfapps.us10.hana.ondemand.com

# 3. Output as JSON for programmatic consumption
cf-request-runner -a my-cap-app -u https://... --json | jq '.'
```

---

## 🧰 CLI

### `cf-request-runner`

Executes the endpoint discovery script on a running application.

```bash
cf-request-runner --app <appId> --url <baseUrl>
```

| Flag | Shorthand | Description | Required |
| --- | --- | --- | --- |
| `--app <name>` | `-a` | Cloud Foundry application name. | Yes |
| `--url <baseUrl>` | `-u` | Base URL of the deployed application. | Yes |
| `--cf-home <dir>` | | Custom `CF_HOME` directory if using an isolated CF session. | No |
| `--json` | | Output the results in strict JSON format. | No |
| `--help` | `-h` | Display help for command. | No |

---

## 🧑‍💻 Programmatic Usage

You can use the exported discovery engine directly inside your own Node.js scripts:

```ts
import { discoverApiEntities, type ApiCatalogDiscoveryOptions } from '@saptools/cf-request-runner';

const options: ApiCatalogDiscoveryOptions = {
  appId: 'my-cap-app',
  baseUrl: 'https://my-cap-app.cfapps.us10.hana.ondemand.com',
  log: (msg) => console.log(`[INFO]: ${msg}`),
  onDeepDiscoveryStart: () => console.log('[START]: Deep discovery initiated'),
};

const endpoints = await discoverApiEntities(options);

console.log(`Discovered ${endpoints.length} endpoints!`);
endpoints.forEach((ep) => {
  console.log(`- ${ep.name} -> ${ep.path} [${ep.methods.join(', ')}]`);
});
```

<details>
<summary><b>📚 Full export list</b></summary>

| Export | Description |
| --- | --- |
| `discoverApiEntities(options)` | Discovers all available endpoints. |
| `runCfCommand(args, options)` | Wrapper to run CF CLI commands. |
| `fetchXsuaaTokenFromTarget(params)` | Fetches XSUAA client credentials via CF CLI. |
| `fetchRemoteCdsServicesFromTarget(params)` | Fetches `.cds` source via `cf ssh`. |
| `parseCdsServices(content)` | Parses source `.cds` contents into service paths. |
| `parseSubEntities(value, parent)` | Recursively parses sub-entities from an OData JSON result. |

</details>

---

## ❓ FAQ

<details>
<summary><b>Why do I need to pass the base URL manually?</b></summary>

The Cloud Foundry CLI can return multiple routes for a single app. Passing the exact base URL ensures we are calling the correct public-facing router, especially in complex landscapes.
</details>

<details>
<summary><b>Does this work for non-CAP applications?</b></summary>

While primarily built for SAP CAP (which exposes `$metadata` and `endpoints`), the CF SSH fallback strictly scans for `.cds` files. Non-CAP applications might not yield full results.
</details>

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-request-runner build
pnpm --filter @saptools/cf-request-runner typecheck
pnpm --filter @saptools/cf-request-runner test:unit
pnpm --filter @saptools/cf-request-runner test:e2e
```

---

## 🌐 Related

- 🔐 [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — Map your SAP BTP Cloud Foundry topology and HANA app bindings.
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox.

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
