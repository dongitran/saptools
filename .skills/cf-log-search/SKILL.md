---
name: cf-log-search
description: >-
  Use when a task involves searching SAP BTP Cloud Foundry application logs further back than
  `cf logs`'s short buffer allows — full-text search, filtering by app/space/level/source type,
  or finding router-access-log rows by status code or path — through the cf-log-search CLI.
  Queries already-ingested history in SAP Cloud Logging's OpenSearch backend (index pattern
  logs-cfsyslog-*). This is read-only and historical: for live/recent tailing use cf-logs instead.
---

# CF Log Search

## Purpose

Use `cf-log-search` to search SAP Cloud Foundry application logs that have already been ingested
into SAP Cloud Logging's OpenSearch backend — full-text search on application log messages,
structured filtering by app/space/level/source type, and exact filtering on router-access-log
fields (HTTP status code, method, path). This answers "did this error happen yesterday, and on
which app" — something `cf logs` cannot do, since Cloud Foundry's loggregator only retains a short
buffer. For live tailing of what an app is doing right now, use `cf-logs` instead.

If `cf-log-search` is missing, install it from `@saptools/cf-log-search`:
`npm install -g @saptools/cf-log-search`.

## First Steps

1. If nothing is known yet, start with `apps` and `sources` to see which CF apps and which
   `source_type` values (RTR router-access-logs vs. APP/PROC/WEB application logs vs. others) are
   actually present in a time window, then `fields` for the queryable field reference (a curated
   list — this index's real field-name space is enormous and dumping it is deliberately not the
   default; pass `--raw --index <one-concrete-index>` only if you need the real mapping).
2. `search` is the core command — time-bounded (`--since`/`--until`, default `--since 1h`),
   filterable by `--app`/`--log-space`/`--level`/`--source-type`, full-text `--query` against the
   message (application-log rows only — router rows have no message field, they are already fully
   structured), and exact `--vcap-request-id`/`--correlation-id`/`--status` filters.
3. `count` answers "how many", without fetching rows — cheap even over a wide time range.
4. Retention is **not fixed** — it shrinks as ingestion volume grows. Do not assume "logs from N
   days ago" will always be available; if a search that should match something returns nothing,
   check whether the window has aged out before assuming a filter is wrong.

## Two Very Different Row Shapes

Every row has a `source_type`. The two overwhelmingly common ones behave very differently:

- **`RTR`** (router access log): fully structured — `method`, `path`, `responseStatus` (a real
  number), `responseTimeMs`. **No message field** — `search --query` never matches an RTR row.
- **`APP/PROC/WEB`** (application stdout/stderr): a free-text `message` plus the common envelope
  (`level`, `logger`, `appName`, etc.). This is what `--query` full-text search matches.

## The `traceId` Field — Read This Before Using It

A row's `traceId` is the real OpenTelemetry trace id — joinable to `cf-otel`'s
`otel-v1-apm-span-*` spans — **only when `sourceType` is `RTR`**. On every other row (the
majority, by volume), the same underlying field is a different, unrelated value and `traceId` is
reported as an empty string rather than that misleading value. **Never treat a non-empty `traceId`
as available on anything but an RTR row**, and never reach for the field on an APP-log row hoping
for a trace correlation — there isn't one at this layer (see `vcapRequestId` below instead).

For cross-request correlation that works on **every** row shape, use `vcapRequestId` — the
per-hop Cloud Foundry request id, present on both RTR and APP-log rows that were part of the same
inbound request, and also the field an OTel span carries as
`http@request@header@x-vcap-request-id`.

## Credential Discovery

Identical mechanism to `cf-otel`/`cf-metrics` (all three query the same Cloud Logging OpenSearch
backend): a Cloud Logging **dashboards** basic-auth credential is discovered via the Cloud
Foundry v3 API, cached on disk, and reused until it expires or is rejected. Pass `--verbose` to
see which binding it came from. If more than one Cloud Logging instance exists in the space, pass
`--service-instance <name>` explicitly.

`cf-log-search` does **not** support `--allow-mint-credential` (unlike its siblings) — if
discovery fails, narrow with `--service-key <name>` or `--fallback-binding-app <name>` (both
repeatable); minting a new credential is not available from this CLI.

```bash
cf-log-search search --app my-app --region br10 --org my-org --space my-space --verbose
```

## Command Choice

Every command accepts `--format table|json|json-compact|csv` (default `table`); every
row-returning command accepts `--save`, which prints `ref=<id>` instead of the result, retrievable
later with `cf-log-search result show <ref>`.

Blind exploration:

```bash
cf-log-search apps --since 24h
cf-log-search sources --since 24h
cf-log-search fields
```

The core search command:

```bash
cf-log-search search --app my-app --level error --since 6h
cf-log-search search --query "connection refused" --since 24h
cf-log-search search --source-type RTR --status 500 --since 1h
cf-log-search search --vcap-request-id 11111111-1111-4111-8111-111111111111
```

Just a count, cheaper than fetching rows:

```bash
cf-log-search count --app my-app --level error --since 24h
```

Saved results:

```bash
cf-log-search result show <ref>
cf-log-search result list
cf-log-search result prune
cf-log-search result clear
```

Cached credentials:

```bash
cf-log-search credential list
cf-log-search credential clear
```

## Limitations

- **No live tail.** `cf-log-search` is historical/near-real-time (subject to OpenSearch ingest
  lag), never a replacement for `cf-logs`'s live streaming.
- **No cross-app trace/analytics commands yet.** RTR-field analytics (error-rate breakdowns,
  latency percentiles, busiest routes) and explicit trace-correlation commands (`trace
  <vcap-request-id>`) are planned in later phases of this package, not in this release.
- **Retention is not a fixed guarantee.** It is governed by ingest volume and the backend's own
  lifecycle policy; it has been observed to be tens of days but is not contractual and will shrink
  as ingestion grows.

## Troubleshooting

**`search --query` returns nothing for a message you can see with `cf logs`**: confirm the row is
an APP-log row, not RTR — RTR rows have no message field at all, so `--query` can never match one.
Use `--source-type RTR --status <code>`/`--source-type RTR` filters for router rows instead.

**A filter you expect to match returns nothing**: check the field is filtered as `.keyword` (exact
match), not full text — `--app`/`--log-space`/`--level`/`--source-type` all match the value
exactly, including case. Use `apps`/`sources` to see the real values first.

**Credential discovery fails with "Could not resolve Cloud Logging dashboards credentials"**: the
message lists every service key and fallback binding tried and why. Pass `--service-key <name>` or
`--fallback-binding-app <name>` before concluding the instance has no usable credential at all.

**"Multiple 'cloud-logging' service instances found in this space"**: pass
`--service-instance <name>` explicitly.

**`count` and `search`'s reported total disagree slightly for what looks like the same query**:
expected when using a relative `--since`/`--until` (the default) — each command re-resolves "now"
independently at the moment it runs, and this tenant ingests continuously, so the window's leading
edge has moved between two calls issued even a few seconds apart. Verified live: two back-to-back
calls for the same filters differed by 27 out of ~33,450 (0.08%), with the later call always
reporting the larger total. A large discrepancy, or a later call reporting *fewer* matches, is not
this — that would be a real bug.
