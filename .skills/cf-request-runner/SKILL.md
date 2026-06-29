---
name: cf-request-runner
description: Use when discovering SAP CAP or OData API endpoints on SAP BTP Cloud Foundry, including root endpoint catalogs, OData metadata expansion, and XSUAA bearer token discovery.
---

# CF Request Runner

## Purpose

Use `cf-request-runner` to discover API endpoints exposed by a deployed SAP CAP or OData service on Cloud Foundry. Prefer it when the user needs route inventory, entity paths, supported methods, service-document expansion, or a JSON endpoint list for another tool.

If `cf-request-runner` is missing, install it from `@saptools/cf-request-runner`:

```bash
npm install -g @saptools/cf-request-runner
```

## First Steps

1. Identify the Cloud Foundry app name and the exact public base URL to inspect.
2. Confirm the current `cf target` when relying on automatic XSUAA token discovery or CF SSH fallback.
3. Prefer `--json` for agent workflows and downstream parsing.
4. Prefer `CF_REQUEST_RUNNER_TOKEN` over `--token` when providing a bearer token, so the token is not stored in shell history or exposed in process lists.
5. Use `--out <file>` when the endpoint list should be saved for follow-up tools instead of pasted into the chat.

## Command Choice

Discover endpoints from a deployed app:

```bash
cf-request-runner \
  --app orders-srv \
  --url https://orders-srv.cfapps.example.hana.ondemand.com
```

Emit strict JSON for parsing:

```bash
cf-request-runner \
  --app orders-srv \
  --url https://orders-srv.cfapps.example.hana.ondemand.com \
  --json
```

Save JSON output to a file:

```bash
cf-request-runner \
  --app orders-srv \
  --url https://orders-srv.cfapps.example.hana.ondemand.com \
  --json \
  --out endpoints.json
```

Use a provided token without putting it on the command line:

```bash
CF_REQUEST_RUNNER_TOKEN="$TOKEN" \
cf-request-runner --app orders-srv --url https://orders-srv.example.com --json
```

Use `--cf-home <dir>` only when the run must use an isolated Cloud Foundry CLI session:

```bash
cf-request-runner \
  --app orders-srv \
  --url https://orders-srv.example.com \
  --cf-home /tmp/cf-home \
  --json
```

## Discovery Behavior

The CLI first fetches the app root URL and parses common CAP `endpoints` catalogs or OData service-document `value` entries. It then expands each root service through `$metadata`.

Metadata expansion discovers:

- `EntitySet` endpoints.
- `FunctionImport` endpoints as `GET`.
- `ActionImport` endpoints as `POST`.
- Capability annotations that remove unsupported `POST`, `PATCH`, or `DELETE` methods.

If `$metadata` is unavailable, it falls back to the service document for sub-entity expansion. If root discovery finds no usable services, it falls back to `cf ssh <app>` and scans remote `.cds` files for service definitions and `@path` annotations.

## Token And CF Access

When no explicit token is supplied, the CLI runs `cf env <app>`, parses `VCAP_SERVICES`, finds the first valid `xsuaa` binding, requests a client-credentials token, and uses that token for HTTP discovery.

Use explicit `CF_REQUEST_RUNNER_TOKEN` when:

- the app has no XSUAA binding
- the app requires a different token source
- `cf env` access is unavailable
- you need deterministic CI behavior

Use the current official `cf` CLI target for token discovery and SSH fallback. Do not pass SAP credentials to `cf-request-runner`; authenticate the `cf` CLI separately.

## Output Handling

The JSON result is an array of endpoint objects with:

- `name`
- `path`
- `methods`
- `schema`

Treat discovered routes, app names, service names, tokens, XSUAA data, and remote `.cds` content as sensitive. Summarize endpoint counts and notable paths unless the user explicitly asks for the full JSON.

## Troubleshooting

- `error: required option '-a, --app <appId>' not specified`: pass `--app <name>`.
- `error: required option '-u, --url <baseUrl>' not specified`: pass the exact deployed app base URL.
- No endpoints are discovered: verify the base URL, route mapping, app health, and whether the service exposes a CAP root catalog, OData service document, or `$metadata`.
- HTTP discovery fails with authorization errors: provide `CF_REQUEST_RUNNER_TOKEN` or verify the app has a usable XSUAA binding in `cf env`.
- CF SSH fallback finds nothing: verify SSH is enabled for the app and the deployed artifact includes `.cds` files. Built-only JavaScript artifacts may not include source `.cds` files.
- Duplicate or unexpected paths: inspect the app root catalog and service documents directly, then rerun with `--json` for exact endpoint output.
- Saved output fails: ensure the parent directory for `--out` already exists.

Use `cf-sync` for topology discovery, `cf-explorer` for inspecting deployed files, `cf-logs` for runtime logs, and `cf-events` for audit or crash history.
