---
name: cf-events
description: Use when inspecting SAP BTP CF app audit events, SSH/debug activity, crashes, health, or live polling with cf-events.
---

# CF Events

## Purpose

Use `cf-events` to inspect Cloud Foundry app audit events, SSH/debug activity, crash history, app health, and event polling for SAP BTP Cloud Foundry apps. Prefer it when the task needs "what happened to this app", "who recently opened SSH/debug", "why did it crash", or "what is the current app health".

If `cf-events` is missing, install it from `@saptools/cf-events`: `npm install -g @saptools/cf-events`.

## First Steps

1. Identify whether the user needs audit history, SSH/debug activity, crash summary, app health, or live event watch.
2. App name (as selector) is always required. Full `region/org/space/app` is optional. If the user only mentions the app name, try short form first. It will use the current CF target if set. Only ask the user for the full selector when no target is configured or the app is ambiguous.
3. The selector resolution uses the current CF target for bare app names. A CF login/target must be active for bare names.
4. Use live CF access only when current evidence is needed and credentials are available through `SAP_EMAIL` and `SAP_PASSWORD` or secure explicit input.
5. Prefer `--json` for structured parsing; use text output when a human-facing summary is more useful.

## Command Choice

Use `events` for recent audit history. Narrow noisy output with `--since`, `--limit`, and `--type`:

```bash
cf-events events ap10/example-org/dev/app-demo --since 6h --limit 100 --json
cf-events events app-demo --type ssh --json
```

Use `ssh-status` to check SSH enablement and recent SSH/debug activity:

```bash
cf-events ssh-status ap10/example-org/dev/app-demo --since 24h --json
```

Use `crashes` for crash counts, latest crash time, reason, instance index, and exit status:

```bash
cf-events crashes app-demo --since 24h --json
```

Use `status` for requested state, web instance stats, SSH flag, and latest audit event:

```bash
cf-events status app-demo --json
```

Use `watch` only when the task needs live audit-event polling. Bound it operationally and stop it when enough evidence is collected:

```bash
cf-events watch app-demo --lookback 2m --interval 15000 --type crash --json
```

## Filters And Windows

- Durations accept positive `s`, `m`, `h`, or `d` values such as `30m`, `6h`, or `7d`.
- `--type ssh` expands to SSH authorized and denied events.
- `--type crash` expands to app and process crash events.
- Full CF event types such as `audit.app.start` are accepted.
- `events` and `crashes` default to `--limit 50`.
- `ssh-status` defaults to `--since 24h`.
- `watch` defaults to `--lookback 2m` and `--interval 15000`; the minimum interval is 2000 ms.

## Selectors And Setup

The selector can be a full `region/org/space/app` or just the bare app name:

```bash
cf-events status ap10/example-org/dev/app-demo --json
cf-events status app-demo --json
```

Bare app names will automatically use the current CF target if one is active. If the name is ambiguous or no target is set, provide the full path instead.

Bare names require an active `cf target` (and credentials for live CF calls).

## SSH And Debug Interpretation

Treat `ssh-status` as audit evidence, not a live session API. Cloud Foundry does not expose active SSH sessions and does not emit close events. `cf-events` marks a session `likelyActive` only when a recent `audit.app.ssh-authorized` event falls inside its heuristic window. Denied attempts are reported separately from `audit.app.ssh-unauthorized`.

## Data Handling

Audit events can expose user identities, app names, org/space names, route metadata, crash details, and operational timing. Do not print credentials. Do not paste sensitive event payloads into final answers unless the user explicitly asks; summarize and cite relevant timestamps, event types, actors, and selectors.

## Troubleshooting

If credentials are missing, use `SAP_EMAIL` and `SAP_PASSWORD` or ask for secure explicit input. If CF access fails, verify the region, org, space, app, and current CF permissions. If `watch` appears quiet, increase `--lookback`, lower the type filter, or first run `events --since <duration> --json` to confirm recent audit events exist.
