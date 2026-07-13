<div align="center">

# 🔍 `@saptools/cf-inspector`

**Set breakpoints, capture variable snapshots, and evaluate expressions on a remote Node.js process — over the Chrome DevTools Protocol, no IDE required.**

Built so an AI agent (or a CI job) can drive a debugger from a single shell command. Pairs with [`@saptools/cf-debugger`](https://www.npmjs.com/package/@saptools/cf-debugger) when the target lives behind a Cloud Foundry SSH tunnel.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-inspector.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-inspector)
[![license](https://img.shields.io/npm/l/@saptools/cf-inspector.svg?style=flat&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@saptools/cf-inspector.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [How it works](#-how-it-works)

</div>

---

## ✨ Features

- 🎯 **One-shot snapshot** — `cf-inspector snapshot --bp src/handler.ts:42` sets the breakpoint, waits for it to hit, captures requested expressions, auto-resumes, prints JSON, exits
- ✅ **Conditional breakpoints** — `--condition 'req.userId === "abc"'` only pauses when the predicate is truthy
- 🔢 **Hit-count breakpoints** — `--hit-count 5` skips the first N − 1 hits and pauses on the Nth, on every command (snapshot, log, watch)
- 🎭 **Multi-breakpoint** — repeat `--bp` to race several locations; first hit wins
- 🪜 **Stack capture** — `--stack-depth N --stack-captures 'this, args'` walks call frames and evaluates expressions per frame
- 🔁 **Watch streaming** — `cf-inspector watch --bp file:line --capture user.id --duration 30` re-captures on every hit and emits JSON Lines (the streaming counterpart of `snapshot`)
- 💥 **Exception breakpoints** — `cf-inspector exception --type uncaught --capture err.message` pauses on the next thrown error and materializes the exception value
- 📡 **Non-pausing logpoints** — `cf-inspector log --at file:line --expr 'JSON.stringify({…})'` streams JSON Lines as the line executes without pausing the inspectee, with optional `--condition`, `--hit-count`, and `--max-events`
- 🛡️ **Read-only capture guard** — snapshot, watch, and exception captures use V8's side-effect analysis by default; `--allow-mutation` is an explicit escape hatch
- 🧵 **Worker-aware sessions** — `list-targets` discovers raw inspector targets and nested NodeWorker sessions; use `--target` or `--worker` to select an isolate
- 🧠 **Agent-friendly** — JSON-by-default I/O, deterministic shapes, and explicit `truncated`/`originalLength`/`omittedCount` metadata for bounded values
- 🧭 **Path mapping** — local `src/handler.ts:42` is matched against the remote URL via a `urlRegex`, with optional `--remote-root` literal or regex (same DSL as `cds-debug`)
- 🔁 **Composes with `cf-debugger`** — pass `--app/--region/--org/--space` and the tunnel is opened automatically; pass `--port` to attach to anything CDP-speaking
- 🪶 **Tiny dependency footprint** — `@saptools/cf-debugger` + `commander` + `ws`, with no heavy CDP framework
- 🧩 **Typed API** — every CLI command has a programmatic equivalent with full TypeScript definitions

---

## 📦 Install

```bash
npm install -g @saptools/cf-inspector
# or
pnpm add @saptools/cf-inspector

cf-inspector --version
```

> [!NOTE]
> Requires **Node.js ≥ 20**.
> Cloud Foundry support uses [`@saptools/cf-debugger`](https://www.npmjs.com/package/@saptools/cf-debugger), which is installed automatically as a normal runtime dependency.

---

## 🚀 Quick Start

### Cloud Foundry app (auto-tunnel)

```bash
export SAP_EMAIL=...
export SAP_PASSWORD=...

cf-inspector snapshot \
  --region eu10 --org my-org --space dev --app my-srv \
  --bp src/handler.ts:42 \
  --remote-root 'regex:^/(home/vcap/app|example-root-.*)$'
```

This command internally calls `@saptools/cf-debugger` to open the SSH tunnel, runs the snapshot through it, and tears the tunnel down on exit.

Cloud Foundry targeting is deliberately deterministic: `--app` requires
`--region`, `--org`, and `--space`. The CLI never inherits missing selectors
from ambient `cf target` state. Use `--api-endpoint` only when the selected
region needs an explicit endpoint override.

---

## 🧰 CLI

### 📸 `cf-inspector snapshot`

Set one or more breakpoints, wait for any of them to hit, capture frame metadata and requested expressions, auto-resume, exit.

```bash
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
| `--region/--org/--space/--app` | Explicit Cloud Foundry target. All four are required when `--port` is omitted; ambient `cf target` is never consulted |
| `--api-endpoint <url>` | Override the API endpoint resolved from `--region` |
| `--target <index>` | Raw `/json/list` target index (default: `0`) |
| `--worker <index>` | Nested NodeWorker index reported under the selected raw target by `list-targets` |
| `--bp <file:line>` | **Required.** Source location to break at. Pass multiple times to race several locations — the first one to hit wins |
| `--condition <expr>` | Native breakpoint condition. It is compile-checked before arming; mutation-shaped conditions require `--allow-mutation` because CDP provides no side-effect guard for native conditions |
| `--hit-count <n>` | Skip the first N − 1 hits and only pause on the Nth (combines with `--condition` via logical AND) |
| `--capture <expr,…>` | Top-level comma-separated expressions evaluated in the paused frame under V8's side-effect guard. Nested commas inside objects, arrays, calls, or strings are preserved. Objects are materialized to JSON strings when serializable |
| `--setup-eval <expr>` | Repeatable, order-preserving global expression evaluated before breakpoint setup. It is mutation-capable and only receives an advisory warning |
| `--stack-depth <n>` | Walk this many call frames per hit (default: `1`, top frame only). When `> 1`, the result includes a `stack` array |
| `--stack-captures <expr,…>` | Expressions evaluated on each captured call frame under the same side-effect guard as `--capture` |
| `--allow-mutation` | Disable V8's capture side-effect guard and explicitly allow mutation-shaped native conditions. Heuristic matches are annotated with `mutationRisk: true` |
| `--timeout <seconds>` | How long to wait for the breakpoint to hit (default: `30`) |
| `--max-value-length <chars>` | Maximum characters per captured value before truncation (one-shot default: `131072`). Explicit values are honored exactly |
| `--remote-root <value>` | Optional path-mapping anchor: literal path or `regex:<pattern>` / `/pattern/flags` |
| `--include-scopes` | Include expanded paused-frame scopes under `topFrame.scopes`. Omitted by default to keep targeted captures concise |
| `--no-json` | Print a human-readable summary instead of JSON |
| `--quiet` | Suppress snapshot progress messages on stderr |
| `--keep-paused` | Skip `Debugger.resume` after capture |
| `--fail-on-unmatched-pause` | Fail immediately if the target pauses somewhere else instead of waiting cooperatively |

Snapshot progress is printed to `stderr` by default, including Cloud Foundry
login/tunnel setup, inspector connection, breakpoint binding, the breakpoint
wait, capture, resume, and cleanup phases. The final JSON document remains the
only content written to `stdout`, so piping it to `jq` or another parser stays
safe. Pass `--quiet` to suppress these progress lines; warnings and errors still
use `stderr`.

Snapshot JSON includes frame metadata and `captures` by default. `topFrame.scopes`
is only present with `--include-scopes` because scope objects can be large and
drown out targeted captures. Values are raw debugger values, so be careful when
sharing logs.

Capture expressions are read-only by default. `cf-inspector` sends
`throwOnSideEffect: true` to V8 for both `--capture` and `--stack-captures`.
Assignments, mutating methods such as `push`, and calls V8 cannot prove pure
are returned as a blocked capture with `blocked: true`, `mutationRisk: true`,
and a `MUTATION_NOT_ALLOWED` error. Pass `--allow-mutation` only when changing
the live inspectee is intentional. The opt-in disables the V8 guard and adds
`mutationRisk: true` when the advisory syntax scan recognizes a likely
mutation; arbitrary function calls can still mutate without being recognized.

`--condition` is different: V8 executes it internally as a native breakpoint
condition, where CDP has no `throwOnSideEffect` option. Mutation-shaped native
conditions are rejected unless `--allow-mutation` is present. `--setup-eval`
and the standalone `eval` command remain mutation-capable by design and emit
advisory warnings for recognizable mutation syntax.

A blocked capture remains a normal additive `CapturedExpression`, so one unsafe
expression does not corrupt the rest of the snapshot:

```json
{"expression":"items.push(1)","error":"MUTATION_NOT_ALLOWED: V8 blocked the capture expression ...","mutationRisk":true,"blocked":true}
```

With `--allow-mutation`, recognized mutation syntax runs and the result carries
`"mutationRisk": true`; ordinary reads do not gain the field.

#### Truncation contract

JSON truncation is always out-of-band. A text value longer than the effective
limit is cut to exactly that many JavaScript characters and gains
`"truncated": true` plus its full `"originalLength"`; no ellipsis is appended
to the JSON value. These fields are absent when no cut occurs. Human output may
add a visual ellipsis.

Expanded objects and scopes also report bounded structural capture. The
`VariableSnapshot`, `ScopeSnapshot`, or `FrameSnapshot` whose properties,
variables, or scopes were cut gains `truncated: true` and the exact direct
`omittedCount`. A serialized object capture propagates the aggregate known
omission count to its `CapturedExpression`. `ExceptionSnapshot` additionally
uses `valueOriginalLength` and `descriptionOriginalLength` so consumers can
identify which field was cut; its compatibility `originalLength` is the larger
reported field length.

One-shot `snapshot` and `exception` commands default to `131072` characters.
Repeated `watch` and `log` events default to `4096`. All four accept
`--max-value-length`, and an explicit limit is applied exactly.

```json
{"expression":"largeText","value":"exactly-N-characters","type":"string","truncated":true,"originalLength":250000}
```

`pausedDurationMs` measures the client-observed time from receiving the matching
pause event until `Debugger.resume` completes. With `--keep-paused`, it is `null`
because resume is intentionally skipped.

If the target pauses somewhere else first, for example another debugger's
breakpoint or a `debugger;` statement, `snapshot` does not resume it by default.
It warns once, waits for `Debugger.resumed`, then continues waiting for its own
breakpoint within the remaining timeout. Use `--fail-on-unmatched-pause` when a
strict immediate error is preferred.

For Cloud Foundry targets, replace `--port` with
`--region/--org/--space/--app`. Cloud Foundry commands and tunnel readiness
allow up to 180 seconds by default. For commands without their own wait
semantics, `--timeout <seconds>` controls CF tunnel readiness. For breakpoint
and exception commands, `--timeout` is reserved for the command wait and tunnel
readiness keeps the 180-second default.

### 📡 `cf-inspector log`

Set a non-pausing logpoint and stream the evaluated expression each time the
line executes. The inspectee does not pause, but the expression and condition
still execute against live state and can mutate it.

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
| `--target <index>` / `--worker <index>` | Select a raw inspector target or nested NodeWorker session from `list-targets` |
| `--at <file:line>` | **Required.** Source location to log at |
| `--expr <expression>` | **Required.** JavaScript expression evaluated at each hit, wrapped in try/catch on the inspectee side. It is mutation-capable; recognizable risks produce a warning |
| `--duration <seconds>` | Stop streaming after N seconds (default: run until SIGINT) |
| `--max-events <n>` | Stop streaming after emitting N log events. The trailer reports `stopped: "max-events"` |
| `--hit-count <n>` | Start emitting once the line has been hit N or more times |
| `--condition <expr>` | Mutation-capable native condition evaluated on the inspectee. Recognizable risks produce a warning. Composes with `--hit-count` via logical AND |
| `--max-value-length <chars>` | Maximum characters per log value (streaming default: `4096`). Truncated events include `truncated` and `originalLength` |
| `--remote-root <value>` | Optional path-mapping anchor (same DSL as `snapshot`) |
| `--no-json` | Print human-readable lines instead of JSON Lines |

Native logpoint expressions and conditions have no V8 side-effect gate. The
CLI warns when its best-effort syntax scan recognizes assignments or common
mutating calls, but that scan cannot prove an arbitrary function is pure. Treat
logpoint expressions as executable live code.

### 🔁 `cf-inspector watch`

Stream a snapshot per breakpoint hit. The inspectee is paused briefly while
captures are evaluated, then resumed automatically; output is JSON Lines on
stdout with a trailer on stderr (same shape as `log`).

```bash
cf-inspector watch --port 9229 \
  --bp src/handler.ts:42 \
  --capture 'user.id, payload' \
  --condition 'user.id !== "system"' \
  --duration 30 \
  --max-events 50
```

Each event is a `WatchEvent`:

```jsonc
{"ts":"2026-04-29T...","at":"file:///app/src/handler.ts:42","hit":1,"reason":"other","hitBreakpoints":["..."],"captures":[{"expression":"user.id","value":"\"alice\""}]}
{"ts":"2026-04-29T...","at":"file:///app/src/handler.ts:42","hit":2,"reason":"other","hitBreakpoints":["..."],"captures":[{"expression":"user.id","value":"\"bob\""}]}
// stderr trailer:
{"stopped":"max-events","emitted":50}
```

| Flag | Description |
| --- | --- |
| `--port <number>` | Local port the inspector or tunnel listens on. Otherwise pass all explicit Cloud Foundry selectors |
| `--target <index>` / `--worker <index>` | Select a raw inspector target or nested NodeWorker session from `list-targets` |
| `--bp <file:line>` | **Required.** Source location to capture on (repeatable) |
| `--capture <expr,…>` | Top-level comma-separated expressions evaluated per hit under V8's side-effect guard |
| `--setup-eval <expr>` | Repeatable mutation-capable global expression evaluated before breakpoint setup; recognizable risks produce a warning |
| `--condition <expr>` | Native condition; mutation-shaped conditions require `--allow-mutation` |
| `--hit-count <n>` | Start emitting once the line has been hit N or more times |
| `--remote-root <value>` | Path-mapping anchor (same DSL as `snapshot`) |
| `--duration <seconds>` | Stop streaming after N seconds (default: until SIGINT) |
| `--max-events <n>` | Stop streaming after emitting N events |
| `--timeout <seconds>` | How long to wait for the next hit before giving up (default: `30`) |
| `--max-value-length <chars>` | Maximum characters per captured value (streaming default: `4096`) |
| `--stack-depth <n>` | Walk this many call frames per hit (default: `1`) |
| `--stack-captures <expr,…>` | Expressions evaluated on each call frame under the capture side-effect guard |
| `--allow-mutation` | Disable the capture side-effect guard and explicitly allow mutation-shaped native conditions |
| `--include-scopes` | Include expanded paused-frame scopes per hit |
| `--no-json` | Print human-readable lines instead of JSON Lines |

### 💥 `cf-inspector exception`

Pause on a thrown exception, capture the exception value plus the paused
frame, then resume.

```bash
cf-inspector exception --port 9229 \
  --type uncaught \
  --capture 'this' \
  --stack-depth 4 \
  --stack-captures 'arguments[0]' \
  --timeout 30
```

Result is a `SnapshotResult` with an extra `exception` field:

```jsonc
{
  "reason": "exception",
  "hitBreakpoints": [],
  "capturedAt": "2026-04-29T...",
  "pausedDurationMs": 0.5,
  "topFrame": {"functionName": "validate", "url": "...", "line": 42, "column": 5},
  "exception": {"value": "{\"message\":\"missing field\",\"name\":\"Error\"}", "type": "object", "description": "missing field"},
  "captures": [],
  "stack": [...]
}
```

| Flag | Description |
| --- | --- |
| `--port` or explicit `--region/--org/--space/--app` | Select the local inspector or deterministic Cloud Foundry target |
| `--target <index>` / `--worker <index>` | Select a raw inspector target or nested NodeWorker session from `list-targets` |
| `--type <state>` | Pause on which exceptions: `uncaught` (default), `caught`, or `all` |
| `--capture <expr,…>` | Top-level expressions evaluated in the paused frame under V8's side-effect guard |
| `--stack-depth <n>` | Walk this many call frames (default: `1`) |
| `--stack-captures <expr,…>` | Expressions evaluated on each frame under V8's side-effect guard |
| `--allow-mutation` | Disable the capture side-effect guard; heuristic matches gain `mutationRisk: true` |
| `--include-scopes` | Include paused-frame scopes |
| `--remote-root <value>` | Path-mapping anchor (only used if you also wire snapshot helpers) |
| `--timeout <seconds>` | How long to wait for an exception (default: `30`) |
| `--max-value-length <chars>` | Maximum characters per captured value (one-shot default: `131072`) |
| `--keep-paused` | Skip `Debugger.resume` after capture |
| `--no-json` | Print a human-readable summary instead of JSON |

### 🧮 `cf-inspector eval`

Evaluate one expression with `Runtime.evaluate` in the selected isolate's
global scope and print the result. `eval` is intentionally mutation-capable and
has no side-effect gate; recognizable mutation syntax emits an advisory warning
to `stderr`. For read-only paused-frame values, use `snapshot --capture` or call
the programmatic `evaluateOnFrame(..., { throwOnSideEffect: true })` API. Plain
`evaluateOnFrame(...)` remains unrestricted by default for backward
compatibility.

```bash
cf-inspector eval --port 9229 --expr 'process.uptime()'
```

### 📜 `cf-inspector list-scripts`

Print every script the V8 instance knows about (useful for debugging path-mapping issues). Add `--filter <pattern>` to narrow noisy script lists with a literal/wildcard pattern; `|` separates alternatives and `.*` / `.+` match variable text.

```bash
cf-inspector list-scripts --port 9229 --filter 'dist/.+\.js'
```

### 🎯 `cf-inspector list-targets`

Print raw `/json/list` inspector targets with stable `index` values, likely
worker labels, and the total target/worker counts on `stderr`. For each raw
target, the command also probes Node's `NodeWorker` CDP domain and lists live
nested workers with their own indexes.

```bash
cf-inspector list-targets --port 9229
cf-inspector snapshot --port 9229 --worker 0 --bp dist/worker.js:42
# If a runtime publishes a worker as another raw /json/list target instead:
cf-inspector snapshot --port 9229 --target 1 --bp dist/worker.js:42
```

JSON output nests workers beneath their raw target:

```json
[
  {
    "index": 0,
    "description": "node.js instance",
    "id": "target-id",
    "type": "node",
    "title": "app.mjs",
    "url": "file:///app/app.mjs",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9229/target-id",
    "likelyWorker": false,
    "workerDiscoverySupported": true,
    "workers": [
      {"index": 0, "workerId": "1", "type": "worker", "title": "jobs", "url": "file:///app/worker.mjs"}
    ]
  }
]
```

`--target` selects a complete raw inspector endpoint. `--worker` selects a
nested NodeWorker session under the chosen raw target (raw target `0` unless
`--target` is also passed). Modern Node.js 20–25 verification found workers on
the `NodeWorker` path, including workers already alive before post-hoc
`SIGUSR1` inspector activation; the raw-target selector remains supported for
runtimes that publish that shape.

When multiple raw targets or nested workers exist and no selector is passed,
commands attach to raw target `0` and print a selection notice. A bound
breakpoint that sees no hit prints a worker-isolate hint. If only one raw target
and no workers are visible, `list-targets` explains that the worker may have
exited, the runtime may not expose NodeWorker discovery, or a separate worker
port may be unreachable through the single Cloud Foundry tunnel. Rerun the
command while the worker is alive before selecting an index.

If `list-targets`, `attach`, or another command reports `ECONNREFUSED`, the local inspector or tunnel on that port is usually stale/closed. Restart the local Node inspector or tunnel and retry; for Cloud Foundry targets, pass the complete `--region/--org/--space/--app` selector so `cf-inspector` can open a fresh tunnel.

### 🔗 `cf-inspector attach`

Connect, fetch the runtime version, print it, disconnect. Useful as a smoke-test that the tunnel is healthy.

```bash
cf-inspector attach --port 9229
```

`attach` checks the port-level `/json/version` endpoint, so raw-target and
worker selectors do not apply to this smoke test.

---

## 🔭 How it works

```
┌──────────────────────┐   1. GET http://127.0.0.1:<port>/json/list
│ cf-inspector         │   2. Open the selected raw WebSocket target
│  snapshot --bp X:Y   │ ─►3. Optionally attach to a selected NodeWorker sub-session
└──────────────────────┘   4. Debugger.enable + Runtime.enable
            │              5. Debugger.setBreakpointByUrl({ urlRegex, lineNumber: Y - 1 })
            ▼              6. Wait for `Debugger.paused`
   JSON snapshot           7. Debugger.evaluateOnCallFrame({ throwOnSideEffect: true, ... })
                           8. Runtime.getProperties(...) when object/scopes are expanded
                           9. Debugger.resume   (unless --keep-paused)
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

If `--port` is omitted, all of `--region/--org/--space/--app` are required. The
CLI does not read ambient `cf target` state. It calls `startDebugger(...)` from
`@saptools/cf-debugger`, attaches over the SSH tunnel, and disposes the tunnel
on exit. You get the same one-shot UX whether the target is local or in CF.

The tunnel forwards one inspector port. Nested NodeWorker sessions carried by
that inspector connection are selectable with `--worker`; a worker exposing
only an unrelated separate port is outside that tunnel's reach.

```bash
cf-inspector snapshot \
  --region eu10 --org my-org --space dev --app my-srv \
  --bp src/handler.ts:42 \
  --capture 'req.url, this.user'
```

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
