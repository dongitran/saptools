# Changelog

All notable changes to `@saptools/cf-otel` are documented in this file.

## 0.3.0

- **`cf services` ran twice on every auto-discovered command, and now runs once.** It is the most
  expensive command in the credential path: the CF CLI implements it as one request per instance in
  the space, and a traced cold `count` on a real tenant spent 11.8s and 15.9s in its two calls, 27.7s
  of a 40.6s total. The redundancy was structural rather than accidental. Instance discovery filtered
  the listing to the `cloud-logging` offering, required exactly one row, and then returned only that
  row's *name*; the fallback-binding step later re-fetched the entire listing purely to read
  `boundApps` back off that same row. Discovery now returns the row it selected, and the fallback step
  uses the bound apps it already carries. Cloud Foundry enforces unique instance names within a
  space, so this is the same row the second listing would have found: the value is identical, not
  merely equivalent.
- Call counts per path, so nothing regressed for anyone: auto-discovery with no usable service key
  (the common case on a SAML-enabled instance) goes from two listings to **one**; auto-discovery where
  a service key works stays at one; a pinned `--service-instance` with unpinned fallback apps stays at
  one, since nothing has listed the services on that path; and pinning both `--service-instance` and
  `--fallback-binding-app` stays at **zero**. Measured from the other direction on the same tenant,
  a run with an explicit `--service-instance` (which already skipped the first listing) took 21.4s
  against 34.3s without it.
- An auto-discovered instance with **no** bound apps is still a real answer, not a cache miss: it
  reports "no apps are bound to instance X" as before rather than triggering a second listing.
- API change for library consumers: `discoverServiceInstance` now resolves to the `CfServiceRow` it
  selected instead of a bare instance name, since that row is what carries `boundApps`. `CfServiceRow`
  was already exported and was already the element type of `listCloudLoggingInstances`, so no new type
  is introduced. `findBoundApps` and `listCloudLoggingInstances` keep their signatures; `findBoundApps`
  is now only reached when the caller pinned `--service-instance`.
- Regression tests at both levels: unit tests pin the exact `cf services` call count for all four
  paths and for the empty-bound-apps case, and an e2e test asserts a single `services` entry in the
  fake `cf`'s call trace for a run that falls through to the binding path. Three of them fail against
  the previous release.

## 0.2.1

Three correctness fixes for CF CLI v8, whose output shapes differ from v7's in ways this package
never handled. All three were verified against the CF CLI v8.18.0 source and, where possible, against
a real tenant.

- **`--service-key` never worked, and `--allow-mint-credential` failed after disabling SAML.**
  `cf service-key` nests the credential fields under a `credentials` object on CLI v8, where v7
  printed them flat, and only the top level was read. Confirmed live: a real `cf service-key` on a
  current CLI returns exactly one top-level key, `credentials`. Both shapes are now accepted, with
  the top level preferred when it carries the fields, so the already-unwrapped VCAP payload keeps
  working. The minting path reads `cf service-key` directly, so the same bug made every freshly
  minted key look empty — after SAML had already been switched off on a shared instance, and with a
  message ("did not contain dashboards-username/dashboards-password") that pointed at SAML rather
  than at the parser.
- **`cf service-keys` was never parsed at all on v8.** v8 renders a three-column table (`name`,
  `last operation`, `message`) through `DisplayTableWithHeader`, and the parser required the header
  line to equal `name`, so it always returned no keys. Every run therefore reported "no service keys
  exist on instance X" for instances that have them, and fell through to the far slower per-app
  `cf env` scan (measured at 16s on a real tenant). Both header shapes are now read, and cells are
  sliced by column position rather than split on whitespace — `message` is routinely blank and
  `last operation` contains a space, so splitting took the wrong field. The column boundary is found
  by scanning for the next column in the header instead of matching the literal text `last
  operation`, so a renamed column cannot silently reintroduce whole-row key names.
- **A failed mint no longer leaves its service key behind.** `--allow-mint-credential` created
  `cf-otel-<hex>` and, on any later failure, discarded the name along with the error, leaving an
  unusable key on a shared instance and adding another on every retry. The key is now deleted
  (`cf delete-service-key … -f`; `-f` is required, or v8 prompts on stdin and the command hangs
  until the exec timeout). The delete runs *after* the SAML restore, never before, so cleanup can
  never extend the window in which SSO is disabled for everyone, and it is attempted even when
  `cf create-service-key` itself failed, since a create killed by a timeout may still have been
  applied by the broker. A cleanup failure never replaces the error being reported: the orphaned key
  and the exact recovery command are appended to it instead. A *successful* mint keeps its key —
  that key is the returned credential — and the one branch where a working key is deliberately kept
  despite a failure (mint succeeded, restore did not) now names it rather than leaving it silently.
- **A styled table header silently broke both parsers, and now cannot.** Measured against a real
  tenant on cf 8.18.0: with `CF_COLOR=true` exported, `cf` styles each table header cell with ANSI
  escapes *even when stdout is a pipe*, which shifts every column index — `cf services` went from 42
  parsed rows to 0 (so instance discovery reported that the space has no Cloud Logging instance at
  all) and `cf service-keys` from 54 parsed key names to 0. Two independent guards now: every `cf`
  invocation runs with `CF_COLOR=false`, and the parsers strip escape sequences themselves, which is
  provably safe because CF pads its columns by visible width — stripping reproduced the uncolored
  output byte for byte. `cf target` was measured not to colorize at all; it gets the same treatment
  for uniformity, not because it was broken.
- Regression tests for every item above, at both levels: the unit tests cover both service-key
  payload shapes, both `service-keys` header shapes, styled headers using the exact escape sequences
  a real `cf` emits, and each cleanup branch; and the fake `cf` used by the e2e suite now emits the
  v8 shapes by default with switches for the v7/v6 ones, so the end-to-end tests exercise the real
  shapes rather than pinning the old ones.
- Every fix above was also verified against a real tenant rather than only against fixtures: the
  patched extractor pulls a working credential out of a real binding's `{"credentials": {...}}`
  payload that the previous code returned nothing for, and that credential authenticates against the
  real OpenSearch; the patched parser returns exactly the 54 key names the Cloud Controller reports
  for a real 54-key instance (including a 132-character key name, against a 135-wide name column)
  where the previous code returned none; and `cf delete-service-key … -f` was confirmed to exit 0 for
  a key that does not exist, while the same call without `-f` prompts and fails.

## 0.2.0

- **Self-updating.** Every command now checks npm for a newer `@saptools/cf-otel` (at most once an hour)
  and, when one exists, installs that exact version and re-runs the command on it, announcing both steps
  on stderr. `SAPTOOLS_AUTO_UPDATE=on|notify|off` controls it (see the README's Updates section); it is
  off by itself in CI, in tests, from a source checkout and inside the re-run. New `cf-otel self-update
  [--check]` forces the check and install now. `--version` now reads `package.json` at runtime. Both come
  from the private, build-time-bundled `@saptools/core` package; the published tarball gains no runtime
  dependency.


## 0.1.2 - 2026-08-29

- Fixed `searchAfterAll`'s pagination tiebreaker: it sorted by OpenSearch's
  `_id` meta-field, which is documented as restricted from sorting (falls
  back to fielddata, a deprecated path outside this tool's control). Now
  sorts by `spanId`, a mandatory OpenTelemetry field mapped as a plain
  `keyword` with doc_values on. `span` and `fields` now share the same
  tiebreaker constant instead of duplicating the sort array.
- Fixed `mintDashboardsCredential`'s last-resort SAML restore
  (`--allow-mint-credential`): it used to hard-code `saml.enabled=true` on
  restore regardless of the instance's actual original value, permanently
  turning SSO on for an instance that never had it. Now writes the original
  params blob back verbatim, and the critical-failure error message's
  "broken for ALL users" framing only appears when SAML was genuinely on
  beforehand.
- Fixed `top`/`detached`'s `by_trace` terms aggregation: it had no explicit
  `order`, defaulting to OpenSearch's `_count`-desc bucket selection even
  when sorting by duration — on a window with more than 10,000 distinct
  traces, a long-but-low-span-count trace could be silently dropped before
  the client-side sort ever saw it. Both commands now order by the same
  metric they sort by, and warn when that 10,000-bucket cap is actually hit.
- Added regression tests covering every fix above.

## 0.1.1 - 2026-08-29

- Fixed `--attr` filters (e.g. `--attr 'http@status_code>=400'`): bare attribute keys were never
  resolved against their real `span.attributes.*`/`resource.attributes.*` mapping paths, so every
  `--attr` filter silently matched nothing. Added `resolveAndValidateAttrFilters` to resolve keys
  against the live index mapping before querying.
- Fixed `mapping --field` for nested attribute paths: lookups only checked one level of
  `properties`, so dotted paths like `url@path` never resolved against the real nested mapping
  tree (`properties.span.properties.attributes.properties.*`). Field lookups now walk each
  `.`-separated segment's own nested `properties`.
- Fixed a redaction bug in `redactSecretLikeText`: a secret value containing an escaped quote
  (`\"`) could leak the remainder of the value in plaintext next to `[REDACTED]`. The matching
  pattern is now escape-aware.
- Fixed `gaps`'s regression "growing" verdict: the threshold was scaled by `Math.max(1, meanY)`,
  which collapsed toward zero whenever the mean gap was negative. Now scaled by `Math.abs(meanY)`.
- Corrected `gaps`'s self-time documentation and tests: the raw signed-gap sum is only
  approximately, not exactly, equal to the naive self-time formula (a child span nested with slack
  breaks the exact identity).
- Refreshed the OpenTelemetry semantic-convention attribute list backing `--with-samples`, which
  had gone stale and rendered an empty samples column against current data.
- Fixed VCAP `instance_name` matching, `track_total_hits` not being set on paginated queries, four
  commands silently discarding their own truncation flag, a `--limit 0` footgun on `find`/`sample`
  that returned zero rows without warning, a `diff --sort pct` ranking bug when both sides were
  zero, and a missing fallback in `getRegionKeyForApi` for valid SAP regions not yet in the static
  map.
- Added regression tests covering every fix above.

## 0.1.0

Initial release.

- Read-only query and analysis CLI over OpenTelemetry spans already ingested into SAP Cloud
  Logging's OpenSearch backend (`otel-v1-apm-span-*`), reached through the OpenSearch
  Dashboards console-proxy.
- Twelve commands: `sample`, `mapping`, `find`, `top`, `count`, `spans`, `span`, `fields`,
  `selftime`, `gaps`, `detached`, `diff`, plus a `result` subtree (`show`/`list`/`prune`/`clear`)
  for refs saved via `--save`.
- `--region`/`--org`/`--space` targeting with ambient `cf target` fallback and a resolved-target
  stderr notice, matching `cf-hana`'s convention.
- A credential-discovery decision tree for the Cloud Logging dashboards basic-auth credential:
  existing service keys, then pre-SAML app bindings, then (only behind the explicit
  `--allow-mint-credential` opt-in) a temporary SAML disable/mint/restore cycle with redacted
  logging and a loud, distinct error if the restore step itself fails.
- `--format table|json|json-compact|csv` and `--save`/`result show` on every row-returning
  command, mirroring `cf-hana`.
- `search_after`-based pagination past OpenSearch's default `max_result_window` (10000) for
  `spans`, verified against a 10000+ span synthetic trace in both the unit and e2e suites.
