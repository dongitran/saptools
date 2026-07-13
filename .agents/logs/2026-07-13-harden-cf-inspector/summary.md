# Task Summary

## Objective

Harden `@saptools/cf-inspector` against four verified production-debugging
failure modes: ambient Cloud Foundry target drift, unguarded capture mutations,
silent worker-isolate misses, and undetectable value/property truncation. Ship
the work as version `0.5.0`, preserve additive JSON/API compatibility, verify it
against fake CDP transports and real Node inspector fixtures, and deliver it in
a pushed pull request.

## Modified Files

- Package and release contract:
  - `packages/cf-inspector/package.json`
  - `packages/cf-inspector/README.md`
  - `packages/cf-inspector/CHANGELOG.md`
  - `packages/cf-inspector/implementation_plan.md` (ignored planning artifact)
- Public types and entrypoints:
  - `packages/cf-inspector/src/types.ts`
  - `packages/cf-inspector/src/index.ts`
  - `packages/cf-inspector/src/inspector/index.ts`
  - `packages/cf-inspector/src/inspector/types.ts`
- CDP, discovery, and session behavior:
  - `packages/cf-inspector/src/cdp/client.ts`
  - `packages/cf-inspector/src/inspector/discovery.ts`
  - `packages/cf-inspector/src/inspector/runtime.ts`
  - `packages/cf-inspector/src/inspector/session.ts`
- CLI behavior and output:
  - `packages/cf-inspector/src/cli/captureParser.ts`
  - `packages/cf-inspector/src/cli/commandTypes.ts`
  - `packages/cf-inspector/src/cli/output.ts`
  - `packages/cf-inspector/src/cli/program.ts`
  - `packages/cf-inspector/src/cli/target.ts`
  - `packages/cf-inspector/src/cli/warnings.ts`
  - `packages/cf-inspector/src/cli/commands/eval.ts`
  - `packages/cf-inspector/src/cli/commands/exception.ts`
  - `packages/cf-inspector/src/cli/commands/listScripts.ts`
  - `packages/cf-inspector/src/cli/commands/log.ts`
  - `packages/cf-inspector/src/cli/commands/snapshot.ts`
  - `packages/cf-inspector/src/cli/commands/watch.ts`
- Snapshot and logpoint capture:
  - `packages/cf-inspector/src/logpoint/events.ts`
  - `packages/cf-inspector/src/logpoint/stream.ts`
  - `packages/cf-inspector/src/snapshot/capture.ts`
  - `packages/cf-inspector/src/snapshot/evaluation.ts`
  - `packages/cf-inspector/src/snapshot/exception.ts`
  - `packages/cf-inspector/src/snapshot/objects.ts`
  - `packages/cf-inspector/src/snapshot/properties.ts`
  - `packages/cf-inspector/src/snapshot/scopes.ts`
  - `packages/cf-inspector/src/snapshot/stack.ts`
  - `packages/cf-inspector/src/snapshot/values.ts`
- E2E coverage and fixtures:
  - `packages/cf-inspector/tests/e2e/000-worker-thread.e2e.ts`
  - `packages/cf-inspector/tests/e2e/cli.e2e.ts`
  - `packages/cf-inspector/tests/e2e/eval.e2e.ts`
  - `packages/cf-inspector/tests/e2e/exception.e2e.ts`
  - `packages/cf-inspector/tests/e2e/logpoint.e2e.ts`
  - `packages/cf-inspector/tests/e2e/snapshot.e2e.ts`
  - `packages/cf-inspector/tests/e2e/watch.e2e.ts`
  - `packages/cf-inspector/tests/e2e/helpers.ts`
  - `packages/cf-inspector/tests/e2e/fixtures/000-thread-host.mjs`
  - `packages/cf-inspector/tests/e2e/fixtures/001-thread-worker.mjs`
  - `packages/cf-inspector/tests/e2e/fixtures/sample-app.mjs`
- Unit coverage:
  - `packages/cf-inspector/tests/unit/000-truncation.test.ts`
  - `packages/cf-inspector/tests/unit/captureParser.test.ts`
  - `packages/cf-inspector/tests/unit/cdp.test.ts`
  - `packages/cf-inspector/tests/unit/cliOutput.test.ts`
  - `packages/cf-inspector/tests/unit/exception.test.ts`
  - `packages/cf-inspector/tests/unit/inspector.test.ts`
  - `packages/cf-inspector/tests/unit/inspectorDiscovery.test.ts`
  - `packages/cf-inspector/tests/unit/logpoint.test.ts`
  - `packages/cf-inspector/tests/unit/setupEvalCommands.test.ts`
  - `packages/cf-inspector/tests/unit/snapshot.test.ts`
  - `packages/cf-inspector/tests/unit/stack.test.ts`
  - `packages/cf-inspector/tests/unit/target.test.ts`
- Required interaction record:
  - `.agents/logs/2026-07-13-harden-cf-inspector/summary.md`
  - `.agents/logs/2026-07-13-harden-cf-inspector/tool-trace.md`

No file in `packages/cf-debugger` was modified. Pre-existing unrelated dirty and
untracked workspace files were preserved.

## Lessons & Decisions

- Deterministic CF targeting is the only reliable defense against ambient target
  drift. `--app` now requires explicit region, org, and space for every command;
  no `cf target` read or app-existence lookup is attempted. The current
  `@saptools/cf-debugger` public API has no app enumeration primitive, so no
  cross-package change was justified.
- V8 `throwOnSideEffect` works on `Debugger.evaluateOnCallFrame` in Node 20, 22,
  24, and 25 and returns an `EvalError` envelope rather than rejecting the CDP
  request. CLI capture surfaces opt into it; the exported low-level API remains
  unrestricted by default for compatibility.
- Mutation syntax scanning is advisory only. Native breakpoint/log conditions,
  global eval, and setup eval cannot use the paused-frame V8 guard, so their
  warnings and explicit native-condition opt-in do not claim proof of purity.
- Empirical Node 20, 22, 23, 24, and 25 testing contradicted the starting brief:
  workers were nested `NodeWorker` sessions, not `Target` auto-attach sessions or
  separate same-port `/json/list` entries. Correct routing serializes inner CDP
  messages through `NodeWorker.sendMessageToWorker`. A worker alive before
  post-hoc `SIGUSR1` activation was also discoverable on tested modern runtimes.
- Exact truncation requires preserving full leaf strings, materializing objects
  once, and applying the character bound only to the final serialized value.
  Direct structural omissions are reported at their owning node; aggregate
  object omissions sum only known direct markers and do not pretend to count
  unvisited descendants.
- One-shot capture defaults are now 131072 characters; repeated watch/log events
  remain at 4096. Explicit limits are exact, JSON values have no in-band
  ellipsis, and optional metadata is absent when output is complete.
- Deep review uncovered two adjacent correctness issues and fixed them in scope:
  malformed discovery JSON now fails immediately, and ignored target/worker
  selectors were removed from port-level `attach`/enumerating `list-targets`
  help rather than continuing to advertise behavior those handlers did not use.
- No repository-local `./skills` directory or cf-inspector skill exists, so the
  requested skill update was correctly skipped.

## Verification And Delivery

- `npm run build`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run test:unit`: 323 passed; 91.1% statement coverage.
- `npm run test:e2e`: 64 passed against real Node inspector fixtures.
- Focused CSpell: 0 issues.
- Diff check, generated declaration audit, and package-scoped secret scan passed.
- Source console scan found only the pre-existing generated logpoint
  `console.log` protocol strings required to emit CDP console events.
- Commits: `eecca77`, `dfa4c6f`, `9a5cbb0`, `bbf6c5d`, `6d875f5`, `0702c8d`.
- Branch: `codex/harden-cf-inspector`.
- Pull request: https://github.com/dongitran/saptools/pull/100
