# @saptools/cf-metrics

Query container CPU/RAM/filesystem usage and custom OTel gauge/sum/histogram metrics already
ingested into SAP Cloud Logging's OpenSearch backend (index pattern `metrics-*`). This answers
"how did resource usage look over the last N hours" — something the base `cf app` command cannot
do, since Cloud Foundry's Log Cache only retains a few minutes of container-metric history. This is
a **read-only, near-real-time** tool: it never instruments a running process and never mutates
application data. For live process instrumentation, see `@saptools/cf-inspector` and
`@saptools/cf-live-trace` instead.

## Install

```bash
npm install -g @saptools/cf-metrics
```

## Auth

Every command reads `SAP_EMAIL` / `SAP_PASSWORD` from the environment for the underlying
`cf api` / `cf auth` / `cf target` login — never pass them as flags. There is no separate login
step: each command is a complete, one-shot operation (except `watch`, which stays running until
Ctrl-C).

```bash
export SAP_EMAIL=you@example.com
export SAP_PASSWORD=your-password
```

## Targeting

Pass `--region`, `--org`, and `--space` explicitly, or omit any of them to fall back to the
currently targeted `cf target` session. Whichever way it resolves, the CLI prints a one-line
notice to stderr naming the resolved target:

```
cf-metrics: target br10/example-org/space-demo (resolved from ambient 'cf target'; pass --region/--org/--space to pin)
```

`--service <name>` is a plain query filter on `resource.attributes.sap@cf@app_name` — it never
targets or connects to a running app the way `cf-inspector`/`cf-hana` do. If more than one
Cloud Logging service instance exists in the targeted space, pass `--service-instance <name>` to
pick one explicitly.

## Credential discovery

Reaching OpenSearch requires a Cloud Logging **dashboards** basic-auth credential, which is harder
to get than it sounds once SAML is enabled on the instance's dashboards: only credentials created
*before* SAML was switched on keep a username and password — newer ones expose the endpoint and
mTLS ingest material but nothing you can log in with.

`cf-metrics` lists every credential binding on the instance in one Cloud Controller v3 request and
reads their details, preferring:

1. Service keys, newest first (`--service-key`, repeatable, to pin specific ones). Keys are created
   deliberately, so age says nothing about whether one predates SAML.
2. App bindings, oldest first (`--fallback-binding-app`, repeatable, to pin specific apps) — an app
   bound before SAML keeps its original basic-auth credential forever, so the oldest is the best
   bet.
3. Only behind `--allow-mint-credential`: temporarily disable SAML, mint a new key, restore SAML
   immediately after. This is disruptive (breaks SSO dashboards login for everyone during the
   window) and is never attempted by default.

Candidates are probed in small parallel batches, so a binding whose credential is not ultimately
used may still be read; the one that wins is always the highest-priority match, never whichever
request happened to return first.

Pass `--verbose` to see how many bindings were found and which one succeeded. If every candidate
fails, the error names each one that was tried.

## Commands

| Command | Purpose |
| --- | --- |
| `sample` | Dump the N most recent full metric documents, unfiltered — start here when you know nothing yet. |
| `mapping` | Field-type discovery (`keyword` vs `text`) on any `--index` pattern (default `metrics-*`). |
| `fields` | List every flat attribute key on a sample metric document. |
| `names` | Which metric names exist for a service/time-range, with `kind`, `unit`, and doc count. |
| `history` | Time-bucketed values for one or more metric names, kind-aware — the core command. |
| `snapshot` | Latest single value per metric name for a service, point-in-time, no bucketing. |
| `top` | Cross-app ranking for one metric name over a range. No `--service` filter; that's the point. Kind-aware like `history`. Not reliable for `container.cpu.usage` — see the unit caveat below. |
| `watch` | Poll for new metric points as they land, `--json` for NDJSON — live monitoring during a deploy or incident. `--lookback` sets the initial look-back window (default `2m`). |
| `result show\|list\|prune\|clear` | Inspect results saved via `--save`. |

Every row-returning command supports `--format table|json|json-compact|csv` (default `table`) and
`--save`, which prints `ref=<id>` instead of the result and stores it under
`~/.saptools/cf-metrics/results/<ref>/` for later inspection with `cf-metrics result show <ref>`.

See `.skills/cf-metrics/SKILL.md` (or the installed `~/.claude/skills/cf-metrics/SKILL.md`) for the
full command reference with worked examples.

## `history`'s kind-aware behavior

Every metric name has one fixed `kind`, resolved automatically (or pass `--kind` to skip the
lookup when already known):

- **GAUGE** (container CPU/memory/filesystem, DB pool stats, most queue metrics) — reports
  avg/min/max per time bucket.
- **SUM** (queue message counters) — reports a per-bucket total. This assumes delta temporality,
  the only kind observed in real data; a document reporting cumulative temporality triggers a
  warning instead of a guessed correction.
- **HISTOGRAM** (HTTP request duration) — reports count/sum/derived-avg per bucket. Percentile
  approximation from bucket boundaries is not implemented in this release (see Limitations).

`top` resolves kind the same way (or accepts its own `--kind` override) because HISTOGRAM
documents carry no `value` field to rank on: GAUGE/SUM metrics rank by avg/max value as usual, but
a HISTOGRAM metric ranks apps by derived avg latency (`sum(sum)/sum(count)`, the same math
`history` uses per bucket) and its rows have no `MAX` column, since no true per-request max is
available without the percentile approximation this release doesn't implement.

## ⚠️ `container.cpu.usage` carries two different series under one name

Cloud Foundry emits **two distinct measurements under the metric name `container.cpu.usage`**,
interleaved in the same time window and told apart only by the `unit` field:

| `unit` | `description` | meaning | matches `cf app` column | typical value |
| --- | --- | --- | --- | --- |
| `1` | time used by an app instance per entitlement | fraction of the app's **CPU entitlement** | `cpu entitlement` | `0.278` |
| `cpu` | time used by an app instance per single CPU core | fraction of **one CPU core** | `cpu` | `0.016` |

The two differ by more than an order of magnitude for a small app. Note also that OpenTelemetry's
semantic convention reserves the name `container.cpu.usage` for CPU *in cores*, so the `unit="1"`
series does not mean what the metric name suggests, and the `unit="1"` value can legitimately
exceed `1.0` when an app bursts past its entitled share (values above `5.0` occur in real data).

Aggregating across both series at once produces a number with no physical meaning, so `history`
and `top` **warn on stderr** whenever the queried window contains more than one unit, and
`--unit <unit>` narrows to a single series. Real output for the same app and window:

```
$ cf-metrics history --service my-app --name container.cpu.usage --since 30m --interval 15m
cf-metrics: WARNING: "container.cpu.usage" reports 2 different units in this window (1, cpu) —
the values below average incommensurable series and are NOT meaningful. Re-run with --unit <1>.
TIME                     | AVG      | MIN      | MAX      | DOC_COUNT
2026-08-31T15:30:00.000Z | 0.157980 | 0.015969 | 0.309866 | 110        <- MIN and MAX are different series

$ cf-metrics history ... --unit cpu           # fraction of one core, matches `cf app` cpu 1.7%
2026-08-31T15:30:00.000Z | 0.016908 | 0.015969 | 0.018127 | 53

$ cf-metrics history ... --unit 1             # fraction of entitlement, matches `cf app` 28%
2026-08-31T15:30:00.000Z | 0.289152 | 0.272990 | 0.309866 | 57
```

Note how the blended MIN is simply the `cpu` series and the blended MAX the `1` series, and how
the two filtered runs' document counts add back to the blended total (53 + 57 = 110).

When ranking with `top`, remember that `unit="1"` measures **how close each app is to its own
limit** — the right question for "which app is about to be throttled", the wrong one for "which
app is burning the most CPU", because entitlement scales with each app's memory quota (Cloud
Foundry grants roughly 25% of a core per 1 GB). Use `--unit cpu` for absolute CPU comparisons.

Every other metric is single-unit and unaffected — verified across 300 sampled documents covering
12 distinct metric names. In particular `container.memory.usage` and `container.memory.capacity`
are plain byte counts and agree with `cf app` exactly.

## Limitations

- `--unit` exists on `history` and `top` only — the two commands that aggregate, and so the only
  two that can blend series. `sample` shows each document's own unit, `names` lists every unit a
  name reports, and `snapshot` shows the unit of the latest document; none of them accept the
  filter because none of them aggregate across units.
- One `--unit` applies to every `--name` in the same `history` call. Combining names with
  different units (say `container.cpu.usage --unit cpu` alongside `container.memory.usage`, which
  is `By`) simply returns no buckets for the ones that do not match — the per-metric bucket count
  printed to stderr makes that visible rather than silent.
- No cumulative-temporality SUM stitching (last-minus-first per bucket) — not implemented because
  no real cumulative-temporality metric has been observed; a warning fires instead of a silent
  guess if one appears.
- No histogram percentile approximation (p50/p95/p99) — `history` on a HISTOGRAM metric reports
  count/sum/avg only. Approximating percentiles from `explicitBounds`/`bucketCounts` correctly
  needs either server-side scripting (unverified whether the Dashboards console-proxy allows it)
  or careful cross-document bucket merging; neither was validated against real data for this
  release.

## Example

```bash
cf-metrics history --service example-app --name container.memory.usage \
  --since 1h --interval 20m
```

```
TIME                     | AVG                | MIN       | MAX       | DOC_COUNT
-------------------------+--------------------+-----------+-----------+----------
2026-08-31T14:40:00.000Z | 123978028.42857143 | 123968637 | 123985072 | 49
2026-08-31T15:00:00.000Z | 124032009.38235295 | 123985072 | 124054101 | 68
2026-08-31T15:20:00.000Z | 124089882.71428572 | 124054101 | 124165861 | 70
2026-08-31T15:40:00.000Z | 124177294.04347827 | 124169148 | 124179009 | 23
```

Memory is used here rather than CPU deliberately: `container.memory.usage` is a plain byte count
that agrees exactly with `cf app`, whereas `container.cpu.usage` currently blends two units — see
the caveat above.

## Development

```bash
pnpm --filter @saptools/cf-metrics lint
pnpm --filter @saptools/cf-metrics typecheck
pnpm --filter @saptools/cf-metrics test:unit
pnpm --filter @saptools/cf-metrics test:e2e
pnpm --filter @saptools/cf-metrics build
```

Unit tests mock the OpenSearch console-proxy and `cf` CLI layers directly; e2e tests spawn the
built CLI against a fake `cf` binary and an in-memory fake OpenSearch Dashboards console-proxy
server — no real network or SAP credentials are used in either suite.
