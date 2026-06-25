---
name: cf-logs
description: Use when a task involves fetching, streaming, parsing, compacting, saving, or inspecting SAP BTP Cloud Foundry application logs with the cf-logs CLI, including AI-oriented compact output, compact refs, full-row drill-down, local session cleanup, and bounded local log stores.
---

# CF Logs

## Purpose

Use the `cf-logs` CLI to fetch recent Cloud Foundry logs, stream live app logs, parse local log files, emit compact AI-oriented rows, and retrieve full saved rows through compact refs.

If `cf-logs` is missing or stale, install it from `@saptools/cf-logs`: `npm install -g @saptools/cf-logs@latest`.

## First Steps

1. Identify whether the user needs a snapshot, live stream, local parse, compact AI context, full-row drill-down, store inspection, or session cleanup.
2. Confirm the target: `--region` or `--api-endpoint`, plus `--org`, `--space`, and usually `--app`.
3. Use live CF access only when current log evidence is needed and credentials are already available through `SAP_EMAIL` and `SAP_PASSWORD` or explicit secure input.
4. Prefer `--compact --save` when the user wants concise context plus a way to inspect full log rows later.
5. Prefer `--json` for agent parsing and plain text for quick human terminal inspection.

## Compact Workflow

Use compact output for AI-model context or long log streams. Compact rows keep high-signal fields such as time, level, source, logger, request, status, latency, tenant, client IP, request ID, message, and optional `ref`.

Compact output:

- caps message/body text at 500 characters by default
- normalizes multiline messages into one terminal line
- omits full `rawBody`, `jsonPayload`, `searchableText`, and raw snapshot text
- does not redact content

Create refs for later full-row drill-down:

```bash
cf-logs snapshot --region ap10 --org example-org --space space-demo --app app-demo --compact --save
```

Get structured refs:

```bash
cf-logs snapshot --region ap10 --org example-org --space space-demo --app app-demo --compact --save --json
```

Then inspect one full row:

```bash
cf-logs show <session-id>:<row-id>
cf-logs show <session-id>:<row-id> --json
```

Tune compact size:

```bash
cf-logs snapshot --region ap10 --org example-org --space space-demo --app app-demo \
  --compact --compact-message-limit 300
```

## Command Choice

Use `snapshot` for recent logs:

```bash
cf-logs snapshot --region ap10 --org example-org --space space-demo --app app-demo --json
```

Use `stream` for live logs. Add `--max-lines` when running from an agent to avoid unbounded output:

```bash
cf-logs stream --region ap10 --org example-org --space space-demo --app app-demo \
  --compact --save --max-lines 50
```

Use `parse` for a local log file or stdin:

```bash
cf-logs parse --input ./app.log --compact
cat ./app.log | cf-logs parse --compact --json
```

Use `apps` to list started apps with running instances:

```bash
cf-logs apps --region ap10 --org example-org --space space-demo --json
```

Use `store` for the persistent bounded store used by non-compact `--save`:

```bash
cf-logs store path
cf-logs store list --json
cf-logs store clear
```

Use `session` for temporary compact drill-down sessions:

```bash
cf-logs session list
cf-logs session prune
cf-logs session clear
```

## Data Handling

Treat all log output, refs, store files, and session files as sensitive. The package does not redact log content. A compact row is smaller, not safer.

Local files:

- persistent non-compact store: `~/.saptools/cf-logs-store.json`
- temporary compact sessions: `~/.saptools/cf-logs-sessions/`

Compact sessions expire after 60 minutes by default. Change this only when the user explicitly needs a longer or shorter drill-down window:

```bash
cf-logs snapshot --region ap10 --org example-org --space space-demo --app app-demo \
  --compact --save --compact-ttl-minutes 15
```

Do not paste raw sensitive log rows into final answers unless the user explicitly asks. Summarize findings and reference refs when possible.

## Troubleshooting

If `show <ref>` fails, check whether the session expired or was cleared:

```bash
cf-logs session list
```

If compact output is still too large, reduce `--compact-message-limit`, lower `--log-limit`, or use `--max-lines` for streams.

If live CF commands fail, verify the region, org, space, app, and credential environment. Do not print credential values.

If a task needs exact original multiline body text, use `cf-logs show <ref>` rather than relying on compact output.
