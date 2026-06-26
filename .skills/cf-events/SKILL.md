---
name: cf-events
description: Use when a task involves inspecting SAP BTP Cloud Foundry application audit events, SSH or debug session activity, crash history, app health, or live audit-event polling with the cf-events CLI, including selector resolution through cf-sync, event type filters, duration windows, and SSH likely-active caveats.
---

# CF Events

## Purpose

Use `cf-events` to inspect Cloud Foundry app audit events, SSH/debug activity, crash history, app health, and event polling for SAP BTP Cloud Foundry apps. Prefer it when the task needs "what happened to this app", "who recently opened SSH/debug", "why did it crash", or "what is the current app health".

If `cf-events` is missing, install it from `@saptools/cf-events`: `npm install -g @saptools/cf-events`.

## First Steps

1. Identify whether the user needs audit history, SSH/debug activity, crash summary, app health, or live event watch.
2. Confirm the selector: use `region/org/space/app` when the target differs from current `cf target`; otherwise a bare app name uses the current CF region, org, and space.
3. Ensure `cf-sync` topology exists or is current enough for the resolved selector. If selector resolution fails, run `cf-sync sync` or targeted `cf-sync space <region> <org> <space>`.
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

`cf-events` scopes bare app names to the current `cf target`, then resolves the resulting selector through the local `cf-sync` topology snapshot:

```bash
cf-events status ap10/example-org/dev/app-demo --json
cf-events status app-demo --json
```

If a bare app name is ambiguous, rerun with the full `region/org/space/app` selector. If no topology snapshot exists or the app is missing, refresh with `cf-sync sync` or a targeted `cf-sync space <region> <org> <space>`.

If there is no current CF target, run `cf target -o <org> -s <space>` or pass the full selector explicitly.

## SSH And Debug Interpretation

Treat `ssh-status` as audit evidence, not a live session API. Cloud Foundry does not expose active SSH sessions and does not emit close events. `cf-events` marks a session `likelyActive` only when a recent `audit.app.ssh-authorized` event falls inside its heuristic window. Denied attempts are reported separately from `audit.app.ssh-unauthorized`.

## Data Handling

Audit events can expose user identities, app names, org/space names, route metadata, crash details, and operational timing. Do not print credentials. Do not paste sensitive event payloads into final answers unless the user explicitly asks; summarize and cite relevant timestamps, event types, actors, and selectors.

## Troubleshooting

If credentials are missing, use `SAP_EMAIL` and `SAP_PASSWORD` or ask for secure explicit input. If CF access fails, verify the region, org, space, app, and current CF permissions. If `watch` appears quiet, increase `--lookback`, lower the type filter, or first run `events --since <duration> --json` to confirm recent audit events exist.
