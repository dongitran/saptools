# Changelog

## 0.6.2 - 2026-07-20

- Require `@saptools/cf-debugger@^0.1.16` so consumers pick up the app-port Node process
  auto-selection when an instance runs several Node processes.

## 0.6.1 - 2026-07-20

### Async call stack depth

- Added `setAsyncCallStackDepth(session, maxDepth)` wrapping `Debugger.setAsyncCallStackDepth`, so
  consumers can request async stack frames on paused events and reset the depth during cleanup.

## 0.6.0 - 2026-07-19

### Exact function tracing primitives

- Added loaded script metadata and exact source retrieval through `Debugger.getScriptSource`.
- Added validated `Debugger.getPossibleBreakpoints` and exact-location breakpoint APIs with
  requested/actual location metadata.
- Exact-location setup now removes and rejects bindings that V8 relocates to another script, line,
  or zero-based column.
- Added step into/over/out and remote object/group release wrappers.
- Preserved rich pause frames, scopes, `this`, return values, script metadata, and async stack data.
- Remote descriptors now mark proxy values unavailable and internal-slot subtypes truncated when
  own-property traversal cannot represent their complete logical value.
- Made pause waits abortable without leaking event listeners or timers.
- Forwarded Cloud Foundry process, instance, and Node PID selectors through `openCfTunnel`.
- Added fail-closed `openOwnedCfTunnel` for consumers that must own cleanup. The existing
  `openCfTunnel` keeps its legacy same-machine port-reuse behavior for backward compatibility.

## 0.5.0 - 2026-07-13

### Deterministic Cloud Foundry targeting

- **BREAKING:** `--app` no longer fills missing selectors from ambient
  `cf target` state. Every command now requires explicit `--region`, `--org`,
  and `--space` alongside `--app`; `--port` behavior is unchanged.
- Missing selectors fail before any Cloud Foundry shell-out and name every
  required flag.

### Mutation guardrails

- **BREAKING:** `snapshot`, `watch`, and `exception` now evaluate both
  `--capture` and `--stack-captures` with V8's side-effect guard by default.
  Expressions V8 cannot prove side-effect-free return a blocked
  `CapturedExpression` with `blocked: true`, `mutationRisk: true`, and a
  `MUTATION_NOT_ALLOWED` error.
- Added `--allow-mutation` to those capture commands. Recognized mutation syntax
  runs under the opt-in and is annotated with `mutationRisk: true`.
- Added the optional `throwOnSideEffect` argument to the exported
  `evaluateOnFrame` API. Its programmatic default remains unrestricted for
  backward compatibility; the capture commands opt into the safe mode.
- Mutation-shaped native `snapshot`/`watch --condition` expressions require the
  same explicit opt-in. Mutation-capable `log`, `eval`, and `--setup-eval`
  surfaces remain executable and now emit advisory warnings.

### Worker sessions and diagnostics

- Added `--worker <index>` and Node's nested `NodeWorker` transport so snapshot,
  watch, exception, eval, log, and list-scripts can inspect a live worker
  beneath a raw inspector target.
- Extended `list-targets` with raw-target counts, worker labels, nested worker
  metadata, and actionable single-target guidance. Implicit target or worker
  selection and bound breakpoints that produce no hit now emit targeted hints.
- Preserved `--target <index>` for runtimes that publish workers as independent
  `/json/list` endpoints.
- Removed ignored `--target`/`--worker` options from `attach` and the ignored
  `--target` option from `list-targets`; those commands operate at the inspector
  port level or enumerate all raw targets, respectively.
- Verified the NodeWorker path with real Node.js 20, 22, 23, 24, and 25
  processes, including a worker alive before post-hoc `SIGUSR1` inspector
  activation, and added a real-inspector worker E2E fixture.

### Explicit truncation

- **BEHAVIOR CHANGE:** one-shot `snapshot` and `exception` captures now default
  to `131072` characters; repeated `watch` and `log` events retain the compact
  `4096`-character default.
- **BEHAVIOR CHANGE:** truncated JSON text is cut to exactly
  `--max-value-length` and no longer appends an in-band `...` suffix.
- Added optional `truncated: true` and exact `originalLength` metadata to text
  capture shapes. Added `omittedCount` for bounded object, scope, and frame
  expansion, plus field-local exception lengths and logpoint metadata.
- Untruncated output remains unchanged and omits all truncation fields.

### Reliability

- Inspector discovery now fails immediately on malformed JSON responses instead
  of retrying an invalid payload until the discovery timeout expires.
