---
name: cf-inspector
description: Use when a task involves debugging a Node.js app on SAP BTP Cloud Foundry through remote inspector access, including setting breakpoints or logpoints, capturing variables/scopes/stacks, watching exceptions, evaluating runtime state, listing loaded scripts, opening CF tunnels, or troubleshooting breakpoint path mapping with the cf-inspector CLI.
---

# CF Inspector

## Purpose

Use the `cf-inspector` CLI to drive a Node.js V8 inspector over the Chrome DevTools Protocol without an IDE. Prefer it when a task needs runtime evidence from a SAP BTP Cloud Foundry Node.js app, such as breakpoint hits, variable values, scopes, stack frames, exceptions, or loaded script paths.

If `cf-inspector` is missing, install it from `@saptools/cf-inspector`: `npm install -g @saptools/cf-inspector`.

Treat captured runtime values as sensitive. Snapshots, scopes, logpoints, exception values, and app environment data can contain tokens, user data, credentials, or business payloads. Redact before sharing outside the local task.

## First Steps

1. Identify whether the user wants a one-shot snapshot, continuous breakpoint watch, logpoint stream, exception capture, runtime evaluation, script listing, or connectivity check.
2. Choose exactly one target option:
   - Option A: use `--app <name>` when the app is in the current `cf target`. `cf-inspector` opens and closes the tunnel internally through `@saptools/cf-debugger`; do not run `cf-debugger` first for this option.
   - Option B: use `--region --org --space --app` when the app is not in the current `cf target`.
   - Option C: use `--port <number>` and optional `--host <host>` only when a local inspector or Cloud Foundry tunnel is already running. For a Cloud Foundry tunnel, open it with `cf-debugger` first by reading and following the `cf-debugger` skill.
3. Use live inspector access when the task needs current runtime evidence and the target plus credentials are available. Ask only when the target, credentials, or side effects of pausing the app are unclear.
4. Choose the narrowest command that answers the question.
5. Prefer JSON output for agent workflows. Use `--no-json` only when the user asks for human-readable output.

## Command Choice

Use `snapshot` for one-shot evidence at a line. It sets one or more breakpoints, waits for the first matching pause, captures expressions/scopes/stack, resumes unless `--keep-paused` is set, prints JSON, then exits.

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

Use `list-scripts` when breakpoints do not bind or path mapping is uncertain.

```bash
cf-inspector list-scripts --port 9229 --filter '/home/vcap/app|ValidatePayloadWorker'
```

Use `list-targets` and then pass `--target <index>` when worker threads appear as separate inspector targets.

```bash
cf-inspector list-targets --port 9229
cf-inspector snapshot --port 9229 --target 1 --bp dist/worker.js:42
```

Use `attach` as a connectivity smoke test for an inspector port or CF tunnel.

```bash
cf-inspector attach --port 9229
```

## Targeting

`cf-inspector` has two targeting modes. Choose exactly one.

### Mode 1: Cloud Foundry app auto-tunnel

Use this mode when the user gives an app name. `cf-inspector` reads the current `cf target` for region/org/space, starts the tunnel through `@saptools/cf-debugger`, runs the inspector command, and disposes the tunnel on exit. Do not run `cf-debugger start` first.

```bash
cf-inspector snapshot \
  --app app-demo \
  --bp dist/handler.js:42 \
  --capture 'req.url, this.user'
```

Pass the full selector when the app is outside the current `cf target`:

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

- `MISSING_TARGET`: neither `--port`, `--app` with a current CF target, nor a complete CF target was provided.
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
