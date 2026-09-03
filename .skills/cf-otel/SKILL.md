---
name: cf-otel
description: >-
  Use when a task involves querying or analyzing OpenTelemetry trace spans already ingested into SAP Cloud Logging's OpenSearch backend on SAP BTP Cloud Foundry — finding slow traces, ranking self-time to find a bottleneck, analyzing gaps between sibling spans, finding detached/orphaned trace continuations, or diffing two traces before/after a fix — through the cf-otel CLI. This is read-only and post-hoc: it never instruments a running process (use cf-inspector or cf-live-trace for that) and never mutates application data.
---

# CF Otel

## Purpose

Use `cf-otel` to query and analyze OpenTelemetry spans already exported into SAP Cloud
Logging's OpenSearch backend (index pattern `otel-v1-apm-span-*`). It is the "the trace already
got exported, now go find the real bottleneck in it" tool — read-only, post-hoc, no live process
access. For live HTTP capture or breakpoint/logpoint debugging on a running app, use
`cf-live-trace` or `cf-inspector` instead and read their skills.

If `cf-otel` is missing, install it from `@saptools/cf-otel`: `npm install -g @saptools/cf-otel`.

## First Steps

1. If nothing is known yet (no traceId, no field names), start with `sample` to see real
   documents unfiltered, then `fields` on a real span to discover queryable attribute keys.
2. Once a service and rough name/time range are known but not a traceId, use `find` (name known)
   or `top` (outlier hunting, no name needed).
3. Once a traceId is known, `selftime` is almost always the next command — it ranks spans by
   self-time descending, which is what actually finds a bottleneck (not inclusive/raw duration).
4. If `selftime`'s numbers don't add up to the root duration, run `detached` on the same traceId
   — the missing time is very often a detached/orphaned continuation with its own fresh traceId
   in the same service and time window.
5. To understand *why* a specific parent's children are slow (flat overhead vs. an O(n) or worse
   growth pattern), use `gaps` on that parent span.
6. To compare before/after a fix, use `diff` on the two traceIds rather than eyeballing two
   `selftime` tables side by side.
7. `--region`/`--org`/`--space` fall back to the ambient `cf target` session when omitted; watch
   the stderr notice to see which was actually used, and pin explicitly for anything you'll
   re-run. There is no `--app` — `--service <name>` is a plain filter on `serviceName`, not a
   target.

## Credential Discovery

Every command needs a Cloud Logging **dashboards** basic-auth credential in addition to the
normal `SAP_EMAIL`/`SAP_PASSWORD` CF login. This is automatic and usually invisible — pass
`--verbose` to see which step actually produced it:

```bash
cf-otel count --service my-app --region eu10 --org my-org --space my-space --verbose
```

If it fails, the error names every service key and fallback binding that was tried. The last
resort, `--allow-mint-credential`, temporarily disables SAML on the Cloud Logging instance to
mint a fresh key — this breaks SSO dashboards login for every human user of that instance for
the duration of the call. Only use it when explicitly asked to, never as a first attempt, and
never on a shared/production instance without the user's explicit go-ahead.

## Command Choice

Every command accepts `--format table|json|json-compact|csv` (default `table`); most accept
`--save`, which prints `ref=<id>` instead of printing the result, retrievable later with
`cf-otel result show <ref>`.

Blind exploration, before you know a traceId or any field names:

```bash
cf-otel sample --service my-app --limit 3
cf-otel fields <traceId> --name GET
cf-otel mapping --field name
```

Locate a trace once you know roughly what you're looking for:

```bash
cf-otel find --service my-app --name "*SyncBatchAction*" --since 24h --limit 5
cf-otel top --service my-app --since 24h --sort duration --limit 5
cf-otel count <traceId> --name POST
cf-otel find --service my-app --attr 'http@status_code>=400' --errors-only
```

`top` hunts outliers, so its `DURATION` is **the single longest span in the trace** — not the
wall-clock envelope, not the root span; in a fan-out flow all three differ, often by an order of
magnitude. `SPAN_COUNT` under-reports as well. Never subtract `top`'s `DURATION` from an
external timestamp to hunt for "untraced" time: the difference is the column's meaning, not a
gap. For the real envelope:

```bash
cf-otel spans <traceId> --fields "startTime,durationInNanos" --format csv
# wall-clock = max(startTime + durationInNanos) - min(startTime)
```

`--attr <key><op><value>` (repeatable) supports `>=`, `<=`, `>`, `<`, `=`, and `~` (contains);
`--errors-only` is shorthand for `status.code == 2`. Use `count` as the trust-but-verify
companion to any ranked/capped table — a `terms` aggregation's bucket list is itself capped, so
an exact `count --name <name>` can reveal occurrences a ranked table's cutoff hid.

Inspect one trace's spans:

```bash
cf-otel spans <traceId> --limit 20
cf-otel span <traceId> <spanId>
cf-otel span <traceId> --name GET --kind SPAN_KIND_SERVER --first
cf-otel span <traceId> --name GET --all
```

`spans` paginates transparently past OpenSearch's 10000-document `max_result_window` and reports
the true total plus whether the fetch was truncated. `span` supports lookup either by exact
spanId or by `--name`/`--kind` match when the spanId isn't known yet (the common case) —
`--first` is deterministic (sorted by startTime then spanId), `--all` returns every match for
comparing same-named spans with different attributes.

The core analysis commands:

```bash
cf-otel selftime <traceId> --top 20 --by-service --with-samples
cf-otel gaps <traceId> <parentSpanId> --filter-next "*UPDATE SomeTable"
cf-otel detached <traceId> --padding 5 --limit 20
cf-otel diff <traceIdA> <traceIdB> --sort delta
```

- `selftime` ranks spans by self-time (own duration minus children's durations, clamped to zero)
  descending — this, not inclusive-time ranking, is what actually finds the bottleneck. It always
  reports a clamped-spans count; a non-zero count for a parent/children pair within one service
  is a real diagnostic signal worth investigating (usually clock skew across a network hop is
  the only expected source of clamping).
- `gaps` needs an already-identified parent span (find it via `selftime` or `span --name` first)
  and reports gap stats, a histogram, the top-N largest gaps, an overlap check, and a linear
  regression verdict (`flat` vs `growing`) on gap size against occurrence index — `growing`
  means check for an O(n) or worse pattern accumulating per iteration.
- `detached` finds other traces whose spans land in the same service and time window — use it
  when a trace's self-time doesn't add up to its root duration; a server framework can spawn
  background work in a new, uninstrumented context that gets its own fresh traceId instead of
  propagating the parent's.
- `diff` joins two traces' self-time-by-name breakdowns; a name present on only one side is
  shown as zero on the other, never dropped, so a newly-introduced or newly-eliminated call
  stands out immediately.

Saved results:

```bash
cf-otel result show <ref>
cf-otel result show <ref> --row 3
cf-otel result list
cf-otel result prune
cf-otel result clear
```

## Troubleshooting

**A `terms` aggregation returns no buckets for a field you know has data**: the field may be
`text`-mapped rather than `keyword`-mapped — check with `cf-otel mapping --field <name>` before
assuming the value doesn't occur. Commands that aggregate internally already do this
bare-field-then-`.keyword`-fallback check automatically.

**`selftime`'s self-time numbers don't add up to the root's own duration**: run `cf-otel detached
<traceId>` next — this is the single most common cause, not a bug in the ranking.

**Credential discovery fails with "Could not resolve Cloud Logging dashboards credentials"**:
the message lists every service key and fallback binding tried and why each failed. Pass
`--service-key <name>` or `--fallback-binding-app <name>` (both repeatable) to point at specific
candidates instead of relying on auto-discovery, before reaching for `--allow-mint-credential`.

**A very large trace's `spans`/`selftime`/`gaps` call is slow**: this is expected for traces with
thousands of spans (`search_after` pagination fetches the whole trace); use `--save` on `spans`
to avoid printing thousands of rows, and prefer `selftime`/`gaps` (which need the full span set
internally either way) over manually paging through `spans`.
