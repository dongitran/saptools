# Changelog

All notable changes to `@saptools/cf-metrics` are documented in this file.

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
