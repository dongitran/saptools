# Changelog

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
