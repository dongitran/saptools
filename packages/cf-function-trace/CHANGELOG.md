# Changelog

## 0.2.6 - 2026-07-21

### Performance

- Capture "machinery" (framework/behavioral) objects shallowly by default, so a step no longer
  descends the entire service graph. An object V8 gives a constructed className other than
  `Object`/`Array` — the CAP service instance (`this`), a `cds.Request` (`req`), loggers, services —
  is now walked only `--machinery-depth` levels (default 1) instead of the full `--max-object-depth`,
  whether it is a root or nested. Plain `Object`/`Array` data (the request payload and user locals) is
  still captured to `--max-object-depth`. Previously `this` alone expanded to ~570 nodes per step, the
  main driver of slow, timeout-prone captures. Raise `--machinery-depth` (with `--max-object-depth`)
  to recover full framework visibility on demand, so nothing is permanently lost. Every step is still
  captured fresh, so values are never stale.

## 0.2.5 - 2026-07-21

### Performance

- Overlap the per-step object-graph capture's `getProperties` round trips. Each captured node now
  warms the next depth's child fetches concurrently through a per-capture request cache, while the
  walk still assembles nodes, ids, aliases, and diffs serially and deterministically — so the
  captured timeline is byte-identical, only the SSH-latency-bound network waits overlap. This cuts
  the paused-capture time that drove mid-trace timeouts on deep remote graphs.

## 0.2.4 - 2026-07-21

### Diff granularity

- Node ids are now derived from each value's path in the captured graph instead of a per-capture
  discovery-order counter, so the same logical object keeps a stable id across steps. This removes the
  spurious node churn that made a baseline-anchored `diff` (from the first captured step to a later
  one) collapse into a single whole-frame replace; those diffs are now granular per changed leaf, and
  a variable that never changed no longer appears in the diff.

## 0.2.3 - 2026-07-21

### Capture and diff correctness

- Diffs no longer collapse to a whole-frame replace. The incomplete-node removal safety net in the
  differ is now scoped to direct-child removals, so a truncated node no longer forces its entire
  subtree to re-emit. Real captures now produce granular per-step operations instead of one large
  replace blob.
- The capture budget is spent on the data that matters. Roots are captured in priority order (return
  value, own parameters and locals, block locals, `this`) with a per-root ceiling, so the request
  payload and user locals are no longer starved to `node-limit` by framework objects such as loggers
  and the CAP service graph.
- Function `description` values are hard-capped instead of dumping full function source into every
  step, cutting capture size and the repeated per-step serialization behind mid-trace timeouts.
- Split the overloaded `--max-properties` into `--max-root-vars` (root and local count) and
  `--max-properties` (per-object fan-out).

### CLI error contract

- A mistyped or missing flag now emits a structured JSON error on stderr with a non-zero exit,
  instead of exiting silently with no output.
- `state` and `diff` responses that exceed `--max-output-bytes` now preserve the request envelope and
  include a hint (narrow with `--path`, or raise `--max-output-bytes`) instead of returning a
  content-free stub.
- Errors are actionable: parse errors, `AMBIGUOUS_FUNCTION` candidate lists, the operational
  `SESSION_ALREADY_RUNNING` guidance, and `RUN_NOT_FOUND` (with no leaked filesystem paths) are
  surfaced.
- A `record` that times out now attaches the partial run id to the error so the captured partial
  timeline can still be read.

### Privacy

- Redaction now covers email and PII patterns and an optional `CF_FUNCTION_TRACE_SENSITIVE_KEYS` key
  list, in addition to credential-shaped secrets. Note: because redaction also runs during
  replay-hash verification, trace runs captured before 0.2.3 can report a state hash mismatch when
  read; re-record to get a clean run.

### Documentation

- Added a cf-function-trace skill and expanded the README with the non-interactive record recipe, the
  output and error reference, and the flag reference. A backgrounded `record` must be stopped with
  SIGTERM, never SIGKILL, until the debugger self-heals an orphaned tunnel.

## 0.2.2 - 2026-07-21

### Reliability

- Guarantee the target app resumes and the SSH tunnel is torn down on every termination path. An
  uncaught exception or rejection (for example during a large state capture) previously bypassed
  cleanup, and a signal-driven stop had only implicit protection — either could leave V8 paused and
  the `cf ssh` tunnel orphaned, freezing the app until the tunnel was killed by hand. A process-wide
  resource guard now releases the tunnel, inspector session, and debugger state on SIGINT, SIGTERM,
  `uncaughtException`, and `unhandledRejection`, with a bounded forced-exit fallback and immediate
  escalation on a repeated signal.

## 0.2.1 - 2026-07-20

- Require `@saptools/cf-inspector@^0.6.2` (which pulls `@saptools/cf-debugger@^0.1.16`) so the
  async-stack-depth API and app-port Node auto-selection resolve from the published dependency chain.

## 0.2.0 - 2026-07-20

### Async function tracing

- Trace `async` functions and functions containing `await`: V8's async-aware stepping stays bound to
  the one selected activation across each `await`, capturing and diffing the same per-step state
  timeline as synchronous traces. Unrelated pauses during an await gap are released and skipped.
- Select methods of decorator-compiled class expressions (`let X = class X {...}`), so decorated CAP
  and NestJS handlers resolve.
- Add `--match <expr>`, a conditional entry breakpoint that traces only an activation whose entry
  frame satisfies the expression, correlating one request amid concurrent traffic (sync and async).
- Add `--async-stack-depth <count>` and request async call-stack depth for async traces.
- Auto-select the app `$PORT` Node process through the tunnel, so `--node-pid` is usually unnecessary
  when an instance runs several Node processes.
- Raise the `--max-paused-ms` ceiling to 600000 for deeper remote captures.

## 0.1.1 - 2026-07-20

- Require the registry-compatible `@saptools/cf-inspector@^0.6.0` dependency chain.
- Add GitHub Actions trusted publishing after quality and Node.js 20/22/24 runtime gates.
- Verify the publish candidate alone in a clean consumer so dependencies resolve from npm.
- Replace workspace-only installation documentation with the public npm workflow.

## 0.1.0 - 2026-07-20

- Add local and explicitly confirmed SAP BTP Cloud Foundry inspector targets.
- Resolve exact loaded scripts and uniquely selected synchronous functions.
- Trace app-owned call depth 0–2 with bounded stepping, one-shot entry breakpoints, and
  ownership-aware cleanup.
- Capture side-effect-free tagged object graphs with stable scope identities, strict serialized-state
  bounds, and redaction before persistence.
- Store full checkpoints, granular array/object patches, source/state hashes, append-only events,
  exact replay validation, query-triggered retention, per-run quotas, and private modes.
- Record exception pauses distinctly and watchdog capture, persistence, stepping, and cleanup.
- Add compact `plan`, `record`, paginated `show`, exact `state`, `diff`, `runs`, and `purge`
  commands.
- Mark internal-slot values incomplete, expand credential redaction, and name the copied terminal
  checkpoint `completed` instead of incorrectly claiming a captured return value.
- Prevent remote tracing from enabling SSH or restarting an app implicitly.
- Return a stable, redacted `SSH_NOT_ENABLED` error and aggregate operation, inspector, and tunnel
  cleanup failures without masking earlier causes.
- Add an optional validated `--tunnel-port` that forwards to the debugger's existing preferred-port
  API without changing default port allocation.
- Add unit coverage, normal/failure local-inspector and fake-CF E2E coverage, and Node.js 20/22/24
  CI.
- Verify the package with coordinated debugger, inspector, and function-trace tarballs.
