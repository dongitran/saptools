---
name: cf-live-trace
description: Use when capturing live HTTP request and response traces from SAP BTP Cloud Foundry Node.js apps, including Node inspector tunnel setup, bounded event streams, body/header capture controls, and runtime hook cleanup.
---

# CF Live Trace

## Purpose

Use `cf-live-trace` to inspect live HTTP traffic from a running SAP BTP Cloud Foundry Node.js app. Prefer it when the user needs current request/response evidence such as methods, URLs, status codes, durations, byte counts, correlation IDs, headers, or bounded body previews.

If `cf-live-trace` is missing, install it from `@saptools/cf-live-trace`: `npm install -g @saptools/cf-live-trace`.

Use it only for apps and spaces the user is authorized to inspect. The CLI can enable SSH, restart the app if SSH is disabled, start the Node inspector, open an SSH tunnel, and inject a runtime hook into the running Node process.

## First Steps

1. Identify the target app, instance index, and whether the current `cf target` is the intended region, org, and space.
2. Use `--app <name>` for every run. Pass `--region` or `--api-endpoint`, `--org`, and `--space` explicitly when the current `cf target` is missing, stale, or not the intended target.
3. Prefer `SAP_EMAIL` and `SAP_PASSWORD` for credentials. Avoid `--email` and `--password` unless necessary because process arguments can expose credentials.
4. Bound agent runs with `--duration <seconds>` or `--max-events <count>` so the trace does not stream indefinitely.
5. Reduce captured data with `--no-capture-headers`, `--no-capture-request-body`, `--no-capture-response-body`, or a smaller `--max-body-bytes` when the app handles sensitive payloads.

## Command Choice

Trace an app using the current `cf target`:

```bash
cf-live-trace --app orders-api --duration 30 --format ndjson
```

- `--app <name>`: app to trace.
- `--region <key>`: CF region; defaults to the current `cf target`.
- `--api-endpoint <url>`: alternative to `--region` for a custom or unknown region.
- `--org <name>` and `--space <name>`: CF target; default to the current `cf target`.
- `--instance <index>`: app instance, default `0`.
- `--duration <seconds>`: stop after the specified time.
- `--max-events <count>`: stop after the specified number of events.
- `--format ndjson|summary|json`: output format, default `ndjson`.

Capture a compact text stream without request or response bodies:

```bash
cf-live-trace \
  --app orders-api \
  --no-capture-request-body \
  --no-capture-response-body \
  --max-events 10 \
  --format summary
```

- `--app orders-api`: app to trace.
- `--no-capture-request-body`: do not capture request bodies.
- `--no-capture-response-body`: do not capture response bodies.
- `--max-events 10`: stop after 10 events.
- `--format summary`: print a compact human-readable stream.

Use `--cf-home <dir>` only when the run must reuse or isolate a specific Cloud Foundry CLI home:

```bash
cf-live-trace --app orders-api --cf-home /tmp/cf-live-trace-home --duration 30
```

## Runtime Behavior

The CLI prepares a CF session with `cf api`, `cf auth`, and `cf target`. It checks `cf ssh-enabled`; when SSH is disabled, it runs `cf enable-ssh`, restarts the app, and smoke-checks SSH before continuing.

After SSH is ready, the CLI sends `SIGUSR1` to the best Node.js process candidate, opens a tunnel to `127.0.0.1:9229`, connects through the Node inspector, and evaluates a runtime hook named `__SAPTOOLS_CF_LIVE_TRACE__`. The hook patches Node `http` and `https` server prototypes, queues events in process memory, and drains them back to the CLI.

Cleanup normally uninstalls the runtime hook and closes the tunnel. With `--no-uninstall-on-exit`, cleanup disables the hook instead of uninstalling it. If cleanup fails, the hook can remain disabled or installed until the app process restarts.

## Output Handling

Use `--format ndjson` for streaming agent workflows. Each captured request is printed as one JSON object on stdout.

Use `--format summary` for a human-readable stream containing timestamp, method, normalized URL, status, and duration.

Use `--format json` when downstream code needs one final JSON object after the run stops. Combine it with `--duration` or `--max-events`.

Progress and lifecycle messages are written to stderr unless `--quiet` is set. Do not treat stderr progress lines as trace events.

Trace events can include:

- `sessionId`
- `requestId`
- `method`
- `normalizedUrl`
- `status`
- `durationMs`
- `requestBodyFormat`
- `responseBodyFormat`
- `requestBodyPreview`
- `responseBodyPreview`
- `requestBytes`
- `responseBytes`
- `traceId`
- `correlationId`

## Saved Sessions

Each request is backed up for two hours under `~/.saptools/cf-live-trace/sessions/<sessionId>/events/`. Use:

```bash
cf-live-trace session list
cf-live-trace session events <sessionId> --limit 20
cf-live-trace session search <sessionId> "orderId" --body response
cf-live-trace session body <sessionId> <requestId> --body response --path /data --limit 4000 --rows 100
```

- `<sessionId>`: ID shown when tracing starts or returned by `session list`.
- `<requestId>`: ID returned by `session events`.
- `"orderId"`: text to find in saved request or response bodies.
- `--limit 20` on `session events`: maximum events to return.
- `--body response`: search response bodies by default; use `both` for both sides or `request` for request bodies.
- `--path /data`: JSON Pointer selecting a field or object inside the saved body.
- `--limit 4000` on `session body`: maximum characters shown for each value.
- `--rows 100`: maximum structure rows to return.

## Data Handling

Compact stdout omits app ID and headers, redacts common credential query values, and limits each body preview to 128 characters. Backup files retain the fuller captured event and can contain credentials or personal data, so summarize findings instead of pasting raw values unless requested.

Set `--max-body-bytes <n>` to bound each captured request and response body. The default is `4096`, and the value must be greater than `0`.

## Troubleshooting

- `No current CF target found`: run `cf target -o <org> -s <space>` first or pass `--region`/`--api-endpoint`, `--org`, and `--space`.
- `Missing required environment variable: SAP_EMAIL` or `SAP_PASSWORD`: export the credential variables or pass explicit flags only when acceptable.
- `Unknown CF region`: use `--api-endpoint <url>` instead of `--region`.
- The command restarts the app: SSH was disabled. This is expected behavior for this CLI; confirm the user accepts that side effect before retrying in production.
- `Node Inspector is not reachable on 127.0.0.1:9229`: verify the app is a Node.js app, the selected instance is running, SSH works, and the process can start the inspector after `SIGUSR1`.
- Output is too large: add `--duration`, `--max-events`, a smaller `--max-body-bytes`, or disable header/body capture.
- Trace misses expected traffic: generate the request after the stderr progress line shows `streaming`, verify the selected `--instance`, and confirm the traffic reaches the same app process.
