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
   the window) and is never attempted by default.

Pass `--verbose` to see exactly which step succeeded and why. If every step fails, the error
names every key and binding that was tried.

## Commands

| Command | Purpose |
| --- | --- |
| `sample` | Dump the N most recent full documents, unfiltered — start here when you know nothing yet. |
| `mapping` | Field-type discovery (`keyword` vs `text`) before aggregating on any field. |
| `find` | Locate trace(s) matching a service/name/time/attribute filter. |
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
