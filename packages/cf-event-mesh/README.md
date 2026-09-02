<div align="center">

# ☁️ `@saptools/cf-event-mesh`

**Listen to or publish messages directly to SAP BTP Event Mesh from your terminal.**

Easily interact with AMQP queues or publish REST payloads to queues and topics without needing an external client like Postman or Advanced Event Mesh configurations.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-event-mesh.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-event-mesh)
[![license](https://img.shields.io/npm/l/@saptools/cf-event-mesh.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-event-mesh.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/cf-event-mesh)](https://packagephobia.com/result?p=@saptools/cf-event-mesh)
[![types](https://img.shields.io/npm/types/@saptools/cf-event-mesh.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🎧 **AMQP Listener** — stream live messages from an Event Mesh queue directly into your console
- 📤 **REST Publisher** — instantly publish JSON payloads to a queue or a topic
- 🔐 **Auto-Discovery** — seamlessly fetches credentials (clientid, clientsecret, tokens) via `cf env`
- 🛡️ **Safe by Default** — listening doesn't acknowledge messages by default, ensuring no data loss while debugging
- 🧩 **Zero Config** — just provide the app name bound to `enterprise-messaging`
- 🪶 **Lightweight** — no heavy dependencies, relies on Cloud Foundry CLI

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/cf-event-mesh

# Or as a dependency
npm install @saptools/cf-event-mesh
# pnpm add @saptools/cf-event-mesh
# yarn add @saptools/cf-event-mesh
```

> [!NOTE]
> Requires **Node.js ≥ 20** and the official **`cf` CLI** on `PATH` (v8 recommended).

---

## Updates

Every command first checks npm for a newer `@saptools/cf-event-mesh` (at most once an hour, one small request
with a 2-second timeout) and, when one exists, installs that exact version with the package manager
that owns the running binary and re-runs the command you typed on the new version. Both steps are
announced on stderr; nothing is printed when the install is already current:

```text
cf-event-mesh: updating 0.2.0 -> 0.3.0 ...
cf-event-mesh: updated to 0.3.0; re-running the command
```

If the install cannot complete, one stderr line gives the manual command and the command runs on the
installed version; that version is not retried for a day. `cf-event-mesh self-update` forces the check and
install now; `cf-event-mesh self-update --check` only reports.

| Control | Effect |
| --- | --- |
| `SAPTOOLS_AUTO_UPDATE=on\|notify\|off` | `on` (default) installs and re-runs; `notify` prints the manual command once per version; `off` never checks. Applies to every `@saptools` CLI. |
| `CF_EVENT_MESH_AUTO_UPDATE` | same values, this CLI only; wins over the global variable |
| `SAPTOOLS_UPDATE_INTERVAL_MINUTES` | minutes between checks (default `60`; `0` checks on every run) |
| `SAPTOOLS_NPM_REGISTRY` | registry to check and install from (default: npm's configured registry, then npmjs) |
| `SAPTOOLS_UPDATE_DEBUG=1` | explain on stderr why nothing happened |

The updater switches itself off in CI (`CI` set), under `NODE_ENV=test` or `NO_UPDATE_NOTIFIER`, when
the binary runs from a source checkout, an `npm link` or an `npx` cache, and inside the re-run itself.
It never writes to stdout, never asks for input, never uses `sudo`, and never moves onto a prerelease.
Its state lives in `~/.saptools/updates/`.

## 🚀 Quick Start

```bash
# 1. Make sure you are logged into Cloud Foundry and targeting a space
cf target -o my-org -s dev

# 2. Listen to a queue (messages are not acknowledged by default)
cf-event-mesh listen my-app-srv "namespace/queue-name"

# 3. Publish a message to a topic
cf-event-mesh publish my-app-srv topic "namespace/topic-name" '{"hello":"world"}'
```

---

## 🧰 CLI

### 🎧 `cf-event-mesh listen`

Connects to the Event Mesh queue via AMQP and streams incoming messages to the console.

```bash
cf-event-mesh listen <app-name> <queue-name>
cf-event-mesh listen <app-name> <queue-name> --ack
```

| Flag | Description |
| --- | --- |
| `--ack` | Acknowledge (delete) messages from the queue as they are received. **Warning:** this consumes the message permanently. |

### 📤 `cf-event-mesh publish`

Publishes a string payload to a specified queue or topic using the REST HTTP endpoint.

```bash
cf-event-mesh publish <app-name> queue <queue-name> '<payload>'
cf-event-mesh publish <app-name> topic <topic-name> '<payload>'
```

Example:
```bash
cf-event-mesh publish orders-srv topic "sap/s4/beh/salesorder/v1/SalesOrder/Created/v1" '{"SalesOrder":"10000001"}'
```

---

## ❓ FAQ

<details>
<summary><b>Does it support Advanced Event Mesh?</b></summary>

No. This package is specifically built for the default SAP Event Mesh (`enterprise-messaging` service plan `default`).

</details>

<details>
<summary><b>Why aren't my messages disappearing from the queue?</b></summary>

By default, the `listen` command connects with `autoAck: false` so that you can debug and monitor messages without stealing them from your actual application consumers. If you want to consume and remove them, pass the `--ack` flag.

</details>

<details>
<summary><b>How does it get the credentials?</b></summary>

It runs `cf curl /v3/apps/<guid>/env` to extract the `enterprise-messaging` service binding credentials, including the AMQP WebSocket URL, REST URL, and OAuth2 Client Credentials.

</details>

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-event-mesh build
pnpm --filter @saptools/cf-event-mesh typecheck
pnpm --filter @saptools/cf-event-mesh test:unit
```

---

## 🌐 Related

- 🔐 [`@saptools/cf-xsuaa`](https://www.npmjs.com/package/@saptools/cf-xsuaa) — fetch XSUAA credentials and cached OAuth2 tokens for any CF app
- 🔄 [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — map your SAP BTP Cloud Foundry topology
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
