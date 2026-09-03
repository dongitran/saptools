# @saptools/cf-hana

> Run SQL directly against SAP HANA Cloud databases bound to a Cloud Foundry app — addressed by a `region/org/space/app` selector.

`@saptools/cf-hana` opens live SAP HANA Cloud connections from Cloud Foundry app
bindings. Pass a selector, get a connected, pooled client, and run `SELECT` /
`INSERT` / `UPDATE` / `DELETE` / DDL. Bare app names use your active `cf target`
and current CF session first, so a healthy local CF login does not require SAP
password re-authentication.

## Features

- **Selector-based connect** — `region/org/space/app` or a bare app name.
- **Visible target provenance** — every connecting CLI command confirms the
  resolved selector on stderr and labels ambient versus explicit targeting.
- **Credentials, handled for you** — HANA bindings are read live from Cloud Foundry.
  Bare app names use the current CF session first; explicit selectors use isolated live authentication.
- **Parameterized queries** — values always travel as bound `?` parameters, never
  string-concatenated.
- **Connection pooling** — pooled, reused connections; opt out with `pool: false`.
- **Transactions** — `transaction(work)` commits on success, rolls back on throw.
- **Query-builder shorthands** — `selectFrom`, `count`, `insertInto`, `update`,
  `deleteFrom` — query a table by name without writing SQL.
- **Schema introspection** — list schemas, tables, and columns.
- **Table-name recovery** — failed CLI queries for missing tables/views show nearby schema-local suggestions on stderr.
- **Privilege recovery** — HANA error 258 identifies the active schema,
  technical user, binding, and any sibling bindings worth trying explicitly.
- **Local SQL history** — direct SQL calls are appended to dated JSONL files
  under `~/.saptools/cf-hana/histories/` with five-day retention.
- **Write backups** — CLI `UPDATE`, `UPSERT`, `REPLACE`, matched `MERGE`, and
  `DELETE` statements preserve pre-image rows before the write runs.
- **Compact CLI results** — CLI `SELECT`/`WITH` output is compact CSV with
  bounded cells; truncated exact values are retained automatically for follow-up inspection.
- **Lossless CLI formats** — `query --format table|json|json-compact|csv`
  provides exact cell values without changing the compact-CSV default.
- **Safety guard** — opt-in read-only mode and a destructive-statement guard
  (blocks destructive DDL, unscoped `UPDATE`/`DELETE`, and unconditional matched deletes).
- **Typed results** — `query<TRow>()` returns typed rows.
- **CLI + API** — a `cf-hana` CLI and an ergonomic TypeScript API.

## Installation

```bash
npm install @saptools/cf-hana
# or, for the CLI
npm install -g @saptools/cf-hana
```

Requires Node.js >= 20. The pure-JavaScript [`hdb`](https://github.com/SAP/node-hdb)
driver is bundled as a dependency — there is no native build step.

## Updates

Every command first checks npm for a newer `@saptools/cf-hana` (at most once an hour, one small request
with a 2-second timeout) and, when one exists, installs that exact version with the package manager
that owns the running binary and re-runs the command you typed on the new version. Both steps are
announced on stderr; nothing is printed when the install is already current:

```text
cf-hana: updating 0.6.0 -> 0.7.0 ...
cf-hana: updated to 0.7.0; re-running the command
```

If the install cannot complete, one stderr line gives the manual command and the command runs on the
installed version; that version is not retried for a day. `cf-hana self-update` forces the check and
install now; `cf-hana self-update --check` only reports.

| Control | Effect |
| --- | --- |
| `SAPTOOLS_AUTO_UPDATE=on\|notify\|off` | `on` (default) installs and re-runs; `notify` prints the manual command once per version; `off` never checks. Applies to every `@saptools` CLI. |
| `CF_HANA_AUTO_UPDATE` | same values, this CLI only; wins over the global variable |
| `SAPTOOLS_UPDATE_INTERVAL_MINUTES` | minutes between checks (default `60`; `0` checks on every run) |
| `SAPTOOLS_NPM_REGISTRY` | registry to check and install from (default: npm's configured registry, then npmjs) |
| `SAPTOOLS_UPDATE_DEBUG=1` | explain on stderr why nothing happened |

The updater switches itself off in CI (`CI` set), under `NODE_ENV=test` or `NO_UPDATE_NOTIFIER`, when
the binary runs from a source checkout, an `npm link` or an `npx` cache, and inside the re-run itself.
It never writes to stdout, never asks for input, never uses `sudo`, and never moves onto a prerelease.
Its state lives in `~/.saptools/updates/`.

## Quick start

```ts
import { connect, query } from "@saptools/cf-hana";

// Open a reusable, pooled client for one CF app's HANA database.
const db = await connect("eu10/example-org/space-demo/app-demo");

const open = await db.query("SELECT ID, STATUS FROM ORDERS WHERE STATUS = ?", ["OPEN"]);
console.log(open.rows);

const total = await db.count({ schema: "ORDERS_APP", table: "ORDERS", where: { STATUS: "OPEN" } });

await db.transaction(async (tx) => {
  await tx.execute("UPDATE ORDERS SET STATUS = ? WHERE ID = ?", ["SHIPPED", 42]);
});

await db.close();

// One-shot: connect, run one query, close.
const rows = await query("app-demo", "SELECT COUNT(*) AS N FROM ORDERS");
```

## The selector

Every entry point takes a selector as its first argument:

- **Explicit** — `region/org/space/app` (e.g.
  `eu10/example-org/space-demo/app-demo`). Works without any cached topology.
- **Bare app name** — `app-demo`. Resolved only against the active `cf target`
  (current org/space/API endpoint) and fetched with `cf env app-demo` using your
  existing CF session before any isolated re-auth fallback.

Every connecting CLI command prints the resolved selector to stderr. A bare
selector is labeled as inherited from ambient `cf target`; an explicit selector
is labeled as pinned. For the direct bare-app path, cf-hana verifies the app,
API, org, and space embedded in the same `VCAP_APPLICATION` payload as the
bindings, then reads `cf target` again. Missing or mismatched identity, including
an A-to-B-to-A target race, is refused before a database connection is opened.
If the ambient API cannot be mapped to a supported region, the notice says the
region is unconfirmed instead of presenting `current/...` as a usable pin.

## CLI

```
cf-hana query   <selector> <sql>            Run a single SQL statement
cf-hana tables  <selector> [schema]         List tables in a schema
cf-hana columns <selector> <schema.table>   List the columns of a table
cf-hana count   <selector> <schema.table>   Count rows in a table
cf-hana ping    <selector>                  Connect and measure round-trip latency
cf-hana info    <selector>                  Print the resolved connection metadata
cf-hana result  <command>                   Inspect saved query refs
```

Common options: `--refresh` (deprecated compatibility flag; binding discovery is already live), `--role <runtime|hdi>`, `--binding <name>` /
`--binding-index <n>`, `--timeout <ms>`, `--read-only`, `--allow-destructive`,
`--limit <n>`, `--no-auto-limit`, `--tunnel`, `--refresh-tunnel` (see
[Connectivity fallback](#connectivity-fallback)). The `query` command also accepts
`--param <value>` (repeatable), `--cell-limit <n>`, `--save`, `--no-auto-save`,
`--format <table|json|json-compact|csv>`, `--result-ttl-minutes <n>`, and
`--refresh-metadata`. `tables` and `columns` support the same four format values.
CLI `UPDATE`, `UPSERT`, `REPLACE`, matched `MERGE`, and `DELETE` statements are
backed up automatically before the write runs.

```bash
cf-hana query eu10/example-org/space-demo/app-demo "SELECT ID, STATUS FROM ORDERS WHERE STATUS = ?" \
  --param OPEN --read-only --save
cf-hana query app-demo "UPDATE ORDERS SET STATUS = ? WHERE ID = ?" \
  --param DONE --param 42
cf-hana tables app-demo
cf-hana columns app-demo ORDERS_APP.ORDERS
cf-hana ping eu10/example-org/space-demo/app-demo
```

## Output formats and schemas

With no `query --format`, successful `SELECT`/`WITH` output remains compact CSV
for backward compatibility. An explicit format is lossless at the cell level:

- `query --format json` returns `[{COLUMN: value, ...}]`.
- `query --format json-compact` returns `[value, ...]` for a single-column
  projection and falls back to row objects for multiple columns.
- `query --format csv` returns lossless RFC 4180 CSV.
- `query --format table` returns a lossless aligned table.
- `tables --format json` returns `[{SCHEMA,TABLE,TYPE}]`; its `json-compact`
  mode returns `[TABLE, ...]`.
- `columns --format json` returns
  `[{COLUMN,TYPE,LENGTH,NULLABLE,POSITION}]`; its `json-compact` mode returns
  `[COLUMN, ...]`.

The existing uppercase catalog keys are unchanged. Query formats are available
only for `SELECT`/`WITH`. `--save` cannot be combined with `--format`, which
keeps JSON and CSV stdout valid machine output. The automatic row cap still
applies unless changed with `--limit` or `--no-auto-limit`.

## Compact query output and saved refs

For CLI `SELECT` and `WITH` statements, stdout is CSV. Bare reads return at most
100 rows by default; pass `--limit <n>` to request more, or `--no-auto-limit` to
disable the automatic cap. Data cells display at most 128 Unicode characters by
default; pass `--cell-limit <n>` to choose a value from 1 through 10,000.

When compact output actually shortens one or more cells, cf-hana automatically
saves the exact returned rows and prints a concrete `result show` command with
the generated ref to stderr. This does not add a `ref=` line to stdout. Disable
implicit retention with `--no-auto-save`. If an implicit save exceeds the
256 MiB store ceiling or local storage is unavailable, the query still succeeds
and the hint recommends `--save` or a larger `--cell-limit`.

Use explicit `--save` when you want a ref regardless of whether cells are shortened:

```bash
cf-hana query app-demo "SELECT ID, CONTENT FROM ORDERS" --read-only --save
```

Saved output starts with a control line, then CSV:

```text
ref=q7f3a9c2b
ID,CONTENT
1,first 128 visible characters
```

The ref is not a CSV column. Exact returned rows are stored under
`~/.saptools/cf-hana/results/` for 7 days by default. Only returned rows are
stored; rows beyond the selected `--limit` are not fetched or saved.

Follow-up commands:

```bash
cf-hana result show q7f3a9c2b
cf-hana result show q7f3a9c2b --row 1
cf-hana result show q7f3a9c2b --row 1 --column CONTENT --length 1000
cf-hana result show q7f3a9c2b --row 1 --column PAYLOAD --path /items/0
cf-hana result search q7f3a9c2b "ready"
cf-hana result export q7f3a9c2b --row 1 --column CONTENT --output content.txt
cf-hana result list
cf-hana result prune
cf-hana result clear
```

`--save` is available only for `SELECT` and `WITH` statements and remains a
hard failure if the result cannot be stored. The programmatic API keeps
returning full-fidelity `QueryResult` values and does not write result refs.


### Saved results

A saved result is kept for **7 days**, then removed by the next `cf-hana` command that touches the
store (or immediately by `cf-hana result prune`). Nothing else expires it and nothing caps how many
accumulate. Files are written 0600 inside 0700 directories.

Pruning only ever removes a result that has expired, or a ref directory it has verified is empty. One this version cannot read — a permission
error, a partial write, or a format a newer `cf-hana` wrote — is deliberately left on disk and
reported by `cf-hana result prune` on stderr, so a downgrade or a stale global install cannot destroy
saved results it merely fails to understand. `cf-hana result show` says which of those happened
rather than reporting a readable file as missing.

The trade-off is that a result this version cannot read is then kept indefinitely: no TTL reaches it,
and the only way to reclaim it today is `cf-hana result clear`, which removes every saved result it can see — it does not reclaim a leftover `<ref>.tmp-<pid>` directory from an interrupted save.

## Insufficient-privilege guidance

When HANA reports error code 258, or the equivalent `insufficient privilege`
message without a numeric code, cf-hana keeps the original failure and exit
status and adds a stderr hint. The hint identifies the schema, role-selected
technical user, current binding, and other named HANA bindings already found on
the app. It suggests an explicit `--binding <name>` or another app/full
selector. It never retries the SQL automatically under another database user.

## Invalid table/view suggestions and metadata cache

When `cf-hana query` fails with a likely HANA invalid table, view, or catalog
object error, the CLI keeps stdout empty/parseable and prints the original error
plus a small `Did you mean:` list to stderr. Suggestions are based on objects in
the active connection schema and include physical tables from `SYS.TABLES` and
views from `SYS.VIEWS`; `tables` output remains table-only for compatibility.

To avoid repeatedly reading catalog metadata after typo failures, cf-hana stores
only schema, object name, and object type under:

```text
~/.saptools/cf-hana/metadata/
```

Metadata cache files are private (`0700` directories, `0600` files), written
atomically, and expire after exactly 30 minutes. The cache key is derived from
non-secret connection identity: selector, app name, host, active schema, role,
driver, and selected binding name/index. It does not include passwords,
certificates, tokens, SQL parameter values, result rows, or table data, and
malformed cache files are treated as
misses. Pass `--refresh-metadata` to bypass this cache for a query. The legacy
`--refresh` flag is accepted for compatibility but does not bypass the metadata
cache and is not a credential-cache control because binding discovery is already
live. If metadata lookup or cache I/O fails, cf-hana preserves the original
query error and simply omits suggestions.

## Programmatic API

| Export | Purpose |
| --- | --- |
| `connect(selector, options?)` | Open a reusable, pooled `HanaClient`. |
| `query(selector, sql, params?, options?)` | One-shot: connect, query, close. |
| `withConnection(selector, work, options?)` | Run `work` with a client that auto-closes. |
| `HanaClient` | `query`, `execute`, `backupWriteStatement`, `selectFrom`, `count`, `insertInto`, `update`, `deleteFrom`, `transaction`, `listSchemas`, `listTables`, `listCatalogObjects`, `listColumns`, `explain`, `close`. |
| `createDriver`, `formatResult`, `build*` | Lower-level building blocks. |

`ConnectOptions` highlights: `role` (`runtime` | `hdi`), `bindingName` /
`bindingIndex`, `readOnly`, `allowDestructive`, `autoLimit`, `queryTimeoutMs`,
`connectTimeoutMs`, deprecated `refresh`, `pool`.

`HanaClient.info` additively exposes optional target and binding provenance for
programmatic checks: `selectorSource`, `regionConfirmed`,
`selectorCanBePinned`, `bindingName`, `bindingIndex`, and
`availableBindingNames`. Library connections remain silent; only the CLI writes
the resolved-target notice to stderr.

## Credentials

Credential discovery is **live-only** and does not read `@saptools/cf-sync`
snapshots or `~/.saptools/cf-db-bindings.json`.

- Bare app selectors (`app-demo`) read the active `cf target`, preserve its exact
  validated API endpoint, and first run `cf env app-demo` with your current CF
  session. This path does not require `SAP_EMAIL` or `SAP_PASSWORD` while the
  current session is healthy.
- A successful direct `cf env` is accepted only if a second `cf target` read
  confirms the same API endpoint, org, and space.
- If that direct bare-app call fails with an auth/session error, cf-hana falls
  back to an isolated temporary `CF_HOME`, runs `cf api <current-endpoint>`,
  authenticates with `SAP_EMAIL` / `SAP_PASSWORD` (or the programmatic `email` /
  `password` options), targets the current org/space, and reads `cf env`.
- Explicit `region/org/space/app` selectors always use isolated live
  authentication. Region keys support current SAP CF technical keys, including
  indexed regions such as `eu10-005`, `eu20-001`, `us10-002`, and China
  endpoints such as `cn40` on `platform.sapcloud.cn`.

The legacy `refresh` / `--refresh` option is retained only for compatibility and
has no credential-cache meaning; binding discovery is already live. Use
`--refresh-metadata` when you specifically want to bypass the table/view
suggestion metadata cache. Credential resolution writes no binding credentials
under `~/.saptools/`.

Cloud Foundry shell-outs use 60-second bounded timeouts and retry transient
timeout/network failures. HANA connection and query timeout defaults are also
60 seconds unless overridden with `--timeout` or API options.

## SQL history

Successful direct SQL calls are appended to daily JSONL files:

```text
~/.saptools/cf-hana/histories/YYYY-MM-DD.jsonl
```

Each entry includes the timestamp, package version, selector, app name, schema,
role, operation (`query` or `execute`), statement kind, SQL text, parameter
count, row count, truncation flag, and elapsed time. Parameter values,
credentials, certificates, and result rows are not stored.

History retention runs opportunistically after each append and deletes dated
history files older than five days. Helper-driven catalog SQL such as `tables`,
`columns`, and table/view suggestion metadata reads is not recorded as user SQL
history.

## Write backups

When `cf-hana query` receives a supported write, it first builds and runs a
pre-image `SELECT`:

- `UPDATE <target> SET ... WHERE ...` becomes
  `SELECT * FROM <target> WHERE ...`.
- `UPSERT <target> VALUES ... WHERE ...` becomes
  `SELECT * FROM <target> WHERE ...`.
- `REPLACE` follows the same plan as its HANA `UPSERT` synonym.
- A reliably parsed matched `MERGE INTO` uses a correlated `EXISTS` query for
  the matched target rows. If the target is unambiguous but an exact matched set
  is not, cf-hana backs up the whole target table.
- `DELETE FROM <target> WHERE ...` becomes
  `SELECT * FROM <target> WHERE ...`.

UPSERT/REPLACE subquery forms use a conservative whole-target pre-image.
Insert-only MERGE statements need no pre-image. For the supported write forms
above, cf-hana refuses execution if it cannot identify a trustworthy target,
derive a safe pre-image, preserve the backup within the 256 MiB ceiling, or
write the backup files. This refusal cannot be overridden with
`--allow-destructive`.

The backup is saved before the write runs:

```text
~/.saptools/cf-hana/backups/YYYYMM/
  <region-org-space-app>-<operation>-<timestamp>.sql
  <region-org-space-app>-<operation>-<timestamp>.statement.sql
  <region-org-space-app>-<operation>-<timestamp>.json
```

The main `.sql` backup file contains CSV-formatted rows returned by the derived
`SELECT`, matching the requested region/org/space/app/action/timestamp naming
shape. The companion `.statement.sql` file contains the original write statement,
and `.json` contains non-secret metadata for auditability. Backup files are not
deleted by `cf-hana`; clean them up manually when they are no longer needed. The
backup path is printed to stderr so stdout remains parseable.
Backup directories use mode `0700`; statement, CSV, and metadata files use
mode `0600`.

## Safety

- **Read-only mode** (`readOnly` / `--read-only`) rejects every DML and DDL statement.
- **Destructive guard** blocks `DROP` / `TRUNCATE` / `ALTER` and `UPDATE` / `DELETE`
  without a top-level `WHERE`, plus unconditional matched `MERGE DELETE`, unless
  `allowDestructive` / `--allow-destructive` is set.
- **Single statement per call** is an enforced, guarded property: a SQL
  argument containing more than one genuine top-level statement (separated
  by a real, non-quoted, non-commented `;`) is refused unconditionally — not
  overridable by `--allow-destructive` or `--read-only`. `CREATE PROCEDURE`/
  `FUNCTION`/`TRIGGER` definitions and `DO` anonymous blocks are exempted
  when chained back to back, since their `BEGIN`/`END` bodies legitimately
  contain internal semicolons — but each chunk's own header (its name, then
  everything up to its first `BEGIN`) must contain no top-level `;` and no
  keyword, from a fixed disqualifying set, that could lead an independent
  statement, and its body's `BEGIN`/`END` nesting must genuinely balance and
  reach either the true end of the input or the start of another such
  definition. A reordered or partial `BEGIN`/`END`, a statement skipped
  over on the way to a later `BEGIN`, and content appended after a real
  body's own `END` (whether trailing the last definition or sandwiched
  between two), are all refused; only chaining several independently
  well-formed definitions back to back is allowed.
  **Known, narrow limitations** (see CHANGELOG for full detail): a
  `TRIGGER` header may legitimately reference `INSERT`/`UPDATE`/`DELETE` as
  its own event keywords (`BEFORE INSERT`, `AFTER UPDATE`, ...), so those
  three are not disqualifying specifically for `TRIGGER`; a chunk disguised
  as `CREATE TRIGGER`, chained after a separate legitimate definition,
  referencing one of them with no `BEFORE`/`AFTER`/`INSTEAD OF` prefix at
  all is not caught by this check. Separately, the disqualifying keyword
  set is a fixed list (not every keyword that could lead a dangerous
  statement in general — `GRANT`/`REVOKE` are notable omissions); this is
  not specific to the carve-out, since a bare, semicolon-free statement
  leading with any keyword this guard's classifier does not recognize is
  already treated as non-destructive regardless of any routine/trigger
  wrapper.
- **Auto-limit** appends a `LIMIT` to bare `SELECT` statements (default 100);
  `QueryResult.truncated` reports when it clipped the result. Disable with
  `autoLimit: false` / `--no-auto-limit`.

The guard is a convenience, not a security control: always pass values as bound
parameters.

## Connectivity fallback

HANA Cloud instances are frequently IP-allowlisted to only accept connections
from inside the same Cloud Foundry landscape. When a direct connection fails
in a way that means the initial socket could never be established — not an
authentication, privilege, or query failure — `cf-hana` can retry through an
SSH port-forward opened via `cf ssh` against another app in the same org/space,
which usually can reach the host even when your machine cannot.

- **`auto` (default)**: tries the direct connection first, with zero added
  behavior when it succeeds. Only a classified connectivity failure triggers
  the fallback: discover a jump-host app (the target app itself, then a few
  other started apps via `cf apps`), open a local port-forward, and retry
  through `127.0.0.1`.
- **`--tunnel`**: skips the direct attempt and connects via a tunnel
  immediately — for a host already known to be unreachable directly, so you
  are not paying the connect-timeout cost (up to 60s) on every invocation.
- **`--refresh-tunnel`**: bypasses a cached/live tunnel and forces a fresh
  establishment attempt.

There is deliberately no flag to disable this capability: a tunnel attempt
only ever engages after a direct failure (or when explicitly requested via
`--tunnel`), and on total failure it rethrows the original connection error
unchanged, so it can only help or no-op.

The live tunnel is reused — both across every connection this CLI's own pool
opens in one invocation, and across separate `cf-hana` invocations run in a
row against the same host (this CLI's realistic dominant usage pattern, e.g.
an AI agent running several queries back to back) — instead of re-negotiating
SSH on every single command. State lives at `~/.saptools/cf-hana/tunnel/`
(mode `0700`/`0600`, no credentials). A cached tunnel is closed immediately,
regardless of its remaining lifetime, the moment a later invocation targets a
different Cloud Foundry org — a different client's landscape never keeps an
unattended live SSH path open just because its keepalive has not lapsed.

In the worst case (a silently-dropping network path, so the direct attempt
runs its full connect timeout, and no candidate app works either), `auto`
mode takes roughly 15s (direct, capped once a tunnel fallback is available —
see below) + 25s (tunnel budget) ≈ 40s before surfacing a final error —
bounded and predictable, not open-ended. Use `--tunnel` to skip the direct
cost entirely for a host you already know is unreachable.

Whenever a tunnel fallback is available at all (`auto` mode, the default),
the direct attempt's own timeout is capped at the tunnel side's own
per-candidate ceiling (15s by default) even if a longer timeout is
configured — a silently-hanging (rather than actively refused) direct
connection would otherwise consume its entire configured timeout before the
tunnel path got a chance at all. This only ever shortens an
otherwise-hanging attempt; it never affects a host that refuses quickly, or
a configured timeout that is already shorter.

`cf-hana` also disables SAP HANA Cloud's reactive mid-auth redirect (used
for per-node/pod locality routing) on every connection, direct or tunneled:
without this, a multi-node HANA Cloud instance can redirect an
already-established connection to a different internal hostname that isn't
reachable outside SAP's own network, silently abandoning a working SSH
tunnel for a fresh, untunneled connection that fails for the same reason the
original direct connection did. The original bound host is always a real,
working endpoint for your binding, so this has no effect on which schema,
user, or data you reach.

### Known limitations

- **Cross-org reaper and concurrent processes.** Every connection attempt
  closes any cached tunnel tagged for a different Cloud Foundry org than the
  current target, regardless of remaining lifetime — intentional hygiene so
  switching orgs never leaves a stale tunnel open. On a shared machine, this
  can also close another, unrelated, concurrently-running invocation's
  active tunnel to a different org; there is no portable, low-cost way to
  detect "is this port actively in use by someone else" from outside that
  TCP session.
- **Stale-tunnel reaping trusts the recorded pid.** The reaper terminates a
  dead or expired tunnel's process by its recorded pid, with no additional
  identity check (e.g. confirming the pid still refers to a `cf ssh`
  process). On a long-uptime machine, pid reuse could in principle target an
  unrelated process; this is a narrow race not worth a platform-specific
  check for.
- **Programmatic (non-CLI) pool usage can strand idle connections.** The
  connection pool reuses the most-recently-released idle connection first
  (LIFO); a long-lived process that opens a burst of connections and then
  settles into serial one-at-a-time use can leave earlier connections
  idle-but-unreaped for the pool's lifetime. The CLI itself always drains
  its pool at the end of every command, so this only affects long-lived
  programmatic use of the library.
- **Pre-write backups are never pruned.** Unlike SQL history (5-day
  retention) and saved query results (TTL plus `result prune`/`result
  clear`), files under `~/.saptools/cf-hana/backups/` accumulate
  indefinitely with no retention policy or cleanup command.

## Requirements

- Node.js >= 20.
- A HANA binding reachable from your network. Resolving a bare app name needs the Cloud Foundry CLI and an active `cf target`.
  Isolated fallback or explicit selectors additionally need `SAP_EMAIL` /
  `SAP_PASSWORD`.

## Development

```bash
pnpm --filter @saptools/cf-hana build
pnpm --filter @saptools/cf-hana lint
pnpm --filter @saptools/cf-hana typecheck
pnpm --filter @saptools/cf-hana test:unit
pnpm --filter @saptools/cf-hana test:e2e:fake
```

The live e2e suite (`test:e2e:live`) needs real `SAP_EMAIL` / `SAP_PASSWORD` and
a `CF_HANA_E2E_TARGET` selector pointing at a HANA-bound app.

## License

MIT
