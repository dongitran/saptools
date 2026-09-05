# Changelog

All notable changes to `@saptools/cf-metrics` are documented in this file.

## 0.10.0

### Fixed

- `history` emitted every already-fetched row twice when a cached credential turned out to be
  rejected partway through. The client bootstrap deliberately re-runs the whole work callback
  against a freshly discovered credential, and the row accumulator lived outside it, so a run that
  hit an HTTP 401 on its second `--name` printed the first name's rows again — at exit 0, and
  persisted that way under `--save`. Nothing caught it because no test drove a command through the
  real retry; one does now.

- A pin flag defeated the credential cache entirely, and with `--allow-mint-credential` re-minted on
  every run. `--service-key`/`--fallback-binding-app` each restrict only their own candidate type
  during discovery, but the cache read them as restricting both, so `--fallback-binding-app x` alone
  rejected every cached service-key credential (and vice versa) and paid the full ~30s rediscovery
  every time. A cached *minted* credential matched no pin at all, so `--allow-mint-credential` went
  back through minting on every invocation — and minting disables SAML on the shared Cloud Logging
  instance to do its work, breaking SSO for every user of that instance each time.

- `credential clear` left the password on disk. Writes go through `credentials.json.tmp-<pid>`
  before the rename, so an interruption in that window stranded a file holding the basic-auth
  password in cleartext; nothing reclaimed it, and `credential list` reads only the real file, so
  the CLI reported the credential gone while the secret stayed. The clear now sweeps those too.

- The kind lookup ignored `--since`/`--until` and scanned all of retention. It answered with the
  kind that dominated *all time* rather than the window being charted, so a name whose
  instrumentation changed shaped a recent query with the wrong sub-aggregations and returned real
  document counts beside all-null values. It also made 0.9.0's ambiguity warning say "in this
  window" about data from every window there has ever been. One unbounded 80-shard scan per
  `--name` per run is gone with it.

- `--save` threw away the whole result when the store could not be written. A read-only or full home
  directory discarded the ~30s credential round trip and the query with it; the rows are now printed
  instead, with a notice and a non-zero exit so `ref=$(… --save)` cannot silently bind a table row.

- Calendar-invalid dates were accepted and forwarded. `Date.parse` rolls `2026-02-30` to March 2
  rather than rejecting it, so the bound reached OpenSearch — which rejects it (measured) — as a
  parse-exception dump after a full login. Worse, the ordering check compares *resolved* instants,
  so a typo came back as a confident "--since is later than --until", pointing at the flag that was
  never wrong. Also rejected now, each verified against a real instance rather than assumed: a space
  instead of `T`, hour 24, minute or second 60, and more than nine fractional digits. A relative
  duration too large to land on a real date is named with its flag instead of surfacing as a bare
  `RangeError: Invalid time value`, and a bare number now explains both readings it could have had.

- An interrupted `--save` stranded a `<ref>.tmp-<pid>` directory that `prune`, `list` and `clear`
  all walked past, because the ref pattern they filter on never matches it. They accumulated
  permanently; `prune` now removes them.

- `--verbose` printed a service instance's `clientSecret` and `apiToken` in full. The redaction list
  in `saml-toggle.ts` covered only `private`/`password`/`signature` while the exec layer's own
  covered more; both now cover the same classes.

- `CF_COLOR` is forced off for every `cf` invocation. An inherited `CF_COLOR=true` makes the CLI
  emit ANSI escapes even when piped, and these parsers key off literal text — including the
  `status:` reader behind the SAML restore check, where a styled label would report a restore that
  actually succeeded as "SSO broken for ALL users".

### Changed

- `resolveMetricKind`/`resolveTopMetricKind` take an optional lookup window; `KindLookupWindow` is
  exported alongside `KindResolution`.

## 0.9.0

### Fixed

- A query that failed on only some shards was reported as a complete result. `metrics-*` spans 40
  backing indices over 80 shards (measured), and OpenSearch answers a partial failure with HTTP 200,
  the count in `_shards.failed`, and whatever the surviving shards found — which this client read as
  the whole answer. The same applies to a search OpenSearch marks `timed_out`. That is worse here
  than in a client that reads raw documents: `names`, `snapshot`, `top` and `history` never read
  `hits` at all, so a partial failure does not shorten a list, it silently changes the numbers and
  the ranking, and the result still looks entirely plausible. Every command now fails loudly instead
  of returning a wrong answer at exit 0. Set `CF_METRICS_ALLOW_PARTIAL_SHARDS=1` to accept a partial
  answer when a shard is persistently down.

- `watch` could drop points permanently rather than merely late. Its cursor only advances past
  documents a poll actually returned, so a failed poll is retried — but a partial-shard answer was
  not a failure, it was a short page, so the cursor moved past whatever the missing shards held and
  the `since: cursor` filter then excluded those points for good once the shard recovered. With the
  check above they are delayed by one interval instead of lost.

- A metric name reporting more than one `kind` silently lost all but the most common one.
  `resolveMetricKind` asked for a single `terms` bucket, so a second kind — an instrumentation
  change mid-rollout, or two emitters sharing a name — was not merely ignored, it was invisible even
  to detect. `history` and `top` now warn and name every kind found (pass `--kind` to pick one), and
  `names` lists them the way it already listed multiple units.

- `mapping --field` could not resolve any field whose name contains a dot. The `_source` key is one
  flat string on every document, but the mapping tree still nests on the `.` segments, so the
  single-level lookup found nothing for the whole `resource.attributes.*` family — the fields most
  worth checking with a command whose purpose is "check keyword vs. text before aggregating on any
  field". Each segment is now walked in turn.

- A field's mapping type was taken from whichever backing index reported it first, even though the
  query runs against all of them. Dynamic mapping can give one path different types in different
  indices after an ingest change, so a type sampled from one index can be wrong for another's
  shards. The type is now reported only when every index holding the field agrees.

- A timeout that fired while the response body was still streaming escaped unwrapped. Headers can
  arrive well before a wide aggregation finishes streaming, so the deadline often lands on the body
  read rather than the request — where it surfaced as a bare "The operation was aborted due to
  timeout" with no path, no ceiling and no hint, instead of this package's own message.

- `CF_METRICS_HTTP_TIMEOUT_MS` above Node's timer ceiling silently did the opposite of what it says.
  `AbortSignal.timeout` reduces any delay past 2^31-1 to **1ms** (emitting only a
  `TimeoutOverflowWarning`) and throws a `RangeError` past 2^32-1, so raising the ceiling too far
  aborted requests almost immediately while the resulting error still claimed to have waited the
  full configured time. The value is now clamped, and a fractional or negative one falls back to the
  default rather than reaching the timer at all.

### Changed

- **Commands can now fail where they previously returned a result at exit 0.** That is the point of
  the shard and timeout checks above, but it is a behaviour change for any script that treated exit
  0 as "the query ran".
- `resolveMetricKind` returns `{ kind, otherKinds }` instead of a bare kind string, so a caller can
  see the ambiguity the CLI warns about. `KindResolution` is exported alongside it.

## 0.8.0

### Fixed

- Pruning no longer deletes saved results it cannot read. `pruneResultSessions` runs at the head of
  every save, read and list, and it treated four distinct outcomes — file absent, I/O error, invalid
  JSON, unrecognized shape — as one "missing" answer, then `rm -rf`'d the directory. So a
  nominally read-only `result list` destroyed a valid unexpired session whose only difference was a
  newer `version`, and one that was merely unreadable at that moment (a permission error, with the
  data fully intact). Because the self-updater makes mixed versions on one machine normal, that also
  meant an older cf-metrics silently wiped a store a newer one had written.

  Reads are now classified, and only an expired session or an empty ref directory is removed. A
  manifest that cannot be read or recognized is left exactly where it is and counted as retained; a
  ref directory holding files under names this version does not know is retained too.

- A saved result with a damaged `expiresAt` is no longer immortal. `Date.parse` returns `NaN` for it
  and `NaN <= now` is `false`, so such a session survived every prune for ever and still read back.
  Expiry now falls back to `createdAt` plus `ttlMinutes`, and a session whose age cannot be
  established by either route is treated as expired.

- One undeletable directory no longer takes the whole store offline. Deletion is attempted per
  session, and the housekeeping prune is best-effort, so `result show` and `result list` keep working
  on intact sessions even when the results directory cannot be listed. `result show` also enforces
  the TTL itself instead of relying on that prune having succeeded.

- `result show` now says which of the three things went wrong. An unreadable manifest and one written
  in a newer format used to report "Saved result not found or expired", which was untrue; both now
  name the file, and a newer format says it was left in place. Added the `RESULT_UNREADABLE` error
  code.

- `result list` reports the ref that actually resolves. The listed ref came from inside the manifest
  while lookup uses the directory name; when those disagreed, `list` advertised a ref that
  `result show` rejected. Expired sessions that prune could not remove are omitted rather than shown.

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
  `if cf-metrics result prune; then …` could never detect a store it had failed to clean.

- `PruneOutcome` is now `{ removed, failed, retainedRefs }`. `retained` was a count the user could
  not act on; the refs replace it.

### Changed

- `pruneResultSessions` returns `{ removed, retained, failed }` instead of a bare count.
  `result prune` still prints `removed=N` as its only stdout line and reports retained and
  undeletable counts on stderr.
- The `PruneOutcome` type is exported.

### Known limitations

- A leftover `<ref>.tmp-<pid>` directory from an interrupted save is invisible to `result list`,
  `result prune` and `result clear`, and no TTL reaches it. Reclaim it by hand.
- A retained session is reported by `result prune` but not listed, and there is no `result rm`;
  `result clear` is the only in-tool removal and it removes everything it can see.
- `result list` omits a session it could not read without saying so. Only `result prune` reports
  those.

## 0.7.1

- README: document `SAPTOOLS_ROOT` next to the other update controls. No code change; this release also
  exercises the new self-update path on installs of 0.7.0.

## 0.7.0

- **Self-updating.** Every command now checks npm for a newer `@saptools/cf-metrics` (at most once an
  hour: one 18-byte `dist-tags` request with a 2 s timeout, remembered under `~/.saptools/updates/`)
  and, when one exists, installs that exact version with the package manager that owns the running
  binary and re-runs the command on it — `cf-metrics: updating 0.7.0 -> 0.7.1 ...` and then
  `cf-metrics: updated to 0.7.1; re-running the command` on stderr, nothing when already current. A
  failed install prints the manual command once and the command runs on the installed version; that
  version is not retried for a day. `SAPTOOLS_AUTO_UPDATE=on|notify|off` (per-CLI
  `CF_METRICS_AUTO_UPDATE`), `SAPTOOLS_UPDATE_INTERVAL_MINUTES`, `SAPTOOLS_NPM_REGISTRY` and
  `SAPTOOLS_UPDATE_DEBUG` control it; it is off by itself in CI, in tests, from a source checkout or
  `npm link`, under `npx`, and inside the re-run. New `cf-metrics self-update [--check]` forces the
  check and install now.
- **`--version` reads `package.json`** at runtime instead of a hand-maintained constant. Both this and
  the updater come from the new private `@saptools/core` package, bundled into `dist/cli.js` at build
  time so every `@saptools` CLI can share one implementation and one test suite; the published tarball
  gains no runtime dependency.

## 0.6.0

Every command used to pay the full Cloud Foundry round trip on every run. Measured on a real tenant
(61 credential bindings on the Cloud Logging instance, 39 service instances in the space) before
anything was changed, a plain `names` command took **33.8s and 32.5s** on two consecutive runs. The
breakdown was not what the previous release notes assumed: `cf api` + `cf auth` + `cf target` cost
about 6s together, while **`cf services` alone took 15–38s** — the CF CLI implements it as one
request per instance in the space — and the bindings listing plus the per-binding probes another
6–20s. Three changes, each independently useful:

- **A matching `cf` session is reused instead of logging in again.** When `cf target` already points
  at the requested org/space (the normal state after `cf login`), the read-only discovery commands run
  in that session as-is — the same pattern `cf-hana` uses for bare app names. The session is never
  modified: `cf api`/`cf auth`/`cf target -o -s` refuse to run in it by construction, and the target
  is re-read after discovery so a `cf target` in another terminal mid-run cannot hand back a credential
  from the wrong space. **`SAP_EMAIL`/`SAP_PASSWORD` are now optional** whenever such a session
  exists; they are still used, exactly as before, when no session matches or the session turns out to
  be dead (not logged in, token expired), and the error says which of those it was.
- **`cf services` is gone.** The Cloud Logging instance is found through one `cf space --guid` plus one
  `GET /v3/service_instances?space_guids=…&fields[service_plan.service_offering]=name` (2.4s + 2.0s
  measured), which also returns the instance GUID the bindings listing needs. A dead session is
  recognized on the first failing command and abandoned, rather than being blamed on each of the
  bindings one at a time.
- **The discovered dashboards credential is cached** under `~/.saptools/cf-metrics/credentials.json`
  (directory 0700, file 0600, written atomically), keyed by API endpoint, org, space and instance, with
  a 7-day time-to-live. A hit is silent and costs no `cf` spawn at all — a warm `names` is the
  OpenSearch query and nothing else. `--verbose` names the cached source; `--refresh-credential`
  rediscovers and replaces the entry; `CF_METRICS_CREDENTIAL_CACHE=0` disables reading and writing;
  `cf-metrics credential list` shows what is cached (target, instance, source, endpoint, expiry —
  never the username or password) and `cf-metrics credential clear` forgets it. A cached credential
  that OpenSearch rejects (HTTP 401/403 — its key or binding was deleted) is dropped and rediscovered
  within the same command, which then retries once; `watch` now surfaces that rejection instead of
  retrying it every interval forever. `--service-key`/`--fallback-binding-app` pins are honoured: a
  cached credential from a binding the caller did not name is a miss.
- Why cache a secret on disk at all, when `cf-hana` keeps HANA bindings live-only: this is the same
  trade `cf-xsuaa` already makes for XSUAA client secrets in `~/.saptools/xsuaa-data.json`, with the
  same protections, and `~/.cf/config.json` already holds a refresh token that can fetch this very
  credential from the Cloud Controller — the cache widens nothing about who can obtain it, it only
  saves re-obtaining it thirty seconds at a time. The opt-out and `credential clear` exist for anyone
  who weighs it differently.
- Fixed on the way: the `--allow-mint-credential` path read the freshly minted key with
  `cf service-key`, whose CLI v8 output wraps the fields in a `credentials` object where v7 printed
  them flat, so a minted key looked empty (after SAML had already been toggled). Both shapes are read.
- API changes for library consumers: `discoverDashboardsCredential` takes `SapCredentials | undefined`
  and the returned `DashboardsCredential` carries the resolved `instance`; `discoverServiceInstance`/
  `listCloudLoggingInstances` take the space name and return `{ name, guid }`; `findBoundApps`,
  `cfServices` and `parseServicesTable` are removed with the `cf services` path; the credential-cache
  functions are exported. `CfMetricsError` gains an optional `status`, with `isAuthRejection()` to
  test for 401/403. The test-only results-root override `CF_METRICS_RESULTS_ROOT` is renamed
  `CF_METRICS_SAPTOOLS_ROOT`, since it now also relocates the credential cache.

## 0.5.0

Two robustness fixes, both reproduced against the real backend before being changed.

- **Every OpenSearch request now has a deadline.** `fetch` was called with no timeout at all, so a
  Dashboards endpoint that accepted the connection and then went silent hung the command forever —
  no output, no error, nothing to distinguish it from a slow query, and no way out but Ctrl-C.
  Requests now carry a 60s ceiling (matching what the `cf` exec layer already enforced), overridable
  with `CF_METRICS_HTTP_TIMEOUT_MS`, and a timeout is reported as a timeout rather than a generic
  failure. `watch`'s own Ctrl-C signal is **combined** with the deadline rather than replacing it —
  previously, supplying a caller signal silently opted that request out of any timeout, which is
  precisely the long-running command that needs one.
- **Ctrl-C no longer strands a temporary CF_HOME containing CF credentials.** Cleanup lived in a
  `try/finally`, but Node terminates immediately on an *unhandled* SIGINT/SIGTERM, so the block
  never ran: only `watch` registered a signal listener, and the other eight commands left the
  directory behind. Once `cf auth` has run it holds `.cf/config.json` with the CF access token and
  a long-lived opaque refresh token. Measured on a developer machine before the fix: 13 stranded
  directories, 6 of them holding credentials. The session now registers its own SIGINT/SIGTERM
  handler, removes the directory synchronously (an async unlink is not guaranteed to finish while
  the process is exiting), and re-raises the signal with the default disposition restored so the
  shell still sees the conventional 128+signal status. `saml-toggle`'s own temporary directory,
  which holds the instance's full params blob, is protected the same way.
- Directories stranded by earlier versions are not cleaned up retroactively — remove any leftover
  `/tmp/saptools-cf-metrics-*` by hand once, and treat any CF refresh token they contain as exposed.

## 0.4.0

- **`snapshot` no longer silently caps at 50 metric names.** It sent a `terms` aggregation with a
  hardcoded size and exposed no `--limit`, so an app reporting more names lost the rest with no
  warning and no way to see them. Worse, a `terms` aggregation with no explicit `order` selects
  buckets by `doc_count` descending, so the names dropped were the **sparsest** ones — the
  rarely-written custom metric someone is most likely hunting for, while the high-volume container
  metrics that any command would surface anyway were always kept.
- `snapshot` now takes `--limit`, following the same convention `names` and `top` already use
  (`0` means all, values above OpenSearch's result-window ceiling are rejected up front).
- **`names` gets the same treatment**, because it has the identical bug: its `terms` aggregation
  also carries no explicit `order`, so its own default cap of 50 silently discarded the sparsest
  names. Both commands now print a stderr notice when the aggregation actually dropped something.
  `top` deliberately does **not** warn: its cut is an explicit `order`ed top-N ranking, so what it
  drops is the lowest-ranked apps — the ones the command exists to let you ignore.
- Truncation is detected from OpenSearch's own `sum_other_doc_count`, not by comparing the returned
  row count against the requested limit. The row-count heuristic was wrong twice over: it fired
  when an app happened to have exactly `--limit` names and nothing was lost (reproduced live on an
  app with exactly 14 names), and it could never fire under `--limit 0` — the very flag the notice
  tells people to reach for. `@saptools/cf-otel` already reads the same field for the same reason.
- Scope, measured rather than assumed: real apps on the tenant tested report 6–13 metric names, so
  the old cap of 50 was not actually being hit. This closes a latent failure and an inconsistency —
  `snapshot` was the only row-returning command with no way to see all of its own data.
- API change for library consumers: `querySnapshot` and `queryNames` now return `{ rows, truncated }`
  instead of bare row arrays. `SnapshotResult` and `NamesResult` are exported.
- Known limitation, unchanged by this release: the notice is not persisted by `--save`, so
  `result show <ref>` on a truncated saved result gives no hint that names were dropped. The same
  applies to `top`'s multi-unit warning; storing notices alongside rows needs a result-store schema
  change and is deliberately left for a separate release.

## 0.3.1

- **An inverted `--since`/`--until` window is now rejected instead of returning an empty table.**
  OpenSearch accepts `{gte: <later>, lte: <earlier>}` and simply matches nothing, so
  `--since 30m --until 2h` exited 0 with `(no rows)` — indistinguishable from a genuinely quiet
  period, and only after a full ~20s credential round trip. It now fails in ~50ms, before any
  network call.
- The same guard covers a case the user could not have spotted: commands that default `--since` to
  a recent window inverted it **without anything contradictory being typed**. `--until 3h` on its
  own resolved to `{gte: now-2h, lte: now-3h}` and silently returned nothing. That shape gets its
  own message naming the default as the cause, rather than blaming a value the user never wrote.
- Windows that run forwards are unaffected: `--since 4h --until 3h` still works, an equal start and
  end is still allowed as a legal point query, and `sample`, which leaves the start unbounded, still
  accepts `--until` on its own.
- Folded four near-identical per-command time-flag checks into one shared `assertValidTimeRange`,
  so no command can validate the shape of a bound but forget the ordering.

## 0.3.0

Credential discovery now asks the Cloud Controller v3 API directly instead of scraping `cf` output.

- **Root cause of the tool's slowness, now fixed.** `cf service-keys` output is a three-column
  table, but the parser matched a header line equal to exactly `name`, so it always returned an
  empty list and every run reported "no service keys exist" even when usable keys were there. With
  keys apparently absent, each command fell through to a fallback scan that ran one `cf env` per
  bound app, serially, dumping each app's entire environment just to find one binding.
- Both steps are replaced by two requests:
  `GET /v3/service_credential_bindings?service_instance_guids=…&include=app` lists every service
  key and app binding on the instance in one call, and `…/<guid>/details` returns one binding's
  credentials. Candidates are probed in bounded-parallel batches, and the winner is chosen by
  priority rather than by whichever request returns first, so the credential used never depends on
  network timing.
- Measured on a real instance with 66 bindings: credential discovery went from **14.8s to 1.8s**,
  and a full `names` command from **24.9s to 15.6s**. It is also predictable — the old scan's cost
  depended on where a usable binding happened to sit in the app list, up to ~90s in the worst case.
- Ordering reflects what actually predicts a usable credential. Only bindings created *before*
  SAML was enabled keep a basic-auth username/password, so app bindings are tried oldest-first.
  Keys keep the previous newest-first convention: they are created deliberately, and one minted
  during an intentional SAML-off window can be newer than a key without credentials.
- A failed `--service-key`/`--fallback-binding-app` filter now says the filters excluded every
  binding, rather than claiming the instance has none.
- Behaviour change worth noting: because candidates are probed concurrently, a binding whose
  credential is not ultimately used may still be read. The previous implementation stopped at the
  first success.
- Removed the now-unused `cfEnv`, `cfServiceKeys`, `parseServiceKeyNames` and `extractVcapServices`
  internals along with the old VCAP parsing path. None were part of the package's public exports.

## 0.2.0

Correctness and ergonomics pass driven by verification against a real Cloud Logging backend and a
cross-check of every reported number against `cf app`, an independent data path. The headline item
is a metric whose aggregates were silently meaningless.

- **`--unit` on `history` and `top`, plus an automatic multi-unit warning.** A metric name does not
  always identify one series: `container.cpu.usage` is published as **two series under a single
  name** — `unit="1"` (fraction of the app's CPU entitlement, matching `cf app`'s `cpu entitlement`
  column) and `unit="cpu"` (fraction of one CPU core, matching `cf app`'s `cpu` column) — whose
  values differ by roughly 17x. Aggregating both at once produced a plausible-looking but
  physically meaningless average, with a bucket's MIN drawn from one series and its MAX from the
  other, and it inverted `top`'s ranking: an app consuming more absolute CPU could fall out of the
  top 10 entirely. Both commands now detect the ambiguity via a sibling aggregation on the query
  they already send (no extra round trip), warn loudly on stderr, and accept `--unit` to select one
  series. Verified across 300 documents spanning 12 metric names that `container.cpu.usage` is the
  only affected name; HISTOGRAM, SUM and memory metrics are all single-unit.
- `names` now lists **every** unit a metric name reports (e.g. `cpu, 1`) rather than only the most
  common one. As the discovery command it is where a user first meets a metric, and showing a
  single unit while its DOC_COUNT counted both series actively concealed the ambiguity above.
- `history` with several `--name` flags now emits **one** result instead of one per name. It
  previously wrote an independent document per metric, so `--format json` produced two
  concatenated arrays — not parseable JSON — and `--format csv` grew a second header row midway,
  both while still exiting 0. Combined rows carry a `NAME` column; a single `--name` keeps its
  original shape.
- `top` now defaults `--since` to 2h, as `history` and `names` already did. It previously sent no
  time filter at all when `--since` was omitted, aggregating across the entire retention window
  for every app in the space.
- An invalid `--kind` on `history`/`top` now fails in milliseconds instead of after a full
  credential-discovery round trip, matching how every other flag is validated.
- The e2e fake backend now rejects a `range` clause carrying `unmapped_type`, exactly as real
  OpenSearch does. That bug reached production in 0.1.0 precisely because the fake accepted it, so
  the whole suite stayed green; the guard is now pinned from both sides.

## 0.1.0

Initial release.

- Read-only query CLI over container CPU/RAM/filesystem and custom OTel gauge/sum/histogram
  metrics already ingested into SAP Cloud Logging's OpenSearch backend (`metrics-*`), reached
  through the OpenSearch Dashboards console-proxy — the same access path `@saptools/cf-otel` uses
  for trace spans, applied to the metrics index instead.
- Nine commands: `sample`, `mapping`, `fields`, `names`, `history`, `snapshot`, `top`, `watch`,
  plus a `result` subtree (`show`/`list`/`prune`/`clear`) for refs saved via `--save`.
- `history` is kind-aware: GAUGE metrics (container CPU/memory/filesystem, DB pool stats) report
  avg/min/max per time bucket; SUM metrics (queue counters) report a per-bucket total, assuming
  delta temporality — the only kind observed in real data; HISTOGRAM metrics (HTTP request
  duration) report count/sum/derived-avg per bucket. Cumulative-temporality SUM stitching and
  histogram percentile approximation are explicitly out of scope for this release — see the
  package README's Limitations section.
- `top` ranks every app in the targeted space by one metric, not just one service — deliberately
  has no `--service` filter.
- `watch` polls for new points and prints them as they land (`--json` for NDJSON), ported from
  `@saptools/cf-events`' live-watch loop shape.
- Same credential-discovery decision tree as `cf-otel`: existing service keys, then pre-SAML app
  bindings, then (only behind the explicit `--allow-mint-credential` opt-in) a temporary SAML
  disable/mint/restore cycle.
- `--format table|json|json-compact|csv` and `--save`/`result show` on every row-returning
  command.
- Found and fixed during real-backend verification (not just the fake-backed test suite): a
  `range` filter on the `time` field must not carry `unmapped_type` — that option is sort-only;
  OpenSearch rejects it on `range` with a `parsing_exception`. Sort clauses elsewhere correctly
  keep it, since some rotated `metrics-otel-v1-*` indices lack a mapped `date` field.
