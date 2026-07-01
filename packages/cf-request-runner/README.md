<div align="center">

# 🏃 `@saptools/cf-request-runner`

**Auto-discover all API endpoints of an SAP CAP CDS service deployed on Cloud Foundry.**

Automatically walk your remote CAP service documents, OData `$metadata`, and `endpoints` catalog, perform deep entity expansion, and safely fall back to container SSH to parse `.cds` files — no more guessing routes or reading manual documentation.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-request-runner.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-request-runner)
[![license](https://img.shields.io/npm/l/@saptools/cf-request-runner.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-request-runner.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![types](https://img.shields.io/npm/types/@saptools/cf-request-runner.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🌍 **Root Endpoint Discovery** — fetches root service documents and catalogs from a deployed CAP service dynamically.
- 🟢 **Deep Entity Discovery** — reads OData `$metadata` before falling back to service documents to infer entity and operation endpoints.
- ⚡ **CF SSH Fallback** — if runtime requests are blocked or hidden, falls back to `cf ssh` to run a headless script parsing `.cds` definitions.
- 🧭 **Zero Configuration** — seamlessly integrates with your active Cloud Foundry CLI (`cf target`) session. No complex credential management required.
- 🗄️ **Programmatic API** — exports fully typed methods for deep integrations in other Node.js apps.
- 📋 **Copy-Ready Curl** — emits ready-to-run `curl` commands for each endpoint/method with the resolved bearer token already injected.
- 🧪 **Interactive Runner** — select an endpoint and method, enter JSON for write requests, and print the formatted response from the CLI.
- 🧠 **Smart Fallbacks** — safely handles missing `cf` CLI sessions, invalid tokens, or restricted network environments.

---

## 📦 Install

```bash
npm install -g @saptools/cf-request-runner
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

# 4. Generate copy-ready curl commands
cf-request-runner -a my-cap-app -u https://... --curl

# 5. Run an endpoint interactively
cf-request-runner -a my-cap-app -u https://... --interactive
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
| `--token <bearerToken>` | | Bearer token override. Prefer `CF_REQUEST_RUNNER_TOKEN` for sensitive tokens. | No |
| `--json` | | Output the results in strict JSON format. | No |
| `--out <filePath>` | | Save JSON output to a specific file. Missing parent directories are created automatically. | No |
| `--curl` | | Output copy-ready curl commands for every discovered endpoint and method. Includes the resolved bearer token when available. | No |
| `--interactive` | `-i` | Select and execute a discovered endpoint from the CLI. Prompts for JSON payloads on write methods. | No |
| `--help` | `-h` | Display help for command. | No |


### Copy and run requests

Generate curl commands for all discovered endpoint/method combinations:

```bash
cf-request-runner -a my-cap-app -u https://my-cap-app.example.com --curl
```

> [!WARNING]
> `--curl` intentionally includes the resolved bearer token in the `Authorization` header so commands are immediately runnable. Treat this output as sensitive and avoid pasting it into logs or chat.

Run a request interactively from the CLI:

```bash
cf-request-runner -a my-cap-app -u https://my-cap-app.example.com --interactive
```

Interactive mode prompts for an endpoint, a supported method, and a JSON payload for `POST`, `PUT`, and `PATCH` requests, then prints the response status, headers, and body.

For token-based runs, prefer an environment variable so the bearer token is not saved in shell history:

```bash
CF_REQUEST_RUNNER_TOKEN="$TOKEN" cf-request-runner -a my-cap-app -u https://my-cap-app.example.com --json
```

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
