# Changelog

## 0.8.0 - 2026-07-23

### Machine-readable debugger readiness

- Added opt-in `--ready-event` support to `snapshot`, `watch`, `exception`, and
  `log`. Each command writes the same versioned `breakpoint-armed` JSON event
  to stderr after all initially/currently registered isolates finish arming and
  immediately before waiting or streaming.
- Kept default stdout, stderr, progress prose, and final JSON behavior
  unchanged when the new flag is absent. `snapshot --quiet --ready-event`
  suppresses progress lines while retaining the explicitly requested event.
- Gate `log --ready-event` output until aggregate arming completes, so no
  matching log event is emitted or counted ahead of the readiness marker.
- Added a local externally-triggered inspector fixture proving all four
  commands can synchronize without guessed startup delays.

### Isolate-aware script listing

- **BEHAVIOR CHANGE:** `list-scripts` now follows the normal implicit fan-out
  model, aggregating scripts from the main isolate and all current workers.
  JSON entries include an `isolate` tag; human rows append isolate as a third
  tab-separated column. Explicit isolate selectors still narrow the command.

## 0.7.1 - 2026-07-23

### Exclusive debugger sessions

- Refuse a second local `cf-inspector` session for the same inspector target
  before it opens a debugger WebSocket. The dedicated
  `TARGET_ALREADY_DEBUGGED` error identifies the live owner and explains the
  risk to application traffic.
- Added process-owned, target-scoped lock files under
  `~/.saptools/cf-inspector/locks`, with automatic dead-PID reclamation and
  ownership-safe cleanup on normal, error, timeout, and signal exits.
- Added local real-inspector coverage for deterministic CDP breakpoint-ID
  collisions, competing resume behavior, command-wide exclusion, first-session
  continuity, and SIGKILL stale-lock recovery.

## 0.7.0 - 2026-07-22

### Automatic isolate fan-out

- **BREAKING:** snapshot, watch, exception, and log now attach to the main
  isolate plus every current and newly-attached NodeWorker when no explicit
  isolate selector is passed. Results identify the winning/emitting isolate.
- Added stable `--worker-id <id>` selection and explicit `--main-only`; retained
  the existing meanings of `--worker <index>` and `--target <index>`.
- Added per-session breakpoint outcomes, first-pause racing, paused-loser resume,
  bounded explicit breakpoint cleanup, and dynamic late-worker arming.

### Tunnel and breakpoint reliability

- Reused Cloud Foundry tunnel ports must pass `/json/version` liveness polling
  before they are reported ready; stale/not-yet-ready ports now fail with an
  actionable error at tunnel acquisition.
- Long-running watch sessions probe tunnel liveness and fail after three
  consecutive unsuccessful probes instead of hanging indefinitely.
- Added `check-breakpoint`, which distinguishes unloaded/path-mismatched scripts
  from loaded scripts whose requested line is not breakable.

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
