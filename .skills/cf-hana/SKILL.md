---
name: cf-hana
description: Use when a task involves running SQL, inspecting saved query refs, or discovering schemas, tables, and columns in SAP HANA Cloud databases bound to SAP BTP Cloud Foundry apps through the cf-hana CLI. Covers selector/app targeting, binding choice, read-only SELECT workflows, explicit writes, compact or structured output, saved result refs, and local result inspection.
---

# CF HANA

## Purpose

Use `cf-hana` for SQL access to SAP HANA Cloud databases bound to SAP BTP Cloud Foundry apps through a `region/org/space/app` selector. Prefer read-only usage. Run writes such as `UPDATE` only when the user explicitly asks for them.

If `cf-hana` is missing, install it from `@saptools/cf-hana`: `npm install -g @saptools/cf-hana`.

## First Steps

1. Identify whether the user wants SQL data, schema discovery, connectivity debugging, saved-ref inspection, or an explicit write.
2. When the user gives only a bare app name, pass it directly and verify the stderr target notice. The CLI fails closed if `cf env` identity differs from the ambient target. Prefer a full `region/org/space/app` selector for writes. If the tool cannot find an active context, ask for the full selector.
3. Use live HANA access only when current database state is needed and the target plus credentials are available.
4. For `SELECT` or `WITH`, use `--read-only --save` when follow-up inspection is likely, or `--format json` for lossless machine output.
5. With explicit `--save`, treat the first output line as the ref (`ref=q...`) and the remaining output as compact CSV.

## Safe Live Usage

Use only the command that matches the question:

```bash
cf-hana info eu10/example-org/space-demo/app-demo --read-only
cf-hana ping eu10/example-org/space-demo/app-demo --read-only
cf-hana ping app-demo --read-only
```

For user-provided SQL:

- Run `SELECT` or `WITH` with `--read-only`; add `--save` for a reusable ref or
  choose `--format <value>` for lossless stdout, but do not combine them.
- Pass values with repeated `--param <value>` for `?` placeholders.
- Run any DML or DDL write—including `INSERT`, `UPDATE`, `UPSERT`, `REPLACE`,
  `MERGE`, and `DELETE`—only when explicitly requested.
- Do not use `--allow-destructive` unless the user explicitly requests that risk.
- Do not quote sensitive cell values in summaries unless they are necessary for the task.

## Command Choice

Use `query` for reads. Output is compact CSV; default max rows is 100, and default max visible cell text is 128 characters:

```bash
cf-hana query eu10/example-org/space-demo/app-demo "SELECT ID, STATUS FROM ORDERS WHERE STATUS = ?" \
  --param OPEN --read-only --save
```

Use `--limit <n>` to request more than 100 rows. Use `--cell-limit <n>` to change visible cell length, up to 10,000. If compact output truncates cells, the CLI auto-saves exact rows and prints a concrete ref on stderr; use `--no-auto-save` to opt out.

For lossless stdout, use `query --format table|json|json-compact|csv`. Do not combine `--save` with `--format`. `json-compact` returns a flat value array for one query column and row objects otherwise.

Use the saved ref for follow-up inspection:

```bash
cf-hana result show q7f3a9c2b
cf-hana result show q7f3a9c2b --row 1
cf-hana result show q7f3a9c2b --row 1 --column CONTENT --length 1000
cf-hana result show q7f3a9c2b --row 1 --column PAYLOAD --path /items/0
cf-hana result search q7f3a9c2b "ready"
cf-hana result export q7f3a9c2b --row 1 --column CONTENT --output content.txt
```

Use `query` for explicit writes; there is no separate `update` command. Do not pass `--read-only` for writes:

```bash
cf-hana query eu10/example-org/space-demo/app-demo "UPDATE ORDERS SET STATUS = ? WHERE ID = ?" \
  --param CLOSED --param 42
```

The CLI backs up `UPDATE`, `UPSERT`, `REPLACE`, matched `MERGE`, and `DELETE`
pre-images before executing. One of those writes is refused if its required
pre-image cannot be derived or stored, even with `--allow-destructive`.

Use `tables` and `columns` for schema discovery. Use `json-compact` for flat name lists:

```bash
cf-hana tables eu10/example-org/space-demo/app-demo APP_SCHEMA --format json
cf-hana columns eu10/example-org/space-demo/app-demo APP_SCHEMA.ORDERS --format json
cf-hana tables eu10/example-org/space-demo/app-demo APP_SCHEMA --format json-compact
```

Use `count` when only cardinality is needed:

```bash
cf-hana count eu10/example-org/space-demo/app-demo APP_SCHEMA.ORDERS
```

Key options:

- `--refresh`: deprecated compatibility flag; binding discovery is already live. Use `--refresh-metadata` only for the table/view suggestion cache.
- `--role runtime|hdi`: choose the binding user.
- `--binding <name>` or `--binding-index <n>`: disambiguate HANA bindings.
- `--timeout <ms>`: set connection and query timeout.
- `--limit <n>`: request more than the default 100 rows for bare reads.
- `--cell-limit <n>`: change visible cell length for compact CSV.
- `--no-auto-save`: do not retain exact rows when compact output truncates cells.
- `--format table|json|json-compact|csv`: request lossless query output or catalog formats.
- `--result-ttl-minutes <n>`: change explicit or automatic saved-result expiry.
- `--read-only`: block non-read statements.
- `--allow-destructive`: only for explicit user-requested destructive work.

## Troubleshooting

If selector resolution fails for a bare app name (no active context found), ask the user to provide the full `region/org/space/app` selector.

If credentials are missing for explicit selectors or auth fallback, ask for valid SAP credentials in the environment or equivalent secure input; never print those values.

If multiple HANA bindings exist, ask for the intended binding name or index:

```bash
cf-hana info eu10/example-org/space-demo/app-demo --binding <name>
cf-hana info eu10/example-org/space-demo/app-demo --binding-index 0
```

If HANA reports insufficient privilege, use the CLI hint to identify the
current technical user and sibling bindings. Retry with an explicit
`--binding <name>` or another pinned app selector only after choosing it; the
CLI does not retry automatically.

If a query is too broad, add a `WHERE` clause or use `--limit <n>`. Keep `--read-only` enabled unless the user explicitly requests a write.
