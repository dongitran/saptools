---
name: cf-sync
description: Use when a task involves syncing, reading, refreshing, or troubleshooting SAP BTP Cloud Foundry topology and HANA binding snapshots with the cf-sync CLI or @saptools/cf-sync package, including cached region/org/space/app discovery, targeted refreshes, DB binding selector resolution, local ~/.saptools state, and packages that depend on cf-sync snapshots.
---

# CF Sync

## Purpose

Use `cf-sync` to maintain and read the local SAP BTP Cloud Foundry topology snapshot used by other saptools packages. It discovers regions, orgs, spaces, apps, app runtime metadata, and optional HANA service bindings.

If `cf-sync` is missing, install it from `@saptools/cf-sync`: `npm install -g @saptools/cf-sync`.

## First Steps

1. Identify whether the user needs cached topology, a fresh sync, one region/org/space refresh, DB binding data, or local state troubleshooting.
2. Prefer cache reads first when current live state is not required: `read`, `regions`, `region --no-refresh`, or `db-read`.
3. Use live CF access only when current state is needed and credentials are available through `SAP_EMAIL` and `SAP_PASSWORD` or secure explicit input.
4. When the user does not name a region, org, or space, use the current `cf target`. Ask for explicit target details only when the task must use a different target or no current target is configured.
5. Prefer a full selector when app names may collide or the requested target differs from current `cf target`: `region/org/space/app`.
6. Treat DB binding output and local DB snapshot files as secrets.

## Command Choice

Use `read` for the best available full topology view:

```bash
cf-sync read
```

Use `regions` to discover known region keys and endpoints:

```bash
cf-sync regions
```

Use `region` for one region. Add `--no-refresh` for cache-only reads:

```bash
cf-sync region ap10
cf-sync region
cf-sync region ap10 --no-refresh
```

Use `sync` for live topology collection. Use `--only` to refresh selected regions without removing other cached regions:

```bash
cf-sync sync --only ap10,eu10
cf-sync sync --verbose --no-interactive
```

Use targeted refreshes when only part of the topology is stale:

```bash
cf-sync orgs ap10
cf-sync org ap10 example-org
cf-sync space ap10 example-org space-demo
cf-sync space
```

Use `db-sync` to collect HANA bindings from `cf env`, then `db-read` to inspect the snapshot:

```bash
cf-sync db-sync
cf-sync db-sync app-demo
cf-sync db-sync ap10/example-org/space-demo/app-demo
cf-sync db-read
cf-sync db-read ap10/example-org/space-demo/app-demo
```

## Output And State

Topology output is JSON. Read commands return a view with `source`:

- `runtime`: active or recently completed runtime state.
- `stable`: last stable package-managed snapshot.
- `fresh`: one region fetched live on demand.
- `catalog`: built-in SAP region catalog for `regions`.

Important local files:

- `~/.saptools/cf-structure.json`: stable topology snapshot.
- `~/.saptools/cf-sync-state.json`: runtime topology sync state.
- `~/.saptools/cf-sync-history.jsonl`: topology sync milestones.
- `~/.saptools/cf-db-bindings.json`: HANA binding snapshot with credentials.
- `~/.saptools/cf-db-sync-state.json`: runtime DB sync state.
- `~/.saptools/cf-db-sync-history.jsonl`: DB sync milestones.

Do not paste credential values from DB binding output. Summarize binding presence, selector, status, schema name, or metadata only when needed.

## Selection Rules

Use a bare app name when the app belongs to the current `cf target`. If the task refers to another org/space or selector resolution is unclear, rerun with a full selector:

```bash
cf-sync db-read ap10/example-org/space-demo/app-demo
```

`db-sync <app>` and `db-read <app>` scope the app name to the current `cf target`. If there is no current CF target, run `cf target -o <org> -s <space>` first or pass a full `region/org/space/app` selector.

`db-sync region/org/space/app` can run without an existing topology snapshot because the region endpoint is known from the built-in catalog.

`db-sync` starts a detached worker from the CLI. Poll progress with:

```bash
cf-sync db-read
```

## Behavior Notes

`sync` walks `region -> org -> space -> app` and reads app state, instance counts, and routes from `cf apps`.

`sync --only <keys>` merges selected regions into the stable snapshot. A full `sync` replaces the stable topology with the completed full result.

`orgs`, `org`, and `space` use isolated CF sessions and targeted refresh locks. They preserve sibling topology that was not refreshed.

Read commands can inspect partial runtime state while a long sync is running. Concurrent full syncs reuse or wait on the active lock instead of walking the landscape twice.

## Troubleshooting

If cached reads return `null`, run a live sync:

```bash
cf-sync sync --only ap10
```

If a region is missing and credentials are available, `cf-sync region <key>` can fetch it on demand. Use `--no-refresh` when no live CF calls should be made.

If DB sync says to run topology sync first, either run `cf-sync sync` or use a full `region/org/space/app` selector.

If a command reports `No current CF target found`, run `cf target -o <org> -s <space>` or pass the explicit region/org/space/app target in the command.

If a sync appears stuck, inspect runtime state and history before deleting local files:

```bash
cf-sync read
cat ~/.saptools/cf-sync-history.jsonl
cf-sync db-read
cat ~/.saptools/cf-db-sync-history.jsonl
```

If live CF commands fail, verify the region key, org, space, app, local `cf` CLI availability, and credentials. Do not print `SAP_EMAIL`, `SAP_PASSWORD`, HANA passwords, certificates, or tokens.
