# Changelog

All notable changes to `@saptools/cf-otel` are documented in this file.

## 0.8.0

### Fixed

- `mapping --field` on a field alias reported `alias` rather than the type of the field it points
  at. `otel-v1-apm-span-*` carries 135 of them (measured, nine per backing index): short names like
  `app_name` pointing at `resource.attributes.sap@cf@app_name`. Since the same lookup also feeds
  `--attr` resolution, `alias` — which is not a numeric type — made a perfectly valid comparison
  like `--attr <alias>>=400` fail with "is mapped as alias, not a numeric type". The resolved type
  is now reported, with the target named in a new `ALIAS_OF` column.

  Measured while fixing this, and worth recording because it contradicts the obvious reading:
  `alias` is not in `TEXTUAL_MAPPING_TYPES` either, so `=` fell back to a plain `term` instead of
  the array-rendered disjunction — but against a real tenant both encodings returned identical
  counts, for the alias and for an array-shaped span attribute alike. The disjunction matters for
  attributes that really are stored array-rendered; an alias onto one still needs the resolved type
  to reach it.

- `resolveAggregatableField` built `<alias>.keyword`, a name that does not exist. A field alias
  registers only its own full name; the target's multi-fields are not reachable through it, and a
  `terms` aggregation on an unmapped field returns empty buckets with **no error** — the exact
  silent failure that function exists to prevent. It now names the target's sub-field.

- A divergent alias target, and a divergent `ignore_above`, are now reported *alongside* the agreed
  type rather than instead of it, as `(varies)` in the relevant column. Withholding the type looked
  safer and was not: three callers read "no type" as "field absent", and each then does something
  worse than reporting a type with a caveat — the `--attr` numeric guard is skipped entirely (so
  `>=` on a keyword becomes a silently lexicographic `range`), `assertFieldExists` blames the
  tenant's collector configuration, and `mapping --field` calls a field present in every index
  missing. A blank `ignore_above` was its own trap: it reads as "no cap", the safe interpretation,
  while divergence is the hazardous one.

- A field present in every backing index but mapped inconsistently is no longer reported as "was not
  found in the mapping", in `mapping --field` or in `assertFieldExists`; the listing shows
  `ambiguous` rather than `unknown`.

### Changed

- `mapping` output carries a fourth column, `ALIAS_OF`, empty for a concrete field.

## 0.7.1

### Fixed

- The log-to-trace guide named only `…@x-correlation-id` for a cf-logs `correlationId`. The two
  spellings are not synonyms: a router line's `x_correlationid` arrives as `…@x-correlationid`,
  while a caller-supplied `X-Correlation-Id` header arrives as `…@x-correlation-id`. Measured over
  551 live server spans carrying both, they held different values on 69. Following the old wording
  with an id taken from a router row would silently match nothing. Both are documented now, with
  which row type produces which.

## 0.7.0

### Fixed

- `--attr <key>=<value>` never matched an array-valued attribute. An OTel attribute whose value is
  an array reaches `otel-v1-apm-span-*` as the JSON array rendered to text, so the stored keyword
  for an HTTP request header is literally `["<id>"]` — brackets and quotes included — and a plain
  `term` on the bare value matched none of the `span.attributes.http@request@header@*` family.
  The command printed `(no rows)` and exited 0, indistinguishable from "that value never occurred".
  `=` now sends both encodings. Measured against a live tenant, 0 of 60 real request ids matched
  before and 60 of 60 match now, each resolving to exactly one trace. This is the sequel to the
  0.1.1 fix, which resolved the attribute *key* but left the *value* encoding wrong.
  The array form is withheld at numeric, date and ip fields, where an extra unparseable term fails
  the entire search rather than simply not matching.
- A query that failed on only some shards was reported as a complete result. `otel-v1-apm-span-*`
  spans 14 backing indices over 28 shards, and OpenSearch answers a partial failure with HTTP 200,
  the count in `_shards.failed`, and whatever the surviving shards found — which this client read as
  the whole answer. The same applies to a search OpenSearch marks `timed_out`. Every command now
  fails loudly instead of returning a short result at exit 0. Set
  `CF_OTEL_ALLOW_PARTIAL_SHARDS=1` to accept a partial answer when a shard is persistently down.
- A field's mapping type was taken from whichever backing index reported it first, even though the
  query runs against all of them. Dynamic mapping can give one path different types in different
  indices after an ingest change, and the `=` encoding above depends on that type being right —
  a wrong answer there would send a term that some shards reject. The type is now reported only
  when every index holding the field agrees, and treated as unknown otherwise.
- `--attr` on a key that matches no field in the index printed an empty result with no explanation.
  It now says so on stderr. Top-level fields (`status.code`, `kind`, `serviceName`) also resolve
  their real mapping type now instead of none.
- `_mapping` was re-fetched once per attribute-prefix candidate and again per command. It is now
  fetched at most once per client, which is the whole lifetime of one command. Measured: four
  `--attr` filters went from five HTTP round trips to one.
- The `--attr` help text's example, `http@status_code>=400`, names a keyword-mapped field, so
  copying it verbatim was rejected as a numeric comparison against text.

### Added

- `find --vcap-request-id <id>` and `count --vcap-request-id <id>` resolve one Cloud Foundry
  gorouter request id — what `@saptools/cf-logs` 0.8.0 reports as `ParsedLogRow.vcapRequestId` — to
  its trace. Measured 1:1 with a trace over 1,504 server spans. A hex id is trimmed and lower-cased,
  because keyword matching is exact and every stored id sampled was lower case. If the tenant's
  collector does not export request headers the command says so by name rather than returning
  nothing.
- `AttrFilter` gains `mappedType`, the resolved OpenSearch mapping type, and
  `resolveAndValidateAttrFilters` and `VCAP_REQUEST_ID_FIELD` are now exported, so a library
  consumer gets the same `=` behaviour as the CLI rather than the pre-0.7.0 broken path.

### Changed

- **`find --format json-compact` now emits the trace id column** instead of silently falling back to
  full JSON. It returns one entry per matching *span*, so a trace with several matching spans
  appears more than once; pipe through `sort -u` when feeding it to another command.
- **Commands can now fail where they previously returned a short result at exit 0.** That is the
  point of the shard and timeout checks above, but it is a behaviour change for any script that
  treated exit 0 as "the query ran".
- `find --service` is no longer required. A request id is unique on its own, and the trace it
  finds frequently has its root in a different service than the one that served the request, so
  demanding a service both blocked the lookup and pointed the investigation the wrong way. As with
  `count`, an unfiltered `find` now reaches across the whole retention window; pass `--since`.
  (`top` still requires `--service`, because its aggregation is not meaningful unscoped.)

## 0.6.0

### Fixed

- `result prune`'s retained notice said the sessions' "manifest could not be read or recognized",
  but `retained` also counts a ref directory whose manifest is absent and whose emptiness could not
  be established. It now says this version could not read them, which covers all three cases. Same
  correction applied to the `PruneOutcome` doc comment, and to `cf-metrics` and `cf-hana`, so the
  three CLIs report this identically.
- A unit test asserting that `result list` omits an expired session prune could not delete passed
  for the wrong reason: the injected clock also reached the implicit prune, which deleted the
  fixture, so the empty result came from the absent-directory path rather than from the list-side
  expiry filter. The test now holds the results directory read-only, and fails if that filter is
  removed.
- Pruning no longer deletes a saved result whose expiry it cannot establish. `resolveExpiryMillis`
  previously fell back to "treat as expired", so a manifest with damaged timestamps had its rows
  deleted even though they were perfectly readable — and a version that changed only the *timestamp
  encoding* (a Temporal `ZonedDateTime`, an ISO week date, epoch millis as a string, or canonical
  ISO with surrounding whitespace, which `Date.parse` does not trim) would have had its data
  destroyed by an older binary. Such a session is now retained and reported, like any other manifest
  this version cannot fully interpret. One rule now covers every case: only an expired session with
  a resolvable date, or a ref directory verified to be empty, is ever deleted.
- A `ttlMinutes` too large to date no longer produces an immortal session. 0.5.0 guarded
  `Number.isFinite(ttlMinutes)`, which accepted `1e308` whose product overflows to `Infinity`; and
  finiteness was the wrong bound anyway, since `Number.isSafeInteger` admits a value whose product
  reaches 5.4e20 while a `Date` holds at most ±8.64e15 ms. Either way the session survived every
  prune and was not even counted. A derived expiry beyond the `Date` range is now unresolvable,
  hence retained.
- `result prune` names the refs it left in place instead of only counting them. A retained session is
  omitted from `result list` and no command removes one, so the ref is the only way to find the file.
- `result prune` exits non-zero when it could not delete an expired session. It is the only
  machine-readable health signal the store has, and reporting a partial sweep as success meant
  `if cf-otel result prune; then …` could never detect a store it had failed to clean.

### Changed

- `PruneOutcome` is now `{ removed, failed, retainedRefs }`. `retained` was a count the user could
  not act on; the refs replace it. This is why 0.6.0 is a minor rather than a patch.

### Known limitations

- A leftover `<ref>.tmp-<pid>` directory from an interrupted save is invisible to `result list`,
  `result prune` and `result clear`, and no TTL reaches it. Reclaim it by hand.
- A retained session is reported by `result prune` but not listed, and there is no `result rm`;
  `result clear` is the only in-tool removal and it removes everything it can see.
- `result list` omits a session it could not read without saying so. Only `result prune` reports
  those.

## 0.5.0

### Fixed

- Pruning no longer deletes saved results it cannot read. `pruneResultSessions` runs at the head of
  every save, read and list, and it treated four distinct outcomes — file absent, I/O error, invalid
  JSON, unrecognized shape — as one "missing" answer, then `rm -rf`'d the directory. A single
  nominally read-only `result list` was measured destroying a valid unexpired manifest whose only
  difference was `version: 2`, and a manifest that was merely unreadable at that moment
  (`chmod 000`) with its data fully intact. Because the self-updater makes mixed versions on one
  machine normal, that meant an older cf-otel silently wiped a store a newer one had written.

  Reads are now classified, and only an expired session or an empty ref directory is removed. A
  manifest that cannot be read or recognized is left exactly where it is and counted as retained; a
  ref directory holding files under names this version does not know is retained too, so a future
  manifest filename cannot be mistaken for a crashed save and reclaimed.

- A saved result with a damaged `expiresAt` is no longer immortal. `Date.parse` returns `NaN` for it
  and `NaN <= now` is `false`, so such a session survived every prune for ever and still read back —
  the TTL failing in the direction that keeps production span data past its retention window. Expiry
  now falls back to `createdAt` plus `ttlMinutes`, and a session whose age cannot be established by
  either route is treated as expired.

- One undeletable directory no longer takes the whole store offline. Deletion is now attempted per
  session, so a results directory that cannot be written no longer fails every save, read and list
  outright; and because the housekeeping prune is best-effort, `result show` and `result list` keep
  working on intact sessions even when the directory cannot be listed at all. `result show` also
  enforces the TTL itself instead of relying on that prune having succeeded.

- `result show` now says which of the three things went wrong. An unreadable manifest and one written
  in a newer format used to report "Saved result not found or expired", which was simply untrue; both
  now name the file and, for a newer format, say it was left in place. Two error codes were added:
  `RESULT_UNREADABLE` and `RESULT_STORE_NOT_WRITABLE`.

- `result list` prints the ref that actually resolves. The listed ref came from inside the manifest
  while lookup uses the directory name; when those disagreed, `list` advertised a ref that
  `result show` then rejected as invalid. Expired sessions that prune could not remove are omitted
  rather than displayed.

- `--save` no longer discards a completed query when the store cannot be written. The store is now
  probed while arguments are validated — before the CF login and credential discovery every `--save`
  command otherwise pays for first — so a store that cannot be written fails in ~120ms instead of after ~20s of
  tenant work. One hook on the root program covers all eleven `--save` commands, so the check cannot
  drift out of one of them.

  For the failures that cannot be known in advance (a full disk, the per-result byte cap), the rows
  are printed in the requested `--format` with a diagnostic on stderr, and the exit code is non-zero.
  Exiting 0 was not an option: `ref=` is a machine contract, and in `ref=$(cf-otel find --save …)` a
  zero exit with a table on stdout would bind a table row as if it were a ref.

- The unit test suite no longer writes into the developer's own `~/.saptools`. `mapping --save` in the
  CLI tests fakes the OpenSearch client but not the store, and the vitest config set no store
  override — 69 of the 70 sessions found in one real store had been written by that one test, one per
  run. The config now points `CF_OTEL_RESULTS_ROOT` at a throwaway directory that is cleared as it
  loads.

- Pruning no longer deletes a saved result whose expiry it cannot establish. `resolveExpiryMillis`
  previously fell back to "treat as expired", so a manifest with damaged timestamps had its rows
  deleted even though they were perfectly readable — and a version that changed only the *timestamp
  encoding* (a Temporal `ZonedDateTime`, an ISO week date, epoch millis as a string, or canonical
  ISO with surrounding whitespace, which `Date.parse` does not trim) would have had its data
  destroyed by an older binary. Such a session is now retained and reported, like any other manifest
  this version cannot fully interpret. One rule now covers every case: only an expired session with
  a resolvable date, or a ref directory verified to be empty, is ever deleted.

- A `ttlMinutes` too large to date no longer produces an immortal session. The bound is what a `Date` can hold, not what a float can hold: `Number.isSafeInteger` admits a value whose product with 60000
  reaches 5.4e20, while a `Date` holds at most ±8.64e15 ms — so `createdAt + ttlMinutes` could yield
  a *finite* expiry no clock will ever reach, which survived every prune and was not even counted.
  A derived expiry beyond the `Date` range is now treated as unresolvable, hence retained.

- `result prune` names the refs it left in place instead of only counting them. A retained session is
  omitted from `result list` and no command removes one, so the ref is the only way to find the file.

- `result prune` exits non-zero when it could not delete an expired session. It is the only
  machine-readable health signal the store has, and reporting a partial sweep as success meant
  `if cf-otel result prune; then …` could never detect a store it had failed to clean.

- `PruneOutcome` is now `{ removed, failed, retainedRefs }`. `retained` was a count the user could
  not act on; the refs replace it.

### Changed

- `pruneResultSessions` returns `{ removed, retained, failed }` instead of a bare count.
  `result prune` still prints `removed=N` as its only stdout line and reports retained and
  undeletable counts on stderr.
- `tryCreateResultSession` was removed. It had no caller, and it could not become one: it discards
  the error a diagnostic needs, and its `ResultSession | undefined` return makes the caller decide
  what to print — the decision now made explicitly in `emitRows`.
- `assertResultStoreWritable` and the `PruneOutcome` type are exported.

## 0.4.0

### Fixed

- `--since`/`--until` are validated instead of forwarded blind. Previously anything that did not match
  `<digits><s|m|h|d>` was passed to OpenSearch verbatim, so `--since yesterday` came back as a raw
  `HTTP 400 parse_exception` dump, and `--since 999999999d` overflowed the `Date` range and surfaced as
  a bare `cf-otel: Invalid time value` that named no flag at all. Both now fail with a message that
  names the flag and spells out the accepted grammar.

  The check also catches dates `Date.parse` accepts but OpenSearch's `strict_date_optional_time`
  rejects: it silently rolls `2026-02-30` over to March 2 and `2026-04-31` to May 1, so those are now
  reported as "not a real calendar date" rather than quietly querying the wrong day. Month length is
  probed against a fixed leap year and corrected for February rather than passing the caller's year to
  `Date.UTC`, which maps a year below 100 into 1900-1999 and would therefore reject the real date
  `0000-02-29`.

  A `--since` resolving later than its `--until` is rejected too — an inverted range returned zero rows,
  which on a read-only tool is indistinguishable from "no data".

  Validation runs alongside the other argument checks rather than inside the query builder, which sits
  behind `withOpenSearchClient`. A malformed bound now fails in ~125ms instead of after a full CF login
  and credential discovery (~23s measured).

  Behavior change: a bare number is no longer accepted. The index's `startTime` format is
  `strict_date_optional_time||epoch_millis`, so a number that was never checked used to reach
  OpenSearch and work. `--since 24` reads just as easily as a `24h` missing its unit, and as an epoch-millis lower
  bound it would match the entire index instead of the last day, so the error names both readings.

- `spans --fields` rejects a name no column builder knows. `--fields duration` (a plausible typo for
  `durationInNanos`) used to print one empty `{}` per span at exit 0 — and because the list is also sent
  as an OpenSearch `_source` filter, the documents genuinely came back without the field, leaving
  nothing downstream able to notice. The valid-name list and the default selection are now derived from
  the column builders instead of being maintained as a second hand-written list, which is what allowed
  the two to drift.

- Dashboards console-proxy requests now carry a deadline. Node's `fetch` applies none of its own, so an
  endpoint that accepted the connection and never answered hung the CLI indefinitely with no output;
  the e2e suite reproduces this, taking 5 minutes and a harness kill before the fix versus 1.5s after.
  The default is 60s per request, overridable with `CF_OTEL_HTTP_TIMEOUT_MS`, and a timeout is reported
  distinctly from a transport failure so the message points at the right cause. Ported from cf-metrics
  so both CLIs behave the same way; unlike cf-metrics, no caller-supplied `AbortSignal` is threaded
  through the client, because cf-otel has no long-running command that needs one.

  The deadline covers the response body as well as the request. Headers can arrive well before the
  payload finishes streaming — the normal shape for a wide aggregation — so an abort often lands on the
  body read; left unhandled it escaped as a bare `The operation was aborted due to timeout` with no
  path, no ceiling and no hint.

  The configured value is also normalized before it reaches `AbortSignal.timeout`, which throws a
  `RangeError` for a fractional or negative delay and, above 2^31-1, silently reduces the timer to
  **1ms** with only a process warning — handing anyone who raised the ceiling the exact opposite. A
  fractional, negative or non-numeric value now falls back to the default, and an over-large one is
  clamped to 2^31-1 rather than defaulted, since it still expresses "wait a long time".

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
