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
`npm install -g @saptools/cf-metrics`. Once installed it keeps itself current: every command checks
npm at most once an hour and, when a newer release exists, installs it and re-runs the command,
printing `cf-metrics: updating X -> Y ...` and `cf-metrics: updated to Y; re-running the command` on
stderr. `SAPTOOLS_AUTO_UPDATE=off` disables that; `cf-metrics self-update --check` shows the status.

## First Steps

1. If nothing is known yet, start with `sample` to see real documents unfiltered, then `fields`
   on a sample doc to discover queryable attribute keys, then `names` to see which metric names
   actually exist for a given service/time range — each name has one fixed `kind` (GAUGE, SUM, or
   HISTOGRAM), which `names` reports alongside its `unit` and doc count.
2. Once you know a service and one or more metric names, `history` is the core command —
   time-bucketed values, kind-aware: GAUGE → avg/min/max per bucket, SUM → per-bucket total
   (delta temporality assumed), HISTOGRAM → count/sum/derived-avg per bucket (no percentile
   approximation — see Limitations below).
3. For "what's it doing right now" without bucketing, use `snapshot`. It shares the same
   `--limit` convention as `names` (default 50, `0` for all) and warns on stderr when the cap
   dropped names — a `terms` cap discards the *sparsest* metrics first, so a short list hides
   exactly the rarely-written custom metric worth looking for.
4. For cross-app comparison on one metric name, use `top` — deliberately has no `--service`
   filter. Kind-aware like `history`: a HISTOGRAM metric (e.g. `http.server.duration`) ranks by
   derived avg latency instead of avg/max value, and has no `MAX` column.
   **Always pass `--unit` for CPU.** Cloud Foundry emits TWO series under the one name
   `container.cpu.usage`, told apart only by `unit`: `unit="1"` is the fraction of the app's CPU
   *entitlement* (matches `cf app`'s `cpu entitlement` column, can exceed 1.0), and `unit="cpu"`
   is the fraction of a single CPU *core* (matches `cf app`'s `cpu` column). They differ by ~17x,
   so averaging both together is meaningless — a bucket's MIN would be a `cpu` sample and its MAX
   a `1` sample. `history` and `top` detect this and warn on stderr, but the numbers are only
   trustworthy once `--unit cpu` or `--unit 1` narrows them to one series. Note that even then,
   `unit="1"` ranks by "how close to its own limit", not absolute CPU, since entitlement scales
   with the memory quota — use `--unit cpu` to compare apps by real CPU consumed. Every other
   metric is single-unit; memory metrics are plain bytes and match `cf app` exactly.
5. For live monitoring during a deploy or incident, use `watch` — polls and prints new points as
   they land; Ctrl-C to stop, `--json` for NDJSON, `--lookback` sets the initial look-back window
   (default `2m`).
6. `--region`/`--org`/`--space` fall back to the ambient `cf target` session when omitted, same as
   `cf-otel`. If more than one Cloud Logging instance exists in the space, pass
   `--service-instance <name>` explicitly — the CLI errors rather than guessing.

## Credential Discovery

Every command needs a Cloud Logging **dashboards** basic-auth credential. Only credentials created
before SAML was enabled on the instance carry a usable username/password, so `cf-metrics` finds the
instance through the v3 API, lists every binding on it in one Cloud Controller request, and prefers
service keys (newest first), then app bindings (oldest first), then `--allow-mint-credential` as an
explicit, disruptive last resort — never use that without the user's go-ahead on a shared/production
instance. Pass `--verbose` to see how many bindings were found and which one succeeded.

Discovery needs a Cloud Foundry session. If `cf target` already points at the requested org/space,
that session is reused read-only and **no `SAP_EMAIL`/`SAP_PASSWORD` are needed**; otherwise (or if
the session is dead) `cf-metrics` logs in on its own with those two variables, in a temporary
`CF_HOME`.

The resolved credential is **cached** under `~/.saptools/cf-metrics/credentials.json` (mode 0600,
7-day TTL), so only the first command against a target pays the full round trip (~30s measured); a
warm command spawns no `cf` at all. A cached credential OpenSearch rejects (HTTP 401/403) is dropped
and rediscovered automatically within the same command. `--refresh-credential` forces rediscovery,
`CF_METRICS_CREDENTIAL_CACHE=0` disables the cache, `cf-metrics credential list` shows what is
cached without the secret, and `cf-metrics credential clear` forgets it.

```bash
cf-metrics names --service my-app --region eu10 --org my-org --space my-space --verbose
cf-metrics credential list
cf-metrics credential clear
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
  every name. `snapshot` (default 50) and `top` (default 20) share this same "0 means no limit"
  convention — unlike `sample`, where `--limit 0` is rejected as an error since it would return
  zero raw documents. `names` and `snapshot` print a stderr notice when the cap actually dropped
  something, so a truncated list never looks complete; `top` does not, because its cut is a
  deliberate top-N ranking rather than an accidental loss.

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

**"Cannot reach Cloud Foundry ... no 'cf target' session is active, and SAP_EMAIL/SAP_PASSWORD are
not set"**: either `cf login` and `cf target -o <org> -s <space>` (the matching session is then
reused), or export `SAP_EMAIL` and `SAP_PASSWORD` so the CLI can log in on its own.

**A command that used to work now says "cached dashboards credential ... was rejected;
rediscovering"**: informational — the service key or binding behind the cached credential was
deleted; the CLI already discovered a replacement and retried. Nothing to do unless the rediscovery
itself failed, in which case the usual credential-discovery error follows.

**stderr shows "cf-metrics: updating X -> Y ..." and the output differs from the last run**: the CLI
upgraded itself before running the command (see Updates in the README). Check `cf-metrics --version`
and the CHANGELOG for Y; `SAPTOOLS_AUTO_UPDATE=notify` announces a release instead of installing it.

**"update to Y failed (...); continuing with X"**: the install could not complete (offline, read-only
prefix); the command still ran on X. Run the printed `npm install -g` command by hand; the same
version is not retried automatically for a day.
