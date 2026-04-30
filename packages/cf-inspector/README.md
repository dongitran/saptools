<div align="center">

# 🔍 `@saptools/cf-inspector`

**Set breakpoints, capture variable snapshots, and evaluate expressions on a remote Node.js process — over the Chrome DevTools Protocol, no IDE required.**

Built so an AI agent (or a CI job) can drive a debugger from a single shell command. Pairs with [`@saptools/cf-debugger`](https://www.npmjs.com/package/@saptools/cf-debugger) when the target lives behind a Cloud Foundry SSH tunnel.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-inspector.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-inspector)
[![license](https://img.shields.io/npm/l/@saptools/cf-inspector.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-inspector.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [How it works](#-how-it-works)

</div>

---

## ✨ Features

- 🎯 **One-shot snapshot** — `cf-inspector snapshot --bp src/handler.ts:42` sets the breakpoint, waits for it to hit, captures requested expressions, auto-resumes, prints JSON, exits
- ✅ **Conditional breakpoints** — `--condition 'req.userId === "abc"'` only pauses when the predicate is truthy
- 🎭 **Multi-breakpoint** — repeat `--bp` to race several locations; first hit wins
- 📡 **Non-pausing logpoints** — `cf-inspector log --at file:line --expr 'JSON.stringify({…})'` streams JSON Lines as the line executes, **without ever pausing the inspectee** (safe for production traffic)
- 🧠 **Agent-friendly** — JSON-by-default I/O, deterministic shape, bounded value previews for large debugger payloads
- 🧭 **Path mapping** — local `src/handler.ts:42` is matched against the remote URL via a `urlRegex`, with optional `--remote-root` literal or regex (same DSL as `cds-debug`)
- 🔁 **Composes with `cf-debugger`** — pass `--app/--region/--org/--space` and the tunnel is opened automatically; pass `--port` to attach to anything CDP-speaking
- 🪶 **Tiny dependency footprint** — `commander` + `ws` only, no heavy CDP framework
- 🧩 **Typed API** — every CLI command has a programmatic equivalent with full TypeScript definitions

---

## 📦 Install

```bash
npm install -g @saptools/cf-inspector
# or
pnpm add @saptools/cf-inspector
```

> [!NOTE]
> Requires **Node.js ≥ 20**.
> For Cloud Foundry targets, also install [`@saptools/cf-debugger`](https://www.npmjs.com/package/@saptools/cf-debugger) (added automatically as a peer-style runtime dep).

---

## 🚀 Quick Start

### Local Node process

```bash
# Terminal 1 — run any Node app with the inspector enabled
node --inspect=9229 my-app.js

# Terminal 2 — capture a snapshot when handler.ts:42 hits
cf-inspector snapshot \
  --port 9229 \
  --bp src/handler.ts:42 \
  --capture 'this.user, req.body' \
  --timeout 30
```

### Cloud Foundry app (auto-tunnel)

```bash
export SAP_EMAIL=...
export SAP_PASSWORD=...

cf-inspector snapshot \
  --region eu10 --org my-org --space dev --app my-srv \
  --bp src/handler.ts:42 \
  --remote-root 'regex:^/(home/vcap/app|example-root-.*)$'
```

The first form connects directly to `localhost:9229`. The second internally calls `@saptools/cf-debugger` to open the SSH tunnel, runs the snapshot through it, and tears the tunnel down on exit.

---

## 🧰 CLI

### 📸 `cf-inspector snapshot`

Set one or more breakpoints, wait for any of them to hit, capture frame metadata and requested expressions, auto-resume, exit.

```bash
# Simple snapshot
cf-inspector snapshot \
  --port 9229 \
  --bp src/handler.ts:42 \
  --capture 'this.user, req.body' \
  --timeout 30

# Conditional snapshot — only pauses for the user we care about
cf-inspector snapshot --port 9229 \
  --bp src/handler.ts:42 \
  --condition 'req.userId === "abc"' \
  --capture 'req.body'

# Multi-breakpoint — first hit wins (useful when you don't know which path is taken)
cf-inspector snapshot --port 9229 \
  --bp src/auth.ts:120 \
  --bp src/auth.ts:155 \
  --bp src/auth.ts:180 \
  --capture 'req.url, this.user'
```

| Flag | Description |
| --- | --- |
| `--port <number>` | Local port the inspector or tunnel listens on. **Required** unless `--app/--region/--org/--space` are all set |
| `--bp <file:line>` | **Required.** Source location to break at. Pass multiple times to race several locations — the first one to hit wins |
| `--condition <expr>` | Only pause when this JS expression evaluates truthy in the paused frame. Errors in the condition are silently treated as `false` by V8 |
| `--capture <expr,…>` | Top-level comma-separated expressions to evaluate in the paused frame; nested commas inside objects, arrays, calls, or strings are preserved. Object results are materialized to JSON strings when serializable, with fallback to CDP descriptions for non-serializable values |
| `--timeout <seconds>` | How long to wait for the breakpoint to hit (default: `30`) |
| `--remote-root <value>` | Optional path-mapping anchor: literal path or `regex:<pattern>` / `/pattern/flags` |
| `--include-scopes` | Include expanded paused-frame scopes under `topFrame.scopes`. Omitted by default to keep targeted captures concise |
| `--no-json` | Print a human-readable summary instead of JSON |
| `--keep-paused` | Skip `Debugger.resume` after capture; Node may resume when the CLI disconnects |
| `--fail-on-unmatched-pause` | Fail immediately if the target pauses somewhere else instead of waiting cooperatively |

JSON output includes frame metadata and `captures` by default. `topFrame.scopes`
is only present with `--include-scopes`, because Cloud Foundry Node apps often
carry large local/closure/module objects that drown out targeted captures. The
output contains raw debugger values; use it only against trusted targets and be
careful when sharing logs. The output also includes `pausedDurationMs`, the
client-observed time from receiving
the matching pause event until `Debugger.resume` completes. It does not include
the time spent waiting for the breakpoint to hit. When `--keep-paused` is used,
`pausedDurationMs` is `null` because `cf-inspector` intentionally skips
`Debugger.resume`. Node may resume execution when this one-shot CLI disconnects,
so treat `--keep-paused` as a low-level diagnostic escape hatch, not a durable
paused-session mode.

If the target pauses somewhere else first, for example another debugger's
breakpoint or a `debugger;` statement, `snapshot` does not resume it by default.
It warns once, waits for `Debugger.resumed`, then continues waiting for its own
breakpoint within the remaining timeout. Use `--fail-on-unmatched-pause` when a
strict immediate error is preferred.

For Cloud Foundry targets, replace `--port` with `--region/--org/--space/--app` (and optionally `--cf-timeout <seconds>` for the tunnel).

### 📡 `cf-inspector log`

Set a non-pausing logpoint and stream the evaluated expression each time the line executes. Safe for production traffic — the inspectee **never pauses**.

```bash
# Stream user IDs hitting handler.ts:42 for 30 seconds
cf-inspector log \
  --port 9229 \
  --at src/handler.ts:42 \
  --expr 'JSON.stringify({ user: req.user, body: req.body })' \
  --duration 30
```

Output is **JSON Lines** on stdout (one event per line) plus a summary trailer on stderr:

```jsonc
{"ts":"2026-04-29T...","at":"src/handler.ts:42","value":"{\"user\":\"alice\",\"body\":{}}"}
{"ts":"2026-04-29T...","at":"src/handler.ts:42","value":"{\"user\":\"bob\",\"body\":{}}"}
// stderr:
{"stopped":"duration","emitted":2}
```

When the user expression throws, the event is emitted with `error` instead of `value` so the stream never silently gaps:

```jsonc
{"ts":"…","at":"src/handler.ts:42","error":"Cannot read properties of undefined (reading 'user')"}
```

| Flag | Description |
| --- | --- |
| `--port <number>` | Local port the inspector or tunnel listens on. **Required** unless `--app/--region/--org/--space` are all set |
| `--at <file:line>` | **Required.** Source location to log at |
| `--expr <expression>` | **Required.** JS expression to evaluate at each hit (wrapped in try/catch on the inspectee side) |
| `--duration <seconds>` | Stop streaming after N seconds (default: run until SIGINT) |
| `--remote-root <value>` | Optional path-mapping anchor (same DSL as `snapshot`) |
| `--no-json` | Print human-readable lines instead of JSON Lines |

### 🧮 `cf-inspector eval`

Evaluate one expression with `Runtime.evaluate` in the global scope and print the result. For paused-frame values, use `snapshot --capture` or the programmatic `evaluateOnFrame(...)` API.

```bash
cf-inspector eval --port 9229 --expr 'process.uptime()'
```

### 📜 `cf-inspector list-scripts`

Print every script the V8 instance knows about (useful for debugging path-mapping issues).

```bash
cf-inspector list-scripts --port 9229
```

### 🔗 `cf-inspector attach`

Connect, fetch the runtime version, print it, disconnect. Useful as a smoke-test that the tunnel is healthy.

```bash
cf-inspector attach --port 9229
```

---

## 🧑‍💻 Programmatic Usage

```ts
import {
  connectInspector,
  setBreakpoint,
  waitForPause,
  captureSnapshot,
  evaluateOnFrame,
  resume,
} from "@saptools/cf-inspector";

const session = await connectInspector({ port: 9229 });
const bp = await setBreakpoint(session, {
  file: "src/handler.ts",
  line: 42,
});
const pause = await waitForPause(session, { timeoutMs: 30_000 });
const snapshot = await captureSnapshot(session, pause, {
  captures: ["this.user"],
});
const topFrame = pause.callFrames[0];
if (topFrame === undefined) {
  throw new Error("Breakpoint paused without a call frame");
}
const customValue = await evaluateOnFrame(session, topFrame.callFrameId, "this.user");
await resume(session);
await session.dispose();

console.log({ bp, snapshot, customValue });
```

<details>
<summary><b>📚 Full export list</b></summary>

| Export | Description |
| --- | --- |
| `connectInspector(options)` | Open a CDP WebSocket session against a port |
| `setBreakpoint(session, location)` | Set a breakpoint by file/line + optional remote root |
| `removeBreakpoint(session, id)` | Remove a breakpoint by id |
| `waitForPause(session, options)` | Resolve when the next `Debugger.paused` event fires |
| `captureSnapshot(session, pause, options)` | Build a structured snapshot of the paused frame. Pass `includeScopes: true` to expand scopes |
| `evaluateOnFrame(session, frameId, expression)` | Evaluate in a paused frame |
| `evaluateGlobal(session, expression)` | Evaluate against the global Runtime |
| `listScripts(session)` | Return the scripts the V8 instance knows about |
| `resume(session)` | Resume execution |
| `streamLogpoint(session, options)` | Stream a non-pausing logpoint until duration / signal / transport-close |
| `buildLogpointCondition(sentinel, expression)` | Build the CDP `condition` string for a logpoint (low-level helper) |
| `parseRemoteRoot(value)` | Parse a literal/regex remote-root setting |
| `buildBreakpointUrlRegex(input)` | Build a CDP `urlRegex` for a file path |
| `CfInspectorError` | Rich error class with typed `code` |

</details>

<details>
<summary><b>🧪 Error codes</b></summary>

| Code | When |
| --- | --- |
| `INVALID_ARGUMENT` | A numeric flag (`--port`, `--timeout`, `--duration`, …) is not a positive integer |
| `INVALID_BREAKPOINT` | `--bp` / `--at` is not in `file:line` form, or line is not a positive integer |
| `INVALID_REMOTE_ROOT` | `--remote-root` regex did not compile |
| `INVALID_EXPRESSION` | `--condition` or `--expr` failed to parse on V8 (`Runtime.compileScript` reported a SyntaxError) — fast-fail before the breakpoint is set |
| `BREAKPOINT_DID_NOT_BIND` | Reserved: a breakpoint resolved to no scripts. Currently surfaced as a stderr warning only — see `BreakpointHandle.resolvedLocations` for programmatic detection |
| `INSPECTOR_DISCOVERY_FAILED` | `/json/list` did not return a usable WebSocket URL |
| `INSPECTOR_CONNECTION_FAILED` | WebSocket handshake failed, or the connection closed mid-request |
| `CDP_REQUEST_FAILED` | A CDP method returned an error result, timed out, or failed to send |
| `BREAKPOINT_NOT_HIT` | The breakpoint did not hit before the timeout elapsed |
| `UNRELATED_PAUSE` | The target paused somewhere else and `--fail-on-unmatched-pause` was enabled |
| `UNRELATED_PAUSE_TIMEOUT` | The target stayed paused somewhere else until the snapshot timeout elapsed |
| `EVALUATION_FAILED` | Reserved for future use — current evaluation paths surface remote exceptions inline via `CapturedExpression.error` instead of throwing |
| `MISSING_TARGET` | Neither `--port` nor a complete CF target (`--region/--org/--space/--app`) was provided |
| `ABORTED` | Reserved for future use by long-running streams when an `AbortSignal` fires |

</details>

---

## 🔭 How it works

```
┌──────────────────────┐   1. GET http://127.0.0.1:<port>/json/list
│ cf-inspector         │   2. Open ws:// debugger URL
│  snapshot --bp X:Y   │ ─►3. Debugger.enable + Runtime.enable
└──────────────────────┘   4. Debugger.setBreakpointByUrl({ urlRegex, lineNumber: Y - 1 })
            │              5. Wait for `Debugger.paused`
            ▼              6. Debugger.evaluateOnCallFrame(...)  for each --capture expression
   JSON snapshot           7. Runtime.getProperties(scopeChain[i].object.objectId) when --include-scopes is set
                           8. Debugger.resume   (unless --keep-paused)
```

Path mapping uses CDP's first-class `urlRegex`:

| `--remote-root` | Resulting urlRegex (line `42` of `src/handler.ts`) |
| --- | --- |
| _omitted_ | `(?:^|/)src/handler\.(?:ts\|js\|mts\|mjs\|cts\|cjs)$` |
| `/home/vcap/app` (literal) | `^file:///home/vcap/app/src/handler\.(?:ts\|js\|mts\|mjs\|cts\|cjs)$` |
| `regex:^/example-root-.*$` | `^file:///example-root-.*/src/handler\.(?:ts\|js\|mts\|mjs\|cts\|cjs)$` |
| `regex:^/(home/vcap/app\|example-root-.*)$` | `^file:///(home/vcap/app\|example-root-.*)/src/handler\.(?:ts\|js\|mts\|mjs\|cts\|cjs)$` |

`.ts ↔ .js` is folded into the regex automatically because Node's V8 inspector normally serves both the source-mapped TypeScript URL and the runtime JavaScript URL — matching either is correct.

---

## ⚙️ Composing with `cf-debugger`

If `--port` is omitted but `--region/--org/--space/--app` are given, the CLI internally calls `startDebugger(...)` from `@saptools/cf-debugger`, attaches over the SSH tunnel, and disposes the tunnel on exit. You get the same one-shot UX whether the target is local or in CF.

```bash
cf-inspector snapshot \
  --region eu10 --org my-org --space dev --app my-srv \
  --bp src/handler.ts:42 \
  --capture 'req.url, this.user'
```

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-inspector build
pnpm --filter @saptools/cf-inspector typecheck
pnpm --filter @saptools/cf-inspector lint
pnpm --filter @saptools/cf-inspector test:unit
pnpm --filter @saptools/cf-inspector test:e2e
```

The e2e suite is fully self-contained: it spawns a small Node fixture under `--inspect=0`, drives the CLI against it, and asserts the JSON output. No CF / live network required.

---

## 🌐 Related

- 🐛 [`@saptools/cf-debugger`](https://www.npmjs.com/package/@saptools/cf-debugger) — opens the SSH inspector tunnel
- ☁️ [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) — snapshot CF topology + DB bindings into JSON
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
