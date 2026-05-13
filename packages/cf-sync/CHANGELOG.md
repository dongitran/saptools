# Changelog

## 0.4.9 - 2026-05-13

- Added `cf-sync orgs <region>` and `syncRegionOrgs()` to refresh only a region's org list without walking spaces or apps.
- Preserved cached spaces/apps for still-present orgs while removing stale org entries only from the refreshed region.
- Added unit and fake-backed E2E coverage for region org-list refresh behavior.

## 0.4.8 - 2026-05-12

- Fixed region-limited `cf-sync sync --only <region>` so refreshed regions are merged into the existing topology snapshot instead of replacing unrelated cached regions.
- Added `cf-sync org <region> <org>` and `syncOrg()` for targeted org refreshes that preserve sibling topology.
- Added unit and fake-backed E2E coverage for targeted region and org sync behavior.
