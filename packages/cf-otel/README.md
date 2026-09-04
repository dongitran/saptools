# @saptools/cf-otel

Query and analyze OpenTelemetry trace spans already ingested into SAP Cloud Logging's
OpenSearch backend (index pattern `otel-v1-apm-span-*`). This is a **read-only, post-hoc**
tool: it never instruments a running process and never mutates application data. For live
request/response capture or breakpoint debugging on a running app, see `@saptools/cf-live-trace`
and `@saptools/cf-inspector` instead — `cf-otel` picks up after a trace has already been
exported, to find the real bottleneck in it.

## Install

```bash
npm install -g @saptools/cf-otel
```

## Updates

Every command first checks npm for a newer `@saptools/cf-otel` (at most once an hour, one small request
with a 2-second timeout) and, when one exists, installs that exact version with the package manager
that owns the running binary and re-runs the command you typed on the new version. Both steps are
announced on stderr; nothing is printed when the install is already current:

```text
cf-otel: updating 0.2.0 -> 0.3.0 ...
cf-otel: updated to 0.3.0; re-running the command
```

If the install cannot complete, one stderr line gives the manual command and the command runs on the
installed version; that version is not retried for a day. `cf-otel self-update` forces the check and
install now; `cf-otel self-update --check` only reports.

| Control | Effect |
| --- | --- |
| `SAPTOOLS_AUTO_UPDATE=on\|notify\|off` | `on` (default) installs and re-runs; `notify` prints the manual command once per version; `off` never checks. Applies to every `@saptools` CLI. |
| `CF_OTEL_AUTO_UPDATE` | same values, this CLI only; wins over the global variable |
| `SAPTOOLS_UPDATE_INTERVAL_MINUTES` | minutes between checks (default `60`; `0` checks on every run) |
| `SAPTOOLS_NPM_REGISTRY` | registry to check and install from (default: npm's configured registry, then npmjs) |
| `SAPTOOLS_UPDATE_DEBUG=1` | explain on stderr why nothing happened |

The updater switches itself off in CI (`CI` set), under `NODE_ENV=test` or `NO_UPDATE_NOTIFIER`, when
the binary runs from a source checkout, an `npm link` or an `npx` cache, and inside the re-run itself.
It never writes to stdout, never asks for input, never uses `sudo`, and never moves onto a prerelease.
Its state lives in `~/.saptools/updates/`.

## Auth

Every command reads `SAP_EMAIL` / `SAP_PASSWORD` from the environment for the underlying
`cf api` / `cf auth` / `cf target` login — never pass them as flags. There is no separate
login step: each command is a complete, one-shot operation.

```bash
export SAP_EMAIL=you@example.com
export SAP_PASSWORD=your-password
```

## Targeting

Pass `--region`, `--org`, and `--space` explicitly, or omit any of them to fall back to the
currently targeted `cf target` session. Whichever way it resolves, the CLI prints a one-line
notice to stderr naming the resolved target:

```
cf-otel: target eu10/example-org/space-demo (resolved from ambient 'cf target'; pass --region/--org/--space to pin)
```

`--service <name>` is a plain query filter on `serviceName` — it never targets or connects to
a running app the way `cf-inspector`/`cf-hana` do.

## Credential discovery

Reaching OpenSearch requires a Cloud Logging **dashboards** basic-auth credential, which is
harder to get than it sounds once SAML is enabled on the instance's dashboards (a known,
current SAP gap: new bindings and service keys on a SAML-enabled instance stop returning a
username/password, only an endpoint). `cf-otel` tries, in order:

1. Existing service keys on the instance (`--service-instance`, `--service-key`, repeatable).
2. A pre-existing app binding created before SAML was enabled (`--fallback-binding-app`,
   repeatable) — such a binding keeps its original basic-auth credential forever.
3. Only behind `--allow-mint-credential`: temporarily disable SAML, mint a new key, restore
   SAML immediately after. This is disruptive (breaks SSO dashboards login for everyone during
   the window) and is never attempted by default. If the minted key turns out to be unusable, it
   is deleted again once SAML has been restored, so a retry never leaves a trail of `cf-otel-*`
   keys on the instance; when the deletion itself fails, the error names the key and the exact
   `cf delete-service-key` command to run.

Both service-key payload shapes are read: the fields nested under `credentials`, which is what
CF CLI v8 prints, and the flat fields v7 printed. The same applies to `cf service-keys`, whose
table gained two columns in v8.

Pass `--verbose` to see exactly which step succeeded and why. If every step fails, the error
names every key and binding that was tried.

## Commands

| Command | Purpose |
| --- | --- |
| `sample` | Dump the N most recent full documents, unfiltered — start here when you know nothing yet. |
| `mapping` | Field-type discovery (`keyword` vs `text`) before aggregating on any field. |
| `find` | Locate trace(s) matching a service/name/time/attribute filter, or resolve one request id from a log row. |
| `top` | Outlier hunting across a time range without a starting traceId. |
| `count` | Fast existence/frequency check — the trust-but-verify companion to `selftime`. |
| `spans <traceId>` | Fetch every span in one trace, paginated past 10000 automatically. |
| `span <traceId> [spanId]` | Fetch one span's full, unfiltered document, by ID or by name/kind. |
| `fields <traceId> [spanId]` | List every flat attribute key on a sample span. |
| `selftime <traceId>` | Rank spans by self-time descending — the core, highest-value command. |
| `gaps <traceId> <spanId>` | Analyze timing gaps between one parent span's direct children. |
| `detached <traceId>` | Find likely detached/orphaned trace continuations in the same window. |
| `diff <traceIdA> <traceIdB>` | Compare two traces' self-time breakdowns before/after a fix. |
| `result show\|list\|prune\|clear` | Inspect results saved via `--save`. |

Every command supports `--format table|json|json-compact|csv` (default `table`); most support
`--save`, which prints `ref=<id>` instead of the result and stores it under
`~/.saptools/cf-otel/results/<ref>/` for later inspection with `cf-otel result show <ref>`.

### Saved results

A saved result is kept for **7 days**, then removed by the next `cf-otel` command that touches the
store (or immediately by `cf-otel result prune`). Nothing else expires it and nothing caps how many
accumulate, so `result list` is worth checking if you save often; `result clear` removes them all.
Files are written 0600 inside 0700 directories.

Pruning only ever removes a result that has expired, or a ref directory it has verified is empty. One whose manifest cannot be read — a permission
error, a partial write, or a format a newer `cf-otel` wrote — is deliberately left on disk and
reported by `result prune` on stderr, so a downgrade or a stale global install cannot destroy saved
results it merely fails to understand. `result show` says which of those happened rather than
reporting a readable file as missing.

`--save` checks that the store is writable while it validates the rest of the arguments, so a broken
store costs milliseconds instead of a full credential discovery. If the save fails anyway — a full
disk, or a result past the per-result byte cap — the rows are printed in the requested `--format`
with a diagnostic on stderr and the exit code is non-zero, rather than a completed query being
thrown away. Scripts of the shape `ref=$(cf-otel find --save …)` therefore fail loudly instead of
binding a table row as if it were a ref.

### Attribute filters

`--attr <key><op><value>` (repeatable) supports `>=`, `<=`, `>`, `<`, `=` and `~` (contains). A bare
key is resolved against `span.attributes.` and then `resource.attributes.`, so
`--attr 'http@status_code=200'` finds the real field.

`=` matches the **whole** value, in either encoding it may be stored in. An OTel attribute whose
value is an array reaches this index as the JSON array *rendered to text* — the stored keyword for
an HTTP request header is literally `["0f386888-da32-42b2-7c48-c6200a2894fa"]`, brackets and quotes
included, and the whole `span.attributes.http@request@header@*` family (46 fields) is like this. `=`
sends both forms, so you write the plain value and it matches either way. The array form is never
sent at a numeric, date or ip field, where an unparseable extra term would fail the whole search
rather than merely not match.

Two limits worth knowing. `~` compiles to a leading-wildcard scan over every backing index, so
prefer `=` where it will do. Matching is case-sensitive, and stored ids are lower-case hex — the
`--vcap-request-id` flag folds case for you, `--attr` does not. And every attribute field has an `ignore_above` ceiling that varies by
field (256 to 2048 on a real tenant): a longer value is kept in `_source` but never indexed, so no
operator can find it. Check a specific field with `cf-otel mapping --field <name>`.

### Joining a log row to a trace

`@saptools/cf-logs` reports two identifiers on every parsed row, and only one of them can pin a
trace:

| cf-logs field | span attribute | Grain |
| --- | --- | --- |
| `vcapRequestId` | `span.attributes.http@request@header@x-vcap-request-id` | **One trace.** Measured 1:1 over 1,504 server spans |
| `correlationId` | `span.attributes.http@request@header@x-correlation-id` | One business transaction — a single value has been measured covering 6,796 traces over a full retention window. Read it from a full `cf-logs snapshot --json`; compact rows do not carry it |

Pass the hop id straight through. It needs neither `--service` nor `--since`, because the value is
unique across the whole retention window — and the trace it finds often has its root in a
*different* service than the one that served the request:

```bash
cf-logs snapshot --app demo-app --compact --json | jq -r '.rows[] | select(.vcapRequestId) | .vcapRequestId'
cf-otel find --vcap-request-id <id>
cf-otel selftime <traceId>
```

A log line is queryable before its trace is. Spans reach the index a few seconds behind the request
(measured at 6-10s on a live tenant), so running the lookup the instant a row appears can report
`(no rows)` for a trace that does exist. Wait and retry before concluding the id is wrong.

These headers are captured at ingress, so they exist only on `SPAN_KIND_SERVER` spans — find one
with `cf-otel span <traceId> --name '*' --kind SPAN_KIND_SERVER`. To go the other way, from a span
back to its logs, read the id off that span and pass it to
`cf-logs snapshot --app <app> --search <id>`. Strip the brackets and quotes first: `span` prints the
raw stored value, so the id shows as `["<id>"]` and pasting that verbatim matches nothing.

### Time bounds

`find`, `top`, `count` and `sample` take `--since`/`--until`, each accepting either a relative
duration — `30m`, `24h`, `7d`, units `s`/`m`/`h`/`d` — or an absolute ISO-8601 timestamp such as
`2026-08-28T03:00:00Z`. A date alone (`2026-08-28`), a `±HH:MM` offset, and fractional seconds of any
width are all accepted; nanosecond precision is passed through untouched, since `startTime` is a
`date_nanos` field.

Anything else is rejected before the CF login runs, so a typo costs milliseconds rather than a full
credential discovery. A bare number is rejected too: `--since 24` reads just as easily as a `24h`
missing its unit as it does epoch milliseconds, and the two are decades apart. A `--since` that
resolves later than its `--until` is also rejected, because an inverted range would otherwise return
zero rows indistinguishably from "no data".

`top` and `count` have no default bound, so omitting `--since` scans the whole retention window —
around 5.4M spans on a busy tenant versus ~11k for the last hour. Pass one.

One limit is not checked locally: `startTime` is `date_nanos`, which stores non-negative nanoseconds
since the epoch, so a bound before `1970-01-01` (or at/after roughly `2262-04-11`) is rejected by
OpenSearch itself rather than by cf-otel, and currently surfaces as a raw HTTP 400. Its `reason` field
does say so plainly. Use `1970-01-01` when you mean "everything".

### Request timeouts

Each Dashboards console-proxy request gets 60 seconds, overridable with
`CF_OTEL_HTTP_TIMEOUT_MS`. The ceiling is per request, so a paginated `spans` fetch of 50 pages is
allowed 50 × the value. A malformed override is ignored rather than fatal. This exists to stop an
endpoint that accepts the connection and never answers; raise it if a genuinely wide aggregation
needs longer.

See `.skills/cf-otel/SKILL.md` (or the installed `~/.claude/skills/cf-otel/SKILL.md`) for the
full command reference with worked examples.

## Example

```bash
cf-otel selftime 1c870cd78e4e88e89c3bca8ee76867ea --top 5
```

```
Root span: cds.spawn - run task  (duration: 118.203s)
Clamped spans (children-sum > own duration): 0

NAME                                        COUNT  SELF_TOTAL  SELF_AVG   PCT_OF_ROOT
POST                                        178    60.56s      340.2ms    51.23%
HEAD                                        176    40.64s      230.9ms    34.38%
```

## Development

```bash
pnpm --filter @saptools/cf-otel lint
pnpm --filter @saptools/cf-otel typecheck
pnpm --filter @saptools/cf-otel test:unit
pnpm --filter @saptools/cf-otel test:e2e
pnpm --filter @saptools/cf-otel build
```

Unit tests mock the OpenSearch console-proxy and `cf` CLI layers directly; e2e tests spawn the
built CLI against a fake `cf` binary and an in-memory fake OpenSearch Dashboards console-proxy
server — no real network or SAP credentials are used in either suite.
