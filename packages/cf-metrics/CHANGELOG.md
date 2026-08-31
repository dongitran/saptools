# Changelog

All notable changes to `@saptools/cf-metrics` are documented in this file.

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
