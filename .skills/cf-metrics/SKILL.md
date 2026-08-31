---
name: cf-metrics
description: >-
  Use when a task involves querying container CPU/RAM/filesystem usage or custom OTel gauge/sum/histogram metrics already ingested into SAP Cloud Logging's OpenSearch backend on SAP BTP Cloud Foundry — viewing resource usage over time, comparing apps by CPU/memory load, or live-watching a deploy or incident — through the cf-metrics CLI. This is read-only and near-real-time: it never instruments a running process (use cf-inspector or cf-live-trace for that) and never mutates application data.
---

# CF Metrics

## Purpose

Use `cf-metrics` to query container resource metrics (CPU, memory, filesystem, uptime) and any
custom OTel metric (queue depths, DB pool stats, HTTP request duration, etc.) already exported
into SAP Cloud Logging's OpenSearch backend (index pattern `metrics-*`). It answers "how did
CPU/RAM look over the last N hours" — something the base `cf app` command cannot do, since
Cloud Foundry's Log Cache only retains a few minutes of container-metric history. For live process
instrumentation, use `cf-inspector` or `cf-live-trace` instead.

If `cf-metrics` is missing, install it from `@saptools/cf-metrics`:
`npm install -g @saptools/cf-metrics`.

## First Steps

1. If nothing is known yet, start with `sample` to see real documents unfiltered, then `fields`
   on a sample doc to discover queryable attribute keys, then `names` to see which metric names
   actually exist for a given service/time range — each name has one fixed `kind` (GAUGE, SUM, or
   HISTOGRAM), which `names` reports alongside its `unit` and doc count.
2. Once you know a service and one or more metric names, `history` is the core command —
   time-bucketed values, kind-aware: GAUGE → avg/min/max per bucket, SUM → per-bucket total
   (delta temporality assumed), HISTOGRAM → count/sum/derived-avg per bucket (no percentile
   approximation — see Limitations below).
3. For "what's it doing right now" without bucketing, use `snapshot`.
4. For cross-app comparison on one metric name, use `top` — deliberately has no `--service`
   filter. Kind-aware like `history`: a HISTOGRAM metric (e.g. `http.server.duration`) ranks by
   derived avg latency instead of avg/max value, and has no `MAX` column.
   **Do not trust CPU aggregates in this release.** Cloud Foundry emits TWO series under the one
   name `container.cpu.usage`, told apart only by `unit`: `unit="1"` is the fraction of the app's
   CPU *entitlement* (matches `cf app`'s `cpu entitlement` column, can exceed 1.0), and
   `unit="cpu"` is the fraction of a single CPU *core* (matches `cf app`'s `cpu` column). They
   differ by ~17x. `history` and `top` do not filter by `unit`, so they average both series
   together — a `history` bucket's MIN is typically the `cpu` sample and its MAX the `1` sample,
   and the AVG is meaningless. Inspect this metric with `sample --format json` (which shows each
   document's `unit`) rather than `history`/`top`. Even once separated, `unit="1"` ranks by "how
   close to its own limit", not absolute CPU, since entitlement scales with the memory quota.
   Every other metric is single-unit; memory metrics are plain bytes and match `cf app` exactly.
5. For live monitoring during a deploy or incident, use `watch` — polls and prints new points as
   they land; Ctrl-C to stop, `--json` for NDJSON, `--lookback` sets the initial look-back window
   (default `2m`).
6. `--region`/`--org`/`--space` fall back to the ambient `cf target` session when omitted, same as
   `cf-otel`. If more than one Cloud Logging instance exists in the space, pass
   `--service-instance <name>` explicitly — the CLI errors rather than guessing.

## Credential Discovery

Every command needs a Cloud Logging **dashboards** basic-auth credential in addition to
`SAP_EMAIL`/`SAP_PASSWORD`. Only credentials created before SAML was enabled on the instance carry
a usable username/password, so `cf-metrics` lists every binding on the instance in one Cloud
Controller v3 request and prefers service keys (newest first), then app bindings (oldest first),
then `--allow-mint-credential` as an explicit, disruptive last resort — never use that without the
user's go-ahead on a shared/production instance. Pass `--verbose` to see how many bindings were
found and which one succeeded.

```bash
cf-metrics names --service my-app --region eu10 --org my-org --space my-space --verbose
```

## Command Choice

Every command accepts `--format table|json|json-compact|csv` (default `table`); row-returning
commands accept `--save`, which prints `ref=<id>` instead of printing the result, retrievable
later with `cf-metrics result show <ref>`.

Blind exploration, before you know a service, metric name, or field names:

```bash
cf-metrics sample --service my-app --limit 3
cf-metrics fields --service my-app
cf-metrics mapping --field name
```

Discover which metrics exist for a service, and their kind:

```bash
cf-metrics names --service my-app --since 24h
```

- `--limit` bounds how many names come back (default 50); `--limit 0` removes the cap and returns
  every name. `top` shares this same "0 means no limit" convention for its own `--limit` (default
  20) — unlike `sample`, where `--limit 0` is rejected as an error since it would return zero raw
  documents.

The core analysis command — time-bucketed, kind-aware history:

```bash
cf-metrics history --service my-app --name container.cpu.usage --name container.memory.usage \
  --since 2h --interval 10m
cf-metrics history --service my-app --name http.server.duration --since 1h
```

- Pass `--name` more than once to chart several metrics in one call.
- `--kind <GAUGE|SUM|HISTOGRAM>` skips the automatic kind lookup when already known (e.g. from a
  prior `names` call) — saves one query per invocation.
- A metric reporting `CUMULATIVE` aggregation temporality (not `DELTA`) prints a warning instead
  of a guessed correction — SUM handling in this release assumes delta temporality, the only kind
  observed in real data so far.

Point-in-time and cross-app views:

```bash
cf-metrics snapshot --service my-app
cf-metrics top --name container.memory.usage --since 1h --limit 10
```

Live monitoring:

```bash
cf-metrics watch --service my-app
cf-metrics watch --service my-app --name container.cpu.usage --json --interval 10000
cf-metrics watch --service my-app --lookback 10m
```

Saved results:

```bash
cf-metrics result show <ref>
cf-metrics result list
cf-metrics result prune
cf-metrics result clear
```

## Limitations

- **No cumulative-temporality SUM stitching**: `history` on a SUM metric sums raw values per
  bucket, correct only for delta temporality. If you hit a `CUMULATIVE` warning, treat the numbers
  as unreliable for that metric until this is implemented.
- **No histogram percentiles**: `history` on a HISTOGRAM metric (e.g. `http.server.duration`)
  reports count/sum/avg only — no p50/p95/p99. Use `avg` as a rough signal, not a percentile.

## Troubleshooting

**A `terms` aggregation returns no buckets for a field you know has data**: the field may be
`text`-mapped rather than `keyword`-mapped — check with `cf-metrics mapping --field <name>` first.

**`history`/`names`/`top` return nothing for a service you know is running**: confirm the app is
actually started (`cf app <name>`) — a stopped app emits no container metrics at all, and the
`--since` window may simply predate the last restart. Container metrics also only exist while the
app has running instances; there is no historical backfill for a period the app was down.

**Credential discovery fails with "Could not resolve Cloud Logging dashboards credentials"**: the
message lists every service key and fallback binding tried and why each failed. Pass
`--service-key <name>` or `--fallback-binding-app <name>` (both repeatable) to point at specific
candidates before reaching for `--allow-mint-credential`.

**"Multiple 'cloud-logging' service instances found in this space"**: pass
`--service-instance <name>` explicitly — the CLI will not guess which one you meant.
