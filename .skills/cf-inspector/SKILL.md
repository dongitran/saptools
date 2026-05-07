---
name: cf-inspector
description: Use when working with @saptools/cf-inspector, the cf-inspector CLI, or Cloud Foundry Node.js inspector debugging. Helps agents choose snapshot, watch, log, exception, eval, list-scripts, or attach commands; use local inspector ports or CF auto-tunnel targets; capture runtime variables safely; troubleshoot path mapping; and modify or test packages/cf-inspector in this monorepo.
---

# CF Inspector

## Purpose

Use `@saptools/cf-inspector` to drive a Node.js V8 inspector over the Chrome DevTools Protocol without an IDE. Prefer it when a task needs runtime evidence from a local `--inspect` process or a SAP BTP Cloud Foundry Node.js app reachable through `@saptools/cf-debugger`.

Treat captured runtime values as sensitive. Snapshots, scopes, logpoints, exception values, and app environment data can contain tokens, user data, credentials, or business payloads. Redact before sharing outside the local task.

## First Steps

1. Identify whether the user wants to run the tool, explain usage, debug an app, or modify `packages/cf-inspector`.
2. For code changes in this repo, follow repository AGENTS rules first: inspect files with `rg` and direct reads, update `implementation_plan.md` before edits, keep TypeScript strict, and run focused checks.
3. Confirm the target:
   - Use `--port <number>` and optional `--host <host>` for an existing local inspector or tunnel.
   - Use all of `--region --org --space --app` for Cloud Foundry auto-tunnel.
4. Choose the narrowest command that answers the question.
5. Prefer JSON output for agent workflows. Use `--no-json` only when the user asks for human-readable output.

## Command Choice

Use `snapshot` for one-shot evidence at a line. It sets one or more breakpoints, waits for the first matching pause, captures expressions/scopes/stack, resumes unless `--keep-paused` is set, prints JSON, then exits.

```bash
cf-inspector snapshot --port 9229 \
  --bp src/handler.ts:42 \
  --capture 'req.url, this.user' \
  --timeout 30
```

Use `watch` when every hit matters. It pauses briefly per hit, captures expressions, resumes, streams JSON Lines on stdout, and writes a summary trailer to stderr.

```bash
cf-inspector watch --port 9229 \
  --bp src/handler.ts:42 \
  --capture 'user.id, payload' \
  --condition 'user.id !== "system"' \
  --duration 30 \
  --max-events 50
```

Use `log` for low-impact observation. It creates a non-pausing logpoint by embedding a conditional breakpoint expression that writes tagged `console.log` output through CDP. It streams JSON Lines and does not intentionally pause the inspectee.

```bash
cf-inspector log --port 9229 \
  --at src/handler.ts:42 \
  --expr 'JSON.stringify({ user: req.user, body: req.body })' \
  --duration 30
```

Use `exception` to catch thrown errors. It pauses on `uncaught`, `caught`, or `all`, captures the exception value and frame data, then resumes unless `--keep-paused` is set.

```bash
cf-inspector exception --port 9229 \
  --type uncaught \
  --capture 'this' \
  --stack-depth 4 \
  --stack-captures 'arguments[0]' \
  --timeout 30
```

Use `eval` for global runtime state, not paused-frame locals.

```bash
cf-inspector eval --port 9229 --expr 'process.uptime()'
```

Use `list-scripts` when breakpoints do not bind or path mapping is uncertain.

```bash
cf-inspector list-scripts --port 9229
```

Use `attach` as a connectivity smoke test for an inspector port or CF tunnel.

```bash
cf-inspector attach --port 9229
```

## Targeting

For a local process, start Node with an inspector:

```bash
node --inspect=9229 app.js
cf-inspector attach --port 9229
```

For Cloud Foundry, provide the complete target and let `cf-inspector` open and dispose the tunnel through `@saptools/cf-debugger`:

```bash
cf-inspector snapshot \
  --region eu10 --org my-org --space dev --app my-srv \
  --bp src/handler.ts:42 \
  --capture 'req.url, this.user'
```

Do not run live CF commands unless the user requested it and required credentials such as `SAP_EMAIL` and `SAP_PASSWORD` are present. Never echo or persist credential values.

## Breakpoints And Mapping

Write breakpoint locations as `file:line`, for example `src/handler.ts:42`. Pass repeated `--bp` values to race several locations; the first matching pause wins for `snapshot`.

Use `--remote-root` when local source paths need anchoring to remote V8 script URLs:

```bash
--remote-root /home/vcap/app
--remote-root 'regex:^/(home/vcap/app|example-root-.*)$'
--remote-root '/^\/home\/vcap\/app$/i'
```

The path mapper folds TypeScript and JavaScript runtime extensions, so a local `src/foo.ts` can match inspector URLs ending in `.ts`, `.js`, `.mts`, `.mjs`, `.cts`, or `.cjs`.

When a breakpoint does not bind:

1. Run `cf-inspector list-scripts` against the same target.
2. Compare script URLs to the local `--bp` path.
3. Add or adjust `--remote-root`.
4. Retry with a short `--timeout`.

## Captures

Pass comma-separated expressions with `--capture` or `--stack-captures`. The parser preserves commas inside objects, arrays, calls, and quoted strings.

```bash
--capture 'user.id, JSON.stringify({ id: user.id, roles: user.roles })'
```

Use `--include-scopes` only when local scope expansion is needed. Scope capture can be large and may expose secrets.

Use `--max-value-length <chars>` when values can be large. Default capture output is bounded, but captured object JSON can still contain sensitive data.

Use `--stack-depth <n>` and `--stack-captures <expr,...>` for call stack questions. Stack depth is clamped by implementation.

## Conditions And Hit Counts

Use `--condition <expr>` to gate `snapshot`, `watch`, or `log`. The expression runs in the paused frame or inspectee context. Invalid syntax should fail fast with `INVALID_EXPRESSION`.

Use `--hit-count <n>` to skip early hits. It composes with `--condition` through logical AND.

```bash
cf-inspector snapshot --port 9229 \
  --bp src/handler.ts:42 \
  --condition 'req.userId === "abc"' \
  --hit-count 5 \
  --capture 'req.body'
```

## Output Handling

Default command output is JSON except stream trailers:

- `snapshot`, `exception`, `eval`, `list-scripts`, and `attach` print formatted JSON to stdout.
- `log` and `watch` print one compact JSON object per event to stdout.
- `log` and `watch` write a JSON summary trailer to stderr in JSON mode, such as `{"stopped":"max-events","emitted":3}`.
- `eval` exits non-zero when JSON output contains `exceptionDetails`.

For agent parsing, read stdout events line by line and parse the final stderr JSON trailer separately.

## Error Codes

Common `CfInspectorError.code` values:

- `MISSING_TARGET`: neither `--port` nor complete CF target was provided.
- `INVALID_ARGUMENT`: numeric flags are not positive integers.
- `INVALID_BREAKPOINT`: location is not `file:line`.
- `INVALID_REMOTE_ROOT`: remote-root regex failed to compile.
- `INVALID_EXPRESSION`: expression or condition did not compile.
- `INVALID_HIT_COUNT`: hit count is not a positive integer in API paths.
- `INVALID_PAUSE_TYPE`: `exception --type` is not `uncaught`, `caught`, or `all`.
- `INSPECTOR_DISCOVERY_FAILED`: `/json/list` did not expose a target.
- `INSPECTOR_CONNECTION_FAILED`: WebSocket handshake or transport failed.
- `CDP_REQUEST_FAILED`: CDP method failed.
- `BREAKPOINT_NOT_HIT`: timeout while waiting for a matching pause.
- `UNRELATED_PAUSE`: target paused elsewhere and strict mode was enabled.
- `UNRELATED_PAUSE_TIMEOUT`: target stayed paused elsewhere until timeout.

## Programmatic API

Import from `@saptools/cf-inspector` for typed usage:

```ts
import {
  captureSnapshot,
  connectInspector,
  evaluateOnFrame,
  resume,
  setBreakpoint,
  waitForPause,
} from "@saptools/cf-inspector";

const session = await connectInspector({ port: 9229 });
const bp = await setBreakpoint(session, { file: "src/handler.ts", line: 42 });
const pause = await waitForPause(session, {
  timeoutMs: 30_000,
  breakpointIds: [bp.breakpointId],
});
const snapshot = await captureSnapshot(session, pause, {
  captures: ["this.user"],
  maxValueLength: 4096,
});
const topFrame = pause.callFrames[0];
if (topFrame !== undefined) {
  await evaluateOnFrame(session, topFrame.callFrameId, "this.user");
}
await resume(session);
await session.dispose();
```

Use `evaluateGlobal` for runtime-global expressions, `listScripts` for loaded script URLs, `streamLogpoint` for non-pausing streams, `setPauseOnExceptions` plus `captureException` for exception workflows, and `openCfTunnel` when composing CF tunnel setup manually.

## Package Map

Read these files before modifying behavior:

- `packages/cf-inspector/README.md`: user-facing CLI/API contract.
- `packages/cf-inspector/src/cli/program.ts`: command registration and flags.
- `packages/cf-inspector/src/cli/commands/*.ts`: per-command parsing and orchestration.
- `packages/cf-inspector/src/cli/target.ts`: target resolution and CF tunnel lifecycle.
- `packages/cf-inspector/src/pathMapper.ts`: breakpoint specs and URL regex mapping.
- `packages/cf-inspector/src/inspector/*.ts`: CDP session, runtime, breakpoint, pause, and discovery primitives.
- `packages/cf-inspector/src/snapshot/*.ts`: capture, object materialization, scopes, stack, values, and exceptions.
- `packages/cf-inspector/src/logpoint/*.ts`: non-pausing logpoint condition and event stream handling.
- `packages/cf-inspector/tests/unit/*.test.ts`: parser, CDP, path, snapshot, exception, and output coverage.
- `packages/cf-inspector/tests/e2e/*.e2e.ts`: real local Node inspector behavior against fixture apps.
