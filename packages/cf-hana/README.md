# @saptools/cf-hana

> Run SQL directly against SAP HANA Cloud databases bound to a Cloud Foundry app — addressed by a `region/org/space/app` selector.

`@saptools/cf-hana` opens live SAP HANA Cloud connections from Cloud Foundry app
bindings. Pass a selector, get a connected, pooled client, and run `SELECT` /
`INSERT` / `UPDATE` / `DELETE` / DDL. Bare app names use your active `cf target`
and current CF session first, so a healthy local CF login does not require SAP
password re-authentication.

## Features

- **Selector-based connect** — `region/org/space/app` or a bare app name.
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
- **Local SQL history** — direct SQL calls are appended to dated JSONL files
  under `~/.saptools/cf-hana/histories/` with five-day retention.
- **Write backups** — CLI `UPDATE`, `UPSERT`, and `DELETE` statements create a local CSV
  backup of matching rows before the write runs.
- **Compact CLI results** — CLI `SELECT`/`WITH` output is compact CSV with
  bounded cells and optional saved refs for exact follow-up inspection.
- **Safety guard** — opt-in read-only mode and a destructive-statement guard
  (blocks `DROP`/`TRUNCATE`/`ALTER` and unscoped `UPDATE`/`DELETE`).
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
`--limit <n>`, `--no-auto-limit`. The `query` command also accepts
`--param <value>` (repeatable), `--cell-limit <n>`, `--save`,
`--result-ttl-minutes <n>`, and `--refresh-metadata`. `tables` and `columns` still support
`--format <table|json|csv>`. CLI `UPDATE`, `UPSERT`, and `DELETE` statements are backed up
automatically before the write runs.

```bash
cf-hana query eu10/example-org/space-demo/app-demo "SELECT ID, STATUS FROM ORDERS WHERE STATUS = ?" \
  --param OPEN --read-only --save
cf-hana query app-demo "UPDATE ORDERS SET STATUS = ? WHERE ID = ?" \
  --param DONE --param 42
cf-hana tables app-demo
cf-hana columns app-demo ORDERS_APP.ORDERS
cf-hana ping eu10/example-org/space-demo/app-demo
```

## Compact query output and saved refs

For CLI `SELECT` and `WITH` statements, stdout is CSV. Bare reads return at most
100 rows by default; pass `--limit <n>` to request more, or `--no-auto-limit` to
disable the automatic cap. Data cells display at most 128 Unicode characters by
default; pass `--cell-limit <n>` to choose a value from 1 through 10,000.

Use `--save` when you need exact values later:

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

`--save` is available only for `SELECT` and `WITH` statements. The programmatic
API keeps returning full-fidelity `QueryResult` values and does not write result
refs.

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
and driver. It does not include passwords, certificates, tokens, SQL parameter
values, result rows, or table data, and malformed cache files are treated as
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

## Credentials

Credential discovery is **live-only** and does not read `@saptools/cf-sync`
snapshots or `~/.saptools/cf-db-bindings.json`.

- Bare app selectors (`app-demo`) read the active `cf target`, preserve its exact
  validated API endpoint, and first run `cf env app-demo` with your current CF
  session. This path does not require `SAP_EMAIL` or `SAP_PASSWORD` while the
  current session is healthy.
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

When `cf-hana query` receives an `UPDATE`, `UPSERT`, or `DELETE`, it first builds and runs a
matching `SELECT`:

- `UPDATE <target> SET ... WHERE ...` becomes
  `SELECT * FROM <target> WHERE ...`.
- `UPSERT <target> VALUES ... WHERE ...` becomes
  `SELECT * FROM <target> WHERE ...`.
- `DELETE FROM <target> WHERE ...` becomes
  `SELECT * FROM <target> WHERE ...`.

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

## Safety

- **Read-only mode** (`readOnly` / `--read-only`) rejects every DML and DDL statement.
- **Destructive guard** blocks `DROP` / `TRUNCATE` / `ALTER` and `UPDATE` / `DELETE`
  without a `WHERE` clause unless `allowDestructive` / `--allow-destructive` is set.
- **Auto-limit** appends a `LIMIT` to bare `SELECT` statements (default 100);
  `QueryResult.truncated` reports when it clipped the result. Disable with
  `autoLimit: false` / `--no-auto-limit`.

The guard is a convenience, not a security control: always pass values as bound
parameters.

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
