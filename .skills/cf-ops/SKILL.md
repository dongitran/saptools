---
name: cf-ops
description: Use when operating SAP BTP Cloud Foundry apps with the cf-ops CLI, including restart, rolling restart, restage, start, stop, scaling instances, scaling memory or disk, dry-run planning, validating planned CF commands, and troubleshooting mutating app lifecycle operations.
---

# CF Ops

## Purpose

Use `cf-ops` for explicit, mutating Cloud Foundry app operations: restart,
restage, start, stop, and scale. Prefer it when the user wants to change app
lifecycle state, instance count, memory, or disk while keeping mutating
operations separate from read-only diagnostic tools.

If `cf-ops` is missing, install it from `@saptools/cf-ops`:

```bash
npm install -g @saptools/cf-ops
```

## First Steps

1. Identify the exact operation: restart, restage, start, stop, scale, or
   dry-run command planning.
2. Confirm the app name. Every command requires `--app <name>`.
3. Confirm the active Cloud Foundry target before mutating anything:

```bash
cf target
cf app <app-name>
```

4. Use `--dry-run` first for production, uncertain targets, or any operation
   that changes scale or stops/restarts an app.
5. Do not pass SAP credentials to `cf-ops`. It uses the current official `cf`
   CLI authentication and target.

## Command Choice

Use `restart` to restart an app in the current target:

```bash
cf-ops restart --app orders-srv
cf-ops restart --app orders-srv --strategy rolling
cf-ops restart --app orders-srv --strategy rolling --dry-run
```

Use `restage` after buildpack, stack, dependency, or environment changes:

```bash
cf-ops restage --app orders-srv
cf-ops restage --app orders-srv --dry-run
```

Use `start` or `stop` for direct lifecycle changes:

```bash
cf-ops start --app orders-srv
cf-ops stop --app orders-srv --dry-run
```

Use `scale` for instances, memory, disk, or a combined scale operation:

```bash
cf-ops scale --app orders-srv --instances 3
cf-ops scale --app orders-srv --memory 1G
cf-ops scale --app orders-srv --disk 2G
cf-ops scale --app orders-srv --instances 4 --memory 1G --disk 2G
```

Use `--restart` when a scale operation should be followed by a restart. Use
`--strategy rolling` only with `restart` or with `scale --restart`:

```bash
cf-ops scale --app orders-srv --memory 1G --restart
cf-ops scale --app orders-srv --memory 1G --restart --strategy rolling --dry-run
```

## Targeting And Safety

`cf-ops` operates on the active `cf target`. It does not run `cf login`, change
org/space, create a private `CF_HOME`, or persist credentials.

Before running a non-dry-run operation:

1. Run `cf target` and verify the org/space.
2. Run `cf app <app-name>` when the app, route, or current state matters.
3. Prefer `--dry-run` and review the planned `cf` command array.
4. Avoid `stop` unless the user explicitly wants downtime.

Treat app names, orgs, spaces, routes, and command output as operationally
sensitive. Never print `SAP_EMAIL`, `SAP_PASSWORD`, CF tokens, or app
environment values.

## Troubleshooting

- `Error: --app is required.`: add `--app <name>`.
- `scale requires at least one of --instances, --memory, or --disk.`: pass at
  least one scale dimension.
- `memory must use a Cloud Foundry size...` or `disk must use...`: use values
  such as `512M`, `1024MB`, `1G`, or `2GB`.
- CF reports the app cannot be found: run `cf target`, `cf apps`, and
  `cf app <app-name>` to verify the active org/space and app name.
- A rolling restart fails: retry only after checking whether the platform and
  app support rolling deployment semantics; otherwise use the default strategy.
- A dry run looks wrong: do not run the real command. Fix the target, app name,
  or flags first.

Use `cf-sync` for topology discovery, `cf-events` for audit/crash history,
`cf-logs` or `cf-tail` for logs, and `cf-debugger` or `cf-inspector` for live
runtime debugging.
