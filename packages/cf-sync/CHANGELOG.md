# Changelog

## 0.4.8 - 2026-05-12

- Fixed region-limited `cf-sync sync --only <region>` so refreshed regions are merged into the existing topology snapshot instead of replacing unrelated cached regions.
- Added `cf-sync org <region> <org>` and `syncOrg()` for targeted org refreshes that preserve sibling topology.
- Added unit and fake-backed E2E coverage for targeted region and org sync behavior.
