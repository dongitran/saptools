---
name: cf-function-trace
description: Use when capturing a bounded, redacted step-by-step state timeline for one loaded Node.js function on SAP BTP Cloud Foundry or a local Node inspector, including non-interactive breakpoint arming, request correlation with --match, per-step state/diff queries, and safe cleanup of the debugger session and SSH tunnel, through the cf-function-trace CLI.
---

# CF Function Trace

## Purpose

Use `cf-function-trace` to answer "what did this one function's locals, `this`, and return value look
like at each step of one specific call?" It resolves the exact source V8 has loaded, arms one exact
entry breakpoint, single-steps the selected function (optionally into its own app-owned synchronous
children), and stores an initial full state plus small per-step patches as a queryable local run.

Prefer it over `cf-inspector snapshot`/`watch` when the question is about a function's own state
changing across a call, not a single paused moment. Prefer `cf-live-trace` instead when the question is
about HTTP request/response bodies, not internal variable state.

If `cf-function-trace` is missing, install it: `npm install -g @saptools/cf-function-trace`.

Captured state is redacted (sensitive keys, tokens, connection strings, and email addresses become
`[REDACTED]`) but can still contain business data. Treat run output and the local run store the same
way as raw application data.

## First Steps

1. Identify the exact loaded file (an absolute path or a `file://` URL) and a function selector unique
   to that file. If unsure, run `plan` first — it resolves the function and prints its location without
   arming a breakpoint or pausing anything, and it fails fast with `AMBIGUOUS_FUNCTION` or
   `FUNCTION_NOT_FOUND` before any real tracing risk exists.
2. Choose exactly one target: a local `--port` (loopback only, for an app you already have `--inspect`
   access to), or a full Cloud Foundry selector (`--region --org --space --app`, plus optional
   `--process`/`--instance`). Every remote command — `plan` included — requires `--confirm-impact` to
   open the tunnel at all, even though only `record` actually pauses the process.
3. `record` blocks on stdout until the traced function actually runs and returns (or a limit is hit) —
   it does not return control after arming. Never run it in the foreground and then try to trigger the
   request afterward. Follow the Non-Interactive Record Recipe below.
4. Start with `--call-depth 0`. Node internals and anything under `node_modules` are never captured
   regardless of depth; only raise `--call-depth` to 1 or 2 once you know the child call you want is
   inside the app root.
5. Give a busy or shared target `--match <expr>` so the entry breakpoint only fires for the activation
   you intend, instead of the first caller to arrive after arming.
6. Every data command (`plan`/`record`/`show`/`state`/`diff`/`runs`/`purge`) prints one JSON object: a
   result on stdout, or `{"error":{"code":...,"message":...}}` on stderr with exit code 2 (usage/data
   errors) or 1 (unexpected failures) — nothing is ever silent. The one exception is meta-invocation:
   `--help`, `--version`, and a bare invocation with no arguments print Commander's own human-readable
   help/version text to stdout instead (bare invocation still exits 1; `--help`/`--version` exit 0).

## Non-Interactive Record Recipe

`record` writes `{"event":"breakpoint-armed"}` to stderr the instant the entry breakpoint is live, then
blocks until the traced function returns or a limit (such as `--timeout`) ends the run. An agent must
therefore:

1. Start `record` in the background, redirecting stdout (final run summary) and stderr (the armed
   signal) to files.
2. Wait for `breakpoint-armed` to appear in the stderr file — poll the file itself, not a shell job or
   PID, so this still works if each step below runs as a separate tool call in a fresh shell.
3. Only now trigger the real request that invokes the traced function.
4. Let `record` finish on its own. It writes exactly one JSON line to stdout when done, so a non-empty
   stdout file is the completion signal.
5. Collect the run: parse `runId` from that stdout line (or use the selector `latest`), then
   `show`/`state`/`diff` it.

```bash
# 1. Arm in the background.
cf-function-trace record file:///home/vcap/app/dist/orders.js OrderService.create \
  --app orders-srv --region eu10 --org my-org --space dev \
  --confirm-impact --call-depth 0 \
  >/tmp/cf-trace.out 2>/tmp/cf-trace.err &
disown

# 2. Wait for the armed signal before doing anything else.
until grep -q '"event":"breakpoint-armed"' /tmp/cf-trace.err 2>/dev/null; do
  sleep 0.5
done

# 3. Trigger the real request now that the breakpoint is live.
curl -s -X POST https://orders-srv.example.com/orders -d '{"tempID":"abc"}'

# 4. Wait for record to finish (its stdout file goes from empty to one JSON line).
until [ -s /tmp/cf-trace.out ]; do
  sleep 0.5
done
RUN_ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/cf-trace.out","utf8")).runId)')

# 5. Collect.
cf-function-trace show "$RUN_ID" --changes-only
cf-function-trace state "$RUN_ID" --at 0
cf-function-trace diff "$RUN_ID" --from 0 --to 5
```

If steps 1-4 run inside one single shell invocation, `RECORD_PID=$!` plus `wait "$RECORD_PID"` works
too. Across separate tool calls, prefer the file-polling form above — shell job control does not survive
a fresh shell, but the redirected files do. `plan` never needs this recipe: it resolves and exits
immediately without arming anything.

## Command Choice

Resolve a selector without pausing anything:

```bash
cf-function-trace plan file:///home/vcap/app/dist/orders.js OrderService.create --port 9229 --call-depth 0
```

Record a bounded timeline (see the recipe above for how to drive this non-interactively):

```bash
cf-function-trace record file:///home/vcap/app/dist/orders.js OrderService.create \
  --app orders-srv --region eu10 --org my-org --space dev --confirm-impact
```

Read a paginated event list, optionally only changed steps:

```bash
cf-function-trace show latest --changes-only --from 0 --limit 100
```

Read one exact reconstructed state, optionally narrowed to a JSON Pointer:

```bash
cf-function-trace state latest --at 17 --path /frames/0/roots
```

Compare two exact states:

```bash
cf-function-trace diff latest --from 9 --to 17 --path /frames/0
```

List and clean up local runs:

```bash
cf-function-trace runs --limit 20
cf-function-trace purge t0123456789abcdef
```

## Targeting And Correlation

Use `--match <expr>` to pin the trace to one activation amid concurrent traffic — V8 evaluates the
expression against the entry frame in-process, so non-matching activations never pause the target:

```bash
--match 'req.data.tempID === "abc"'
```

Without `--match`, the first caller to hit the function after arming is the one traced; quiesce unrelated
traffic in production instead.

`--call-depth 0|1|2` follows synchronous child calls whose loaded files are inside the app root only.
`--max-paused-ms` (default 5000, up to 600000) bounds cumulative real paused time; raise it for a function
that awaits slow I/O — `await` gaps run the isolate rather than staying frozen, so wall-clock `--timeout`
(default 60s) needs headroom separately. `--async-stack-depth` (default 4) sets the async call-stack depth
requested for `async`/`await` traces.

`--max-root-vars` (default 100) and `--max-properties` (default 100) are independent bounds: `--max-root-vars`
caps how many top-level locals/`this`/`return` a frame may show at all, while `--max-properties` caps the
fan-out (property count) of one already-captured object. Raise `--max-root-vars` to see more of a function's
own parameters/locals without also fattening every nested object's own property list. Capture priority within
a frame is `return`, then the function's own locals/parameters, then nested block locals, then `this` last —
so a large `this` (a framework/service object) is the first thing trimmed under a tight budget, not the
function's own arguments.

Remote targets auto-select the Node process that owns the app's `$PORT` listening socket (the HTTP server),
so `--node-pid` is usually unnecessary even when an instance runs more than one Node process. Pass
`--node-pid <pid>` only to override that choice or when no single process owns `$PORT` (selection then stays
ambiguous and fails closed rather than guessing).

## Reading Output

Event `kind`: `baseline` (first pause, full state), `pause` (a later step), `exception` (an exception pause),
`completed` (normal terminal event), `truncated` (terminal event when a limit cut the run short — for
example `--max-steps`).

Event `artifactKind`: `full` (a complete state snapshot backs this event), `patch` (a JSON Pointer diff from
the previous state backs it), `unchanged` (state hash identical to the previous event).

Per-node/frame `completeness`: `complete`, `truncated` (a limit cut it off), `unavailable` (not captured,
e.g. a getter or an internal-slot value like a `Map`/`Promise`/`Proxy`), `error` (capturing it failed).

Tagged non-JSON values carry a `kind`: `undefined`, `bigint`, `special-number` (`NaN`/`Infinity`), `symbol`,
`accessor` (getter/setter, never invoked), `unavailable`, `ref` (a back-reference to a node, used for cycles,
aliases, and any value already captured once), `redacted` (a sensitive key or matched string).

`show` degrades event detail before ever dropping an event: it first caps each event's `changedPaths` list,
then drops per-event detail to a compact form (function name/depth/line/column, no `stateHash`), then shrinks
the page — so the run's terminal event is the last thing to go missing, never the first.

`state` and `diff` cannot shrink a single JSON payload piece by piece, so an over-`--max-output-bytes` result
degrades to the request envelope (`runId`/`seq` or `runId`/`from`/`to`, plus `path` if given) with
`truncated: true`, `originalBytes`, and a `hint` string — never a bare content-free stub. To actually see the
data: narrow with `--path <json-pointer>`, or raise `--max-output-bytes` (default 24000, max 1000000).

## Error Codes And Recovery

- `INVALID_RUN_ID`: the run selector itself is malformed (not `latest` and not `t` + 16 lowercase hex
  characters) — checked before any lookup.
- `RUN_NOT_FOUND`: the ID is well-formed but no run exists at that ID (expired, purged, or never created).
- `AMBIGUOUS_FUNCTION`: the selector matches more than one function in the file. The error's `candidates`
  array lists each match's exact `selector` (use it verbatim to retry), `kind`, and `startLine`/`endLine` —
  read it instead of guessing a more specific name.
- `FUNCTION_NOT_FOUND` / `SCRIPT_NOT_FOUND` / `AMBIGUOUS_SCRIPT`: the file or selector did not resolve
  against what V8 actually has loaded; run `plan` to see the resolution fail cheaply before trying `record`.
- `SESSION_ALREADY_RUNNING`: a tunnel already exists for this exact app/process/instance (thrown before any
  run is created). Run `cf-debugger list` to see it, then `cf-debugger stop <app>` before retrying.
- `REMOTE_IMPACT_NOT_CONFIRMED`: a Cloud Foundry target was given without `--confirm-impact`.
- `SSH_NOT_ENABLED`: SSH is disabled for the app/space; this CLI never enables SSH or restarts the app for
  you (unlike some sibling tools) — enable it explicitly first.
- Partial run on `MAX_PAUSED_TIME`, `TRACE_TIMEOUT`, or hitting `--max-steps`: real, recoverable data is
  still on disk. A thrown `MAX_PAUSED_TIME`/`TRACE_TIMEOUT` error carries `runId` and `directory` fields
  alongside `code`/`message` — use that `runId` with `show`/`state`/`diff` instead of guessing which `runs`
  entry it was. Hitting `--max-steps` is not an error at all: `record` exits normally with `"status":"partial"`
  in its stdout summary.
- `CLEANUP_FAILED`: both the traced operation and its cleanup failed; the message says whether resume could
  not be confirmed. Treat the target app as possibly still paused and verify before relying on it.

## Stopping A Backgrounded Record (Critical Safety)

Stop a backgrounded `record` with **`SIGTERM`, never `SIGKILL`**.

`record` installs a process-wide guard so `SIGINT`/`SIGTERM`/`uncaughtException`/`unhandledRejection` all
resume the paused app and close the owned SSH tunnel before exit — `SIGTERM` gets a graceful window first, a
second signal or a fatal error escalates to that same guarded cleanup immediately. `SIGKILL` cannot be
caught by any process, by construction, so none of this runs. A `SIGKILL`'d `record` can leave the target
app **paused at the breakpoint** and its `cf ssh` tunnel **orphaned** (the child process outlives the killed
parent and keeps the local port and SSH session open), freezing the app until that tunnel is cleared.

```bash
kill -TERM "$RECORD_PID"          # correct
pkill -TERM -f 'cf-function-trace record'   # also fine
# never: kill -9 / kill -KILL / pkill -9
```

If a `SIGKILL` already happened: the tunnel is registered in the same session store `cf-debugger` itself
uses, so try `cf-debugger list` (install with `npm install -g @saptools/cf-debugger` if missing) to confirm
the orphaned session, then `cf-debugger stop <app>` to terminate it safely. If that does not clear it, find
and kill the leftover `cf ssh <app>` process directly (for example `ps aux | grep 'cf ssh'`, then `kill` the
matching PID). Until a self-heal follow-up lands in `cf-debugger` itself, this manual step is the only way
to recover a `SIGKILL`'d run.
