<div align="center">

# `@saptools/cf-live-trace`

**Inject a bounded HTTP trace hook into a running SAP BTP Cloud Foundry Node.js app and stream request/response events from the CLI.**

[![npm version](https://img.shields.io/npm/v/@saptools/cf-live-trace.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-live-trace)
[![license](https://img.shields.io/npm/l/@saptools/cf-live-trace.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-live-trace.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![types](https://img.shields.io/npm/types/@saptools/cf-live-trace.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#install) - [Quick Start](#quick-start) - [CLI](#cli) - [API](#programmatic-usage) - [Security](#security-notes)

</div>

---

## Features

- Runtime HTTP tracing for Node.js apps already running on Cloud Foundry.
- Automatic CF session setup, SSH enablement check, Node inspector startup, and SSH port forwarding.
- CDP-based JavaScript injection derived from the SAP Tools VS Code Live Trace flow.
- Request and response header capture, bounded body capture, status, duration, byte counts, correlation id, and bounded queue drops.
- Compact stdout for scripts and agents: headers and app id stay out of live output, body previews are capped at 128 characters, and full captured events are saved locally.
- Per-request backup JSON files under `~/.saptools/cf-live-trace/sessions/` with two-hour retention and session inspection commands for large JSON bodies.
- Strict TypeScript, ESLint, unit coverage, and fake-backed E2E tests without live SAP access.

---

## Install

```bash
npm install -g @saptools/cf-live-trace

# or as a library
npm install @saptools/cf-live-trace
```

Requires Node.js >= 20 and the official `cf` CLI on `PATH`.

The target Cloud Foundry app must be a Node.js process where `cf ssh` can reach `127.0.0.1:9229` after Node inspector startup. If SSH is disabled, the CLI enables SSH and restarts the app before opening the tunnel.

---

## Quick Start

```bash
export SAP_EMAIL="sample@example.com"
export SAP_PASSWORD="<password>"

cf-live-trace \
  --region ap10 \
  --org sample-org \
  --space dev \
  --app orders-api \
  --instance 0 \
  --format ndjson
```

If you already know the CF API endpoint, replace `--region ap10` with `--api-endpoint https://api.cf.ap10.hana.ondemand.com`.

By default the command streams one JSON object per captured HTTP request and runs until `Ctrl+C`.

```json
{"id":"1","sessionId":"s1a2b3c4d","requestId":"r5e6f7a8b","method":"POST","normalizedUrl":"/orders","status":201,"durationMs":24,"requestBodyFormat":"json","responseBodyFormat":"json"}
```

---

## CLI

```bash
cf-live-trace --help
```

Targeting flags:

| Flag | Description |
| --- | --- |
| `--region <key>` | CF region key (defaults via `cf target` when omitted; errors if no current target when only app given) |
| `--api-endpoint <url>` | Explicit CF API endpoint instead of a region key |
| `--org <name>` | CF org name |
| `--space <name>` | CF space name |
| `--app <name>` | CF app name |
| `--instance <index>` | CF app instance index, default `0` |
| `--email <value>` | Override `SAP_EMAIL` |
| `--password <value>` | Override `SAP_PASSWORD` |
| `--cf-home <dir>` | Reuse an existing CF home instead of a temporary one |
| `--cf-command <path>` | CF CLI executable or test shim |

Trace flags:

| Flag | Description |
| --- | --- |
| `--duration <seconds>` | Stop after N seconds |
| `--max-events <count>` | Stop after N captured trace events |
| `--max-body-bytes <bytes>` | Maximum request/response capture bytes, default `4096`; must be greater than `0` |
| `--no-capture-headers` | Do not capture request/response headers |
| `--no-capture-request-body` | Do not capture request body previews |
| `--no-capture-response-body` | Do not capture response body previews |
| `--no-uninstall-on-exit` | Disable the injected hook instead of uninstalling it |
| `--format <format>` | `ndjson`, `summary`, or `json` |
| `--quiet` | Suppress progress lines on stderr |

Prefer `SAP_EMAIL` and `SAP_PASSWORD` over inline credential flags. Process arguments can be visible to other users on the same machine.

Each captured request is also saved as a private JSON file under:

```text
~/.saptools/cf-live-trace/sessions/<sessionId>/events/
```

Files expire after two hours. The path is based on Node's user home directory, so Windows uses the current user's profile directory.

---

## Examples

Stop after the first five requests and print a compact text stream:

```bash
cf-live-trace \
  --api-endpoint https://api.cf.ap10.hana.ondemand.com \
  --org sample-org \
  --space dev \
  --app orders-api \
  --max-events 5 \
  --format summary
```

Capture headers only, without body previews:

```bash
cf-live-trace \
  --region ap10 \
  --org sample-org \
  --space dev \
  --app orders-api \
  --no-capture-request-body \
  --no-capture-response-body
```

Emit one final JSON document for downstream processing:

```bash
cf-live-trace \
  --region ap10 \
  --org sample-org \
  --space dev \
  --app orders-api \
  --duration 30 \
  --format json
```

Inspect a saved session after or during a trace run:

```bash
cf-live-trace session events s1a2b3c4d --method POST --limit 20
cf-live-trace session search s1a2b3c4d orderId --body both --length 256
cf-live-trace session body s1a2b3c4d r5e6f7a8b --body response --path /data/items/0 --limit 4000
cf-live-trace session prune
```

---

## How It Works

`cf-live-trace` follows the same high-level route as the SAP Tools VS Code Live Trace feature:

1. Prepare an isolated CF session with `cf api`, `cf auth`, and `cf target`.
2. Ensure SSH is enabled for the app.
3. Run a robust `/proc` scan inside the app container and send `SIGUSR1` to the best Node.js process candidate.
4. Open `cf ssh -L <local>:127.0.0.1:9229` for the selected app instance.
5. Attach to the Node inspector over CDP using `@saptools/cf-inspector`.
6. Evaluate a runtime hook that patches Node's `http` and `https` server prototypes.
7. Poll a bounded in-process queue, save each drained trace event locally, and stream compact trace events back to stdout.
8. Disable or uninstall the hook and close the tunnel on exit.

The injected global is named `__SAPTOOLS_CF_LIVE_TRACE__` so CLI sessions do not collide with the VS Code extension's Live Trace runtime global.

---

## Programmatic Usage

```ts
import { LiveTraceSession } from "@saptools/cf-live-trace";

const session = new LiveTraceSession({
  target: {
    region: "ap10",
    email: process.env["SAP_EMAIL"] ?? "",
    password: process.env["SAP_PASSWORD"] ?? "",
    org: "sample-org",
    space: "dev",
    app: "orders-api",
    instanceIndex: 0,
  },
  onEvents(events) {
    for (const event of events) {
      process.stdout.write(`${event.method} ${event.normalizedUrl} ${String(event.status)}\n`);
    }
  },
});

await session.start({ maxBodyBytes: 4096 });

process.once("SIGINT", () => {
  void session.stop({ uninstallRuntimeHook: true, reason: "user" });
});
```

The public API also exports helpers for payload parsing, runtime expression construction, CF SSH argument construction, and URL summaries.

---

## Security Notes

- This tool injects JavaScript into a running Node.js process through the Node inspector. Use it only for apps and spaces you are authorized to inspect.
- Captured headers and bodies can contain credentials, tokens, cookies, or personal data. Backup files are private by default, but keep the user profile and CI artifacts protected.
- Live stdout intentionally omits request/response headers and app id, and only prints 128 characters of each captured body. Backup JSON files retain the fuller captured event for two hours.
- `--max-body-bytes` bounds captured body data transported back from the app and must be greater than zero. Set it lower for sensitive or high-throughput services.
- The CLI avoids putting credentials in `cf auth` arguments; credentials are passed to the CF CLI through `CF_USERNAME` and `CF_PASSWORD`.
- If cleanup fails, the runtime hook can remain disabled or installed until the app process restarts. Progress events report this state.

---

## Development

```bash
pnpm install
pnpm --filter @saptools/cf-live-trace build
pnpm --filter @saptools/cf-live-trace lint
pnpm --filter @saptools/cf-live-trace typecheck
pnpm --filter @saptools/cf-live-trace test:unit
pnpm --filter @saptools/cf-live-trace test:e2e
```

The E2E test starts a local inspectable Node.js app and a fake `cf` executable that opens a real TCP proxy to the app inspector. No live SAP account is required.
