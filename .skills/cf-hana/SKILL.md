---
name: cf-hana
description: Use when a task involves running SQL statements or inspecting schemas, tables, and columns in SAP HANA Cloud databases bound to SAP BTP Cloud Foundry apps or S/4HANA extension workloads through the cf-hana CLI. Covers selector/app targeting, binding choice, safe SELECT/UPDATE execution, credential handling, and result summarization.
---

# CF HANA

## Purpose

Use the `cf-hana` CLI for SQL access to SAP HANA Cloud databases bound to SAP BTP Cloud Foundry apps, including S/4HANA extension workloads, through a `region/org/space/app` selector. Prefer cache-backed, read-only workflows when gathering evidence; run writes such as `UPDATE` only when the user explicitly asks for them.

## First Steps

1. Identify whether the user wants to run SQL, inspect data, discover schemas/tables/columns, perform an explicit update, or debug access/connectivity.
2. Use live HANA access when the task needs current database state and the target plus credentials are available. Ask only when the target, credentials, or write intent is unclear.
3. Prefer `--read-only` and `--format json` for agent-run commands unless a human-facing table is explicitly useful.

## Safe Live Usage

When the task requires current database evidence, run live `cf-hana` commands directly if the selector and credentials are already available. Use only the check that matches the question:

```bash
# Check target and binding resolution without executing SQL.
cf-hana info eu10/example-org/space-demo/app-demo --read-only --format json

# Check HANA connectivity.
cf-hana ping eu10/example-org/space-demo/app-demo --read-only
```

For user-provided SQL:

- Run `SELECT` or `WITH` statements with `--read-only` by default.
- Run `UPDATE`, `INSERT`, `DELETE`, or DDL only when the user explicitly asks for a write.
- Pass values with repeated `--param <value>` for `?` placeholders.
- Do not use `--allow-destructive` unless the user explicitly requests that risk.
- Avoid persisting command output unless it is needed for the task; redact sensitive rows before summarizing.

## Command Choice

Use `info` to inspect the resolved target without running SQL:

```bash
cf-hana info eu10/example-org/space-demo/app-demo --format json
```

Use `query` for `SELECT` and `WITH` statements. Use JSON for agent parsing and table output for humans:

```bash
cf-hana query eu10/example-org/space-demo/app-demo "SELECT ID, STATUS FROM ORDERS WHERE STATUS = ?" \
  --param OPEN --read-only --format json
```

Use `query` for explicit writes too; there is no separate `update` command. Do not pass `--read-only` for writes:

```bash
cf-hana query eu10/example-org/space-demo/app-demo "UPDATE ORDERS SET STATUS = ? WHERE ID = ?" \
  --param CLOSED --param 42 --format json
```

Use `tables` and `columns` for schema discovery:

```bash
cf-hana tables eu10/example-org/space-demo/app-demo APP_SCHEMA --format json
cf-hana columns eu10/example-org/space-demo/app-demo APP_SCHEMA.ORDERS --format json
```

Use `count` when only cardinality is needed:

```bash
cf-hana count eu10/example-org/space-demo/app-demo APP_SCHEMA.ORDERS
```

Use `ping` for connectivity, latency, and credential smoke tests:

```bash
cf-hana ping eu10/example-org/space-demo/app-demo --read-only
```

Key options:

- `--refresh`: bypass cached binding data and fetch from Cloud Foundry.
- `--role runtime|hdi`: choose the binding user.
- `--binding <name>` or `--binding-index <n>`: disambiguate multiple HANA bindings.
- `--timeout <ms>`: set connection and query timeout.
- `--limit <n>` or `--no-auto-limit`: tune automatic `SELECT` row caps.
- `--read-only`: block non-read statements.
- `--allow-destructive`: only for explicit user-requested destructive work.

## Troubleshooting

If selector resolution fails, verify the region, org, space, app, and local `cf-sync` cache state.

If credentials are missing, ask the user whether they want to refresh from Cloud Foundry. A live refresh needs valid SAP credentials in the environment or equivalent secure input; never print those values.

If multiple HANA bindings exist, ask for the intended binding name or index instead of guessing:

```bash
cf-hana info eu10/example-org/space-demo/app-demo --binding <name> --format json
cf-hana info eu10/example-org/space-demo/app-demo --binding-index 0 --format json
```

If a query is too broad, add a `WHERE` clause or use `--limit <n>`. Keep `--read-only` enabled unless the user explicitly requests a write.
