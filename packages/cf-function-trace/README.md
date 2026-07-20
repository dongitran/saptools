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
requires `--confirm-impact` — `plan` included, even though `plan` itself never pauses anything, since
opening the remote tunnel at all requires the same confirmation. When an app instance runs more than
one Node.js process (for example a
`npm start` launcher alongside the app server), the tunnel auto-selects the process that owns the
app's `$PORT` listening socket — the HTTP server — so `--node-pid` is usually unnecessary. Pass
`--node-pid <pid>` only to override that choice, or when no single Node process listens on `$PORT`
(in which case selection stays ambiguous and fails closed). `--tunnel-port` is optional and selects a
preferred local CF SSH-forwarding port; omit it to keep `cf-debugger`'s normal automatic allocation.

## Non-interactive recording

`record` writes `{"event":"breakpoint-armed"}` to stderr the instant the entry breakpoint is live,
then blocks on stdout until the traced function actually returns (or a limit ends the run). An agent
or script cannot run it in the foreground and then trigger the request afterward — it must arm
`record` in the background, wait for that stderr line, trigger the request, and only then collect the
result:

```bash
# 1. Start record in the background; redirect stdout (final summary) and
#    stderr (the armed signal) to files.
cf-function-trace record file:///home/vcap/app/dist/orders.js OrderService.create \
  --app orders-srv --region eu10 --org my-org --space dev \
  --confirm-impact --call-depth 0 \
  >/tmp/cf-trace.out 2>/tmp/cf-trace.err &
disown

# 2. Wait for the armed signal. Poll the file itself so this still works even
#    if the next step runs as a separate shell invocation.
until grep -q '"event":"breakpoint-armed"' /tmp/cf-trace.err 2>/dev/null; do
  sleep 0.5
done

# 3. Trigger the real request now that the breakpoint is live.
curl -s -X POST https://orders-srv.example.com/orders -d '{"tempID":"abc"}'

# 4. Wait for record to finish -- its stdout file goes from empty to one JSON line.
until [ -s /tmp/cf-trace.out ]; do
  sleep 0.5
done
RUN_ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/cf-trace.out","utf8")).runId)')

# 5. Collect.
cf-function-trace show "$RUN_ID" --changes-only
```

If every step above runs inside one shell invocation, ordinary job control also works
(`RECORD_PID=$!` then `wait "$RECORD_PID"`). Prefer the file-polling form when steps run as separate
tool calls or a fresh shell each time: job control does not survive that, but the redirected files do.
`plan` never needs this recipe — it resolves the same file/selector pair and exits immediately without
arming a breakpoint.

### Stopping a backgrounded record

Stop a backgrounded `record` with **`SIGTERM`, never `SIGKILL`**:

```bash
kill -TERM "$RECORD_PID"
# never: kill -9 / kill -KILL
```

`record` installs a process-wide guard so `SIGINT`, `SIGTERM`, an uncaught exception, or an unhandled
rejection all resume the paused application and close the owned SSH tunnel before the process exits.
`SIGTERM` gets a graceful window first; a second signal, or a fatal error, escalates straight to that
same guarded cleanup. `SIGKILL` cannot be caught by any process, so none of this runs: a `SIGKILL`'d
`record` can leave the target app **paused at the breakpoint** and its `cf ssh` tunnel **orphaned**
(the child process outlives the killed parent and keeps the local port and SSH session open),
freezing the app until that tunnel is cleared.

If a `SIGKILL` already happened, the tunnel is registered in the same session store `cf-debugger`
itself uses: run `cf-debugger list` to confirm the orphaned session, then `cf-debugger stop <app>` to
terminate it safely. If that does not clear it, find and kill the leftover `cf ssh <app>` process
directly. Until a self-heal follow-up lands in `cf-debugger` itself, this manual step is the only way
to recover a `SIGKILL`'d run.

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

### Output kinds

Event `kind`: `baseline` (first pause, full state), `pause` (a later step), `exception` (an exception
pause), `completed` (normal terminal event), `truncated` (terminal event when a limit such as
`--max-steps` cut the run short).

Event `artifactKind`: `full` (a complete state snapshot backs this event), `patch` (a JSON Pointer
diff from the previous state backs it), `unchanged` (state hash identical to the previous event).

Per-node/frame `completeness`: `complete`, `truncated` (a limit cut it off), `unavailable` (not
captured — a getter, or an internal-slot value such as a `Map`/`Promise`/`Proxy`), `error` (capturing
it failed).

Tagged non-JSON values carry their own `kind`: `undefined`, `bigint`, `special-number`
(`NaN`/`Infinity`), `symbol`, `accessor` (getter/setter, never invoked), `unavailable`, `ref` (a
back-reference to an already-captured node — cycles and aliases), `redacted` (a sensitive key or a
matched string such as an email address).

### Truncated output

`show` degrades event detail before ever dropping an event outright: it caps each event's
`changedPaths` list first, then drops to a compact per-event form (function name/depth/line/column,
no `stateHash`), then shrinks the page itself — so a run's terminal event is the last thing to
disappear under a tight `--max-output-bytes`, never the first.

`state` and `diff` each hold one arbitrary JSON payload, not a list, so neither can shrink piece by
piece. An over-budget response instead degrades to the request envelope (`runId`/`seq` or
`runId`/`from`/`to`, plus `path` if one was given) with `truncated: true`, `originalBytes`, and a
`hint` string describing exactly how to get a response that fits — never a bare, content-free stub.
For example:

```json
{"runId":"t0123456789abcdef","seq":11,"truncated":true,"originalBytes":124637,"hint":"Exceeds --max-output-bytes=300; narrow with --path, or raise --max-output-bytes to see the full result."}
```

To see the data: narrow with `--path <json-pointer>`, or raise `--max-output-bytes` (default
`24000`, maximum `1000000`).

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
--max-root-vars <count>
--max-properties <count>
--max-nodes <count>
--max-state-bytes <bytes>
--async-stack-depth <count>
```

`--match <expr>` scopes the trace to one activation (see Trace semantics). `--async-stack-depth`
sets the async call-stack depth requested for async traces so resumed frames carry async stack
context; it is reset when the trace ends. `--max-root-vars` bounds how many top-level
locals/`this`/`return` a frame may show at all; `--max-properties` separately bounds how many
properties an individual captured object may show (its fan-out), so raising visibility into a
function's own scope does not also fatten every nested object.

Capture reads property descriptors without invoking getters. Cycles and aliases become graph
references; accessors, special numbers, bigint, unavailable values, and truncated values use tagged
records. Maps, sets, promises, dates, proxies, and other internal-slot values are explicitly marked
truncated or unavailable rather than falsely reported as complete. A captured function value's
`description` is hard-capped in length regardless of the remaining byte budget, since V8 reports a
function's full source text there. Sensitive keys, common authorization/token/certificate/credential
string forms, and email addresses are redacted before hashing, diffing, temporary writes, persistent
writes, or process output; set `CF_FUNCTION_TRACE_SENSITIVE_KEYS` (comma-separated key names) to
redact additional project-specific PII fields. There is deliberately no raw-data switch.

Capture, persistence, and stepping are watchdog-bounded by both the overall and cumulative pause
deadlines. After the first hit, the one-shot entry breakpoint is removed before tracing continues.
On completion or failure, cleanup disables exception pauses before sending the final resume, then
closes the inspector and the owned Cloud Foundry tunnel. If both tracing and cleanup fail, the CLI
reports `CLEANUP_FAILED` and explicitly says when resume could not be confirmed. An unreachable
inspector cannot provide an absolute real-time resume guarantee, so production tracing still
requires explicit impact confirmation and conservative limits. Session disposal preserves the
primary operation failure together with inspector and tunnel cleanup failures instead of allowing a
later `finally` error to hide an earlier cause.

## Errors

Every command prints one JSON object: a result on stdout, or `{"error":{"code":...,"message":...}}`
on stderr with exit code `2` (usage or data errors, including Commander's own parse errors such as an
unknown flag or a missing required option) or `1` (an unexpected failure). A bare invocation with no
arguments prints the command list to stdout and still exits `1`; nothing is ever silent.

- `INVALID_RUN_ID`: the run selector itself is malformed (not `latest`, not `t` followed by 16
  lowercase hex characters) — checked before any lookup is attempted.
- `RUN_NOT_FOUND`: the ID is well-formed but no run exists at that ID (expired, purged, or never
  created).
- `AMBIGUOUS_FUNCTION`: the selector matches more than one function in the file. The error's
  `candidates` array lists each match's exact `selector` (use it verbatim to retry), `kind`, and
  `startLine`/`endLine`, instead of leaving the caller to guess a more specific name.
- `SESSION_ALREADY_RUNNING`: a tunnel already exists for this exact app/process/instance, thrown
  before any run is created. Run `cf-debugger list` to see it, then `cf-debugger stop <app>` before
  retrying.
- Partial run on `MAX_PAUSED_TIME` or `TRACE_TIMEOUT`: real, recoverable data is still on disk. The
  thrown error carries `runId` and `directory` fields alongside `code`/`message`, so the run can
  still be `show`n, `state`d, and `diff`ed without a separate `runs` lookup. Hitting `--max-steps` is
  not an error at all: `record` exits normally with `"status":"partial"` in its stdout summary.
- `CLEANUP_FAILED`: both the traced operation and its cleanup failed; the message says whether resume
  could not be confirmed. Treat the target app as possibly still paused until verified otherwise.

See "Stopping a backgrounded record" above for the `SIGTERM`-not-`SIGKILL` rule when a `record` needs
to be stopped early instead of failing on its own.

## Library API

The package exports the planner, controller ports, inspector adapter, state capture/diff helpers,
run reader/store, recorder, and local/Cloud Foundry session lifecycle. Public locations use the
Chrome DevTools Protocol's zero-based line and column convention; CLI plan output is one-based for
terminal readability.

## Current boundary

Version `0.2.x` traces one selected activation — synchronous or asynchronous — in one Node.js
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
