---
name: cf-log-search
description: >-
  Use when a task involves searching SAP BTP Cloud Foundry application logs further back than
  `cf logs`'s short buffer allows — full-text search, filtering by app/space/level/source type,
  finding router-access-log rows by status code or path, RTR-only analytics (error breakdowns,
  latency percentiles, busiest routes), or correlating a request id to its OpenTelemetry trace —
  through the cf-log-search CLI. Queries already-ingested history in SAP Cloud Logging's
  OpenSearch backend (index pattern logs-cfsyslog-*). This is read-only and historical: for
  live/recent tailing use cf-logs instead.
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

For cross-request correlation, use `vcapRequestId` as the input to `trace <vcap-request-id>` —
the per-hop Cloud Foundry request id. `--with-span` does not join via this field as a span
attribute (that approach was tried and found unreliable — see "Correlate a log line to its trace"
below); it joins through the matched RTR row's own `traceId` instead.

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

RTR-only analytics (router access logs — meaningless on application log rows):

```bash
cf-log-search errors --since 24h
cf-log-search latency --by route --since 1h
cf-log-search top-routes --since 24h --limit 10
```

Correlate a log line to its trace:

```bash
cf-log-search trace <vcap-request-id> --with-span
```

`--with-span` joins on the matched RTR row's own trace id, not on `vcap_request_id` — only an RTR
row carries a usable trace id (see "The traceId Field" above). A `--with-span` result with no span
rows and a stderr notice about ingestion lag is normal for a request from the last few minutes;
retry shortly rather than assuming correlation failed.

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
expected when using a relative `--since` with no `--until` (the default) — each command
re-resolves "now" independently at the moment it runs, so the query is really "everything from
(now − duration) onward, with no upper bound." Both edges of that window move between two calls
issued even a few seconds apart: the lower bound excludes slightly more old documents, while new
ingestion adds slightly more at the top. On a continuously-ingesting tenant this can make the
**later** call's total come out **either slightly higher or slightly lower** — it is a genuine
two-sided drift, not a one-directional "always grows" effect. Verified live twice: back-to-back
calls for the same filters differed by 27 out of ~33,450 (+0.08%) in one sample and by 33 out of
~35,400 (−0.09%) in another. What indicates a real bug is a *large* discrepancy — much bigger than
the ingest rate times the few seconds between calls — not the direction of the difference.

**`trace --with-span` finds the log row but no span**: spans lag log-document availability by a
real, measured few minutes on this backend. Wait and retry before assuming the trace id is wrong
or the request was not sampled.
