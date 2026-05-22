# Changelog

## 0.4.12 - 2026-05-22

- Fixed a lost-update race where two concurrent targeted refreshes (`cf-sync space`/`org`/`orgs`) could each collect against a stale topology snapshot and overwrite one another's freshly persisted subtree.
- Added a dedicated targeted-refresh lock so `syncSpace()`, `syncOrg()`, and `syncRegionOrgs()` serialize collect-and-persist end to end without blocking full syncs or topology reads.
- Added unit coverage proving concurrent targeted space refreshes are serialized.

## 0.4.11 - 2026-05-22

- Added `fetchAppDbBindings()` to fetch a single app's HANA service bindings on demand, without persisting anything under `~/.saptools/` (no snapshot, lock, or history writes).
- Extracted the ephemeral `CF_HOME` session helper into a shared `cf/session` module reused by both `runDbSync()` and `fetchAppDbBindings()`.
- Added unit coverage for non-persisting DB binding fetches.

## 0.4.9 - 2026-05-13

- Added `cf-sync orgs <region>` and `syncRegionOrgs()` to refresh only a region's org list without walking spaces or apps.
- Preserved cached spaces/apps for still-present orgs while removing stale org entries only from the refreshed region.
- Added unit and fake-backed E2E coverage for region org-list refresh behavior.

## 0.4.8 - 2026-05-12

- Fixed region-limited `cf-sync sync --only <region>` so refreshed regions are merged into the existing topology snapshot instead of replacing unrelated cached regions.
- Added `cf-sync org <region> <org>` and `syncOrg()` for targeted org refreshes that preserve sibling topology.
- Added unit and fake-backed E2E coverage for targeted region and org sync behavior.
