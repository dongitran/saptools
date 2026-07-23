---
name: cf-inspector
description: Use when a task involves debugging a Node.js app on SAP BTP Cloud Foundry through remote inspector access, including setting breakpoints or logpoints, capturing variables/scopes/stacks, watching exceptions, evaluating runtime state, listing loaded scripts, opening CF tunnels, or troubleshooting breakpoint path mapping with the cf-inspector CLI.
---

# CF Inspector

## Purpose

Use the `cf-inspector` CLI to drive a Node.js V8 inspector over the Chrome DevTools Protocol without an IDE. Prefer it when a task needs runtime evidence from a SAP BTP Cloud Foundry Node.js app, such as breakpoint hits, variable values, scopes, stack frames, exceptions, or loaded script paths.

If `cf-inspector` is missing, install it from `@saptools/cf-inspector`: `npm install -g @saptools/cf-inspector`.

Treat captured runtime values as sensitive. Snapshots, scopes, logpoints, exception values, and app environment data can contain tokens, user data, credentials, or business payloads. Redact before sharing outside the local task.

Only one local `cf-inspector` process may actively debug the same target. Every
command that opens a debugger session (`snapshot`, `watch`, `exception`, `log`,
`check-breakpoint`, `eval`, and `list-scripts`) acquires a target-scoped lock
before connecting. If `TARGET_ALREADY_DEBUGGED` is returned, do not retry in
parallel or bypass the guard: wait for the reported owner PID to finish. A dead
owner's stale lock is reclaimed automatically. `attach` and `list-targets` are
safe discovery operations and do not acquire this lock. Debuggers on another
machine or outside `cf-inspector` remain the operator's responsibility because
a local lock cannot detect them.

## First Steps

1. Identify whether the user wants a one-shot snapshot, continuous breakpoint watch, logpoint stream, exception capture, runtime evaluation, script listing, or connectivity check.
2. Choose exactly one target mode:
   - Option A: use all of `--region --org --space --app`. `cf-inspector` never inherits ambient `cf target` values and opens/closes the tunnel internally.
   - Option B: use `--port <number>` and optional `--host <host>` when a local inspector or Cloud Foundry tunnel is already running. For a Cloud Foundry tunnel, open it with `cf-debugger` first by reading and following the `cf-debugger` skill.
3. Use live inspector access when the task needs current runtime evidence and the target plus credentials are available. Ask only when the target, credentials, or side effects of pausing the app are unclear.
4. Choose the narrowest command that answers the question.
5. Prefer JSON output for agent workflows. Use `--no-json` only when the user asks for human-readable output.

## Command Choice

Use `snapshot` for one-shot evidence at a line. It sets one or more breakpoints, waits for the first matching pause, captures expressions/scopes/stack, resumes unless `--keep-paused` is set, prints JSON, then exits.

With no isolate selector, snapshot/watch/exception/log automatically attach to
the main isolate and all current or newly-spawned NodeWorkers. Do not iterate
worker indexes. Read the `isolate` field in results to learn which worker ran
the code. Use `--worker-id <id>` to pin one live worker, `--main-only` to ignore
workers, or the legacy `--worker <index>` only when positional selection is
specifically required.

```bash
cf-inspector snapshot --port 9229 \
  --bp dist/handler.js:42 \
  --capture 'req.url, this.user' \
  --timeout 30
```

Use `watch` when every hit matters. It pauses briefly per hit, captures expressions, resumes, streams JSON Lines on stdout, and writes a summary trailer to stderr.

```bash
cf-inspector watch --port 9229 \
  --bp dist/handler.js:42 \
  --capture 'user.id, payload' \
  --condition 'user.id !== "system"' \
  --duration 30 \
  --max-events 50
```

Use `log` for low-impact observation. It creates a non-pausing logpoint by embedding a conditional breakpoint expression that writes tagged `console.log` output through CDP. It streams JSON Lines and does not intentionally pause the inspectee.

```bash
cf-inspector log --port 9229 \
  --at dist/handler.js:42 \
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

Use `list-scripts` when breakpoints do not bind or path mapping is uncertain. `--filter` accepts literal text, `|` alternatives, and `.*` / `.+` wildcards.

```bash
cf-inspector list-scripts --port 9229 --filter '/home/vcap/app|ValidatePayloadWorker'
```

Use `list-targets` to inspect raw targets and stable worker IDs. Ordinary breakpoint workflows do not need a worker selector.

```bash
cf-inspector list-targets --port 9229
cf-inspector snapshot --port 9229 --bp dist/worker.js:42
cf-inspector snapshot --port 9229 --worker-id 3 --bp dist/worker.js:42
```

Use `attach` as a connectivity smoke test for an inspector port or CF tunnel.

```bash
cf-inspector attach --port 9229
```

## Targeting

`cf-inspector` has two targeting modes. Choose exactly one.

### Mode 1: Cloud Foundry app auto-tunnel

Use this mode when the user gives a complete region/org/space/app selector. `cf-inspector` starts the tunnel through `@saptools/cf-debugger`, runs the inspector command, and disposes the tunnel on exit. Do not run `cf-debugger start` first.

```bash
cf-inspector snapshot \
  --region eu10 --org example-org --space space-demo --app app-demo \
  --bp dist/handler.js:42 \
  --capture 'req.url, this.user'
```

### Mode 2: Existing inspector port

Use this mode only when a Cloud Foundry tunnel is already listening locally. Open the tunnel with `cf-debugger` first by reading and following the `cf-debugger` skill. After the tunnel is ready, attach `cf-inspector` to the local port:

```bash
cf-inspector snapshot --port 9229 \
  --bp dist/handler.js:42 \
  --capture 'req.url, this.user'
```

Run live CF tunnel/debug commands directly when the task needs current runtime evidence and required credentials such as `SAP_EMAIL` and `SAP_PASSWORD` are already available. Never echo or persist credential values.

## Breakpoints And Mapping

Write breakpoint locations as `file:line`, for example `dist/handler.js:42`. Rule for SAP CAP: do not set breakpoints on `.ts` source files unless the loaded scripts prove sourcemaps expose those `.ts` URLs; target the compiled `.js` path shown by `list-scripts` instead. Pass repeated `--bp` values to race several locations; the first matching pause wins for `snapshot`.

Use `--remote-root` when local source paths need anchoring to remote V8 script URLs:

```bash
--remote-root /home/vcap/app
--remote-root 'regex:^/(home/vcap/app|example-root-.*)$'
--remote-root '/^\/home\/vcap\/app$/i'
```

The path mapper folds TypeScript and JavaScript runtime extensions, so a local `dist/foo.js` can match inspector URLs ending in `.js`, `.mjs`, or other loaded runtime extensions.

When a breakpoint does not bind:

1. Run `cf-inspector list-scripts` against the same target.
2. Compare script URLs to the local `--bp` path.
3. Add or adjust `--remote-root`.
4. Retry with a short `--timeout`.

Before retrying, use `check-breakpoint` with the same file and
`--remote-root`. `script-not-loaded` means the file/path mapping does not match
any loaded script; `unbreakable` means the file is loaded but the exact line is
not executable; `breakable` reports concrete locations across attached isolates.

```bash
cf-inspector check-breakpoint --port 9229 --bp dist/handler.js:42
```

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
  --bp dist/handler.js:42 \
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

- `MISSING_TARGET`: neither `--port` nor a complete `--region/--org/--space/--app` target was provided.
- `INVALID_ARGUMENT`: numeric flags are not positive integers.
- `INVALID_BREAKPOINT`: location is not `file:line`.
- `INVALID_REMOTE_ROOT`: remote-root regex failed to compile.
- `INVALID_EXPRESSION`: expression or condition did not compile.
- `INVALID_HIT_COUNT`: hit count is not a positive integer in API paths.
- `INVALID_PAUSE_TYPE`: `exception --type` is not `uncaught`, `caught`, or `all`.
- `INSPECTOR_DISCOVERY_FAILED`: `/json/list` did not expose a target.
- `INSPECTOR_CONNECTION_FAILED`: WebSocket handshake or transport failed.
- `TARGET_ALREADY_DEBUGGED`: another live local `cf-inspector` process owns the target; wait for it to finish.
- `CDP_REQUEST_FAILED`: CDP method failed.
- `BREAKPOINT_NOT_HIT`: timeout while waiting for a matching pause.
- `UNRELATED_PAUSE`: target paused elsewhere and strict mode was enabled.
- `UNRELATED_PAUSE_TIMEOUT`: target stayed paused elsewhere until timeout.
