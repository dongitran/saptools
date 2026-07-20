<!-- cspell:words appRoots callDepth first-hit internal-slot nextSeq nodePid replayable saptools sourceHash unserializable -->

# `@saptools/cf-function-trace`

`cf-function-trace` turns one loaded JavaScript file plus one function selector into a bounded,
redacted runtime timeline. It connects through `@saptools/cf-inspector`, resolves the exact source
currently loaded by V8, arms one exact breakpoint, steps through the selected function, and stores
an initial full state followed by replayable state patches.

The default store is private local state under:

```text
~/.saptools/cf-function-trace/data/t<16-hex>/
```

This package is designed for AI agents and terminal automation: command output is compact JSON,
the breakpoint-ready signal is machine readable, and saved runs can be queried without reconnecting
to Cloud Foundry.

## Installation

Install the CLI from npm:

```bash
npm install --global @saptools/cf-function-trace
cf-function-trace --help
```

For repository development, build and run the workspace package directly:

```bash
pnpm install
pnpm --filter @saptools/cf-function-trace... build
node packages/cf-function-trace/dist/cli.js --help
```

Node.js 20 or newer is required. For a Cloud Foundry target, the `cf` CLI must already be installed
and authenticated, and SSH must be enabled for the app and space.

The tracer uses an ownership-only tunnel and passes `allowSshEnableRestart: false` to
`cf-debugger`. If SSH is disabled, `plan` and `record` fail without enabling SSH or restarting the
application and return the stable code `SSH_NOT_ENABLED`. Enabling SSH and restarting an app remain
explicit operator actions outside this CLI.

The published package requires `@saptools/cf-inspector@^0.6.0`, which in turn resolves a compatible
`@saptools/cf-debugger`. CI installs the function-trace tarball by itself in a clean project so this
registry dependency chain is verified without workspace links.

## Quick start

First start `record`. It writes `{"event":"breakpoint-armed"}` to stderr only after the exact
breakpoint is active. Trigger the application request that invokes the function after receiving that
event; the CLI then writes its final run summary to stdout.

Local inspector:

```bash
cf-function-trace plan file:///srv/app/dist/orders.js OrderService.create \
  --port 9229 --call-depth 0

cf-function-trace record file:///srv/app/dist/orders.js OrderService.create \
  --port 9229 --call-depth 0
```

SAP BTP Cloud Foundry:

```bash
cf-function-trace record file:///home/vcap/app/dist/orders.js OrderService.create \
  --region eu10 \
  --org my-org \
  --space dev \
  --app orders-srv \
  --process web \
  --instance 0 \
  --tunnel-port 24321 \
  --confirm-impact
```

Remote tracing pauses the selected Node.js process while state is captured. The command therefore
requires `--confirm-impact`. When an app instance runs more than one Node.js process (for example a
`npm start` launcher alongside the app server), the tunnel auto-selects the process that owns the
app's `$PORT` listening socket — the HTTP server — so `--node-pid` is usually unnecessary. Pass
`--node-pid <pid>` only to override that choice, or when no single Node process listens on `$PORT`
(in which case selection stays ambiguous and fails closed). `--tunnel-port` is optional and selects a
preferred local CF SSH-forwarding port; omit it to keep `cf-debugger`'s normal automatic allocation.

## Query a saved run

```bash
cf-function-trace show latest --changes-only --from 0 --limit 100
cf-function-trace state latest --at 17 --path /frames/0
cf-function-trace diff latest --from 9 --to 17 --path /frames/0
cf-function-trace runs --limit 20
cf-function-trace purge t0123456789abcdef
```

`show` gives a byte-bounded event page with `hasMore` and `nextSeq`; pass `nextSeq` back through
`--from` to continue without loading the full timeline. `state` requires an exact event sequence,
then verifies event kind, artifact kind, replay chain, and state hash. `diff` compares any two exact
reconstructed states. `purge` accepts only a complete validated run ID.

## Trace semantics

- `--call-depth 0` captures only the selected function.
- `--call-depth 1` or `2` can follow synchronous child calls whose loaded files are inside the
  runtime app root.
- Node internals and files below `node_modules` are stepped out of and never captured.
- Async functions and functions containing `await` are traced with V8's async-aware stepping: the
  step loop stays bound to the one selected activation across each `await`. Between step boundaries
  the isolate runs (so the awaited I/O settles) rather than staying frozen, and unrelated pauses that
  occur during that window are released and skipped. Give a busy target `--match` to pin the exact
  activation (see below). `--max-paused-ms` still bounds only real paused time, so raise `--timeout`
  when the traced function awaits slow I/O.
- The function selector must be unique. Supported selectors include declarations, arrow/function
  expressions, class methods (including decorator-compiled class expressions such as
  `let X = class X {...}`), constructors, accessors, object methods, and simple assigned methods.
- Exact loaded URLs and absolute paths are preferred. A relative path is accepted only when it has
  one unique suffix match below the verified app root.
- `record` selects the first function entry hit after `breakpoint-armed`. Pass `--match <expr>` to arm
  a conditional entry breakpoint so only an activation whose entry frame satisfies the JavaScript
  expression is traced — for example `--match 'req.data.tempID === "abc"'`. V8 evaluates the condition
  in-process, so concurrent activations that do not match never pause the target. Without `--match`,
  production callers should quiesce unrelated traffic because the first hit cannot otherwise be proven
  to be the intended request.

The implementation reads source with the Chrome DevTools Protocol rather than depending on
`cf-explorer`: inspector source is the exact code V8 is executing. `cf-explorer` remains useful for
human discovery and is a possible future source-map fallback, but it is not required for a trace.

## Storage and diff model

The first pause is a full redacted state. Changed pauses use deterministic JSON Pointer patches;
arrays are compared by stable prefix/suffix and index so one local-variable change does not replace
the whole frame list. New variables and frames use full `add` values. Unchanged pauses retain a
small event referencing the same state hash. A full checkpoint is written periodically and at a
normal trace end. The terminal event is named `completed`: its state is the last confirmed pause,
not a newly captured JavaScript return value.

```text
data/t<run-id>/
  manifest.json
  events/000000.json
  events/000001.json
  states/000000.full.json
  states/000001.patch.json
```

Directories use mode `0700`, files use `0600`, and writes are atomic. Runs expire after 24 hours by
default, each run is capped at 64 MiB, and the store keeps at most 100 runs unless the library API
configures `retentionMs`, `maxRunBytes`, or `maxRuns` differently. Expired runs are pruned when a
new run or an offline query command starts; there is no background deletion daemon. Event and state
sequence files are append-only, and readers cross-check every event/artifact pair before replay.
The manifest includes `sourceHash`, a SHA-256 digest of the exact source returned by V8, so a saved
run can be distinguished from the same URL after another deployment.

## Safety limits

Important bounds have conservative defaults and strict upper limits:

```text
--timeout <seconds>
--max-steps <count>
--max-paused-ms <milliseconds>
--checkpoint-every <count>
--max-object-depth <depth>
--max-properties <count>
--max-nodes <count>
--max-state-bytes <bytes>
--async-stack-depth <count>
```

`--match <expr>` scopes the trace to one activation (see Trace semantics). `--async-stack-depth`
sets the async call-stack depth requested for async traces so resumed frames carry async stack
context; it is reset when the trace ends.

Capture reads property descriptors without invoking getters. Cycles and aliases become graph
references; accessors, special numbers, bigint, unavailable values, and truncated values use tagged
records. Maps, sets, promises, dates, proxies, and other internal-slot values are explicitly marked
truncated or unavailable rather than falsely reported as complete. Sensitive keys and common
authorization, token, certificate, and credential string forms are redacted before hashing,
diffing, temporary writes, persistent writes, or process output. There is deliberately no raw-data
switch.

Capture, persistence, and stepping are watchdog-bounded by both the overall and cumulative pause
deadlines. After the first hit, the one-shot entry breakpoint is removed before tracing continues.
On completion or failure, cleanup disables exception pauses before sending the final resume, then
closes the inspector and the owned Cloud Foundry tunnel. If both tracing and cleanup fail, the CLI
reports `CLEANUP_FAILED` and explicitly says when resume could not be confirmed. An unreachable
inspector cannot provide an absolute real-time resume guarantee, so production tracing still
requires explicit impact confirmation and conservative limits. Session disposal preserves the
primary operation failure together with inspector and tunnel cleanup failures instead of allowing a
later `finally` error to hide an earlier cause.

## Library API

The package exports the planner, controller ports, inspector adapter, state capture/diff helpers,
run reader/store, recorder, and local/Cloud Foundry session lifecycle. Public locations use the
Chrome DevTools Protocol's zero-based line and column convention; CLI plan output is one-based for
terminal readability.

## Current boundary

Version `0.1.x` traces one selected activation — synchronous or asynchronous — in one Node.js
isolate. Async support uses V8's async-aware stepping and stays bound to the selected activation
across `await`; because settling awaited I/O requires briefly resuming the shared isolate, an async
trace is an interleaved sequence of frozen snapshots rather than one atomic frozen window, and
unrelated production work runs during each await gap. Following `--call-depth` into asynchronous
child calls, `for await ... of` loops, tracing multiple workers at once, generating traffic, and
mapping bundled code back through source maps are still out of scope. It also cannot cancel every
already-running filesystem or CDP promise after a watchdog fires. Choose a target/worker explicitly
where needed, prefer `--match` on busy targets, and trigger the relevant request only after the
armed event.

No live Cloud Foundry environment is used by the automated tests. The local E2E suite drives a real
Node.js inspector and covers normal, exception, and termination paths. The fake-CF suite
verifies remote selector forwarding and cleanup without credentials or SAP network access.
