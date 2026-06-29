---
name: sharepoint-excel
description: Use when working with SharePoint-hosted .xlsx files through sharepoint-excel, including app-only auth, profiles, drive discovery, and workbook read/write operations.
---

# SharePoint Excel

## Purpose

Use `sharepoint-excel` to automate SharePoint-hosted `.xlsx` files with Microsoft Graph app-only credentials. Prefer it when the task needs to create a workbook, read workbook data, append JSON records, update one cell, add a sheet, list document libraries, or validate SharePoint Excel credentials.

If `sharepoint-excel` is missing, install it from `@saptools/sharepoint-excel`: `npm install -g @saptools/sharepoint-excel`.

Treat tenant IDs, client IDs, client secrets, Graph tokens, workbook contents, profile files, and generated `.xlsx` data as sensitive. Do not print secrets or paste raw workbook data unless the user explicitly asks.

## First Steps

1. Identify whether the user needs credential setup, auth testing, drive discovery, workbook creation, read-only inspection, or a mutating workbook operation.
2. Prefer `--json` for agent workflows and parsing. Use human-readable output only for a concise user-facing summary.
3. Use a stored profile for repeated local work. Use environment variables for CI or ephemeral runs.
4. Confirm the target site and drive before mutating a workbook. Use `test` and `drives` when the site, permissions, or library name is uncertain.
5. For writes, remember that `create` refuses existing files, while `append`, `update-cell`, and `add-sheet` download the workbook, mutate it locally, and upload with SharePoint ETag protection.

## Credential Setup

Store a reusable profile with OS credential storage by default:

```bash
sharepoint-excel config set \
  --profile finance \
  --tenant "$SHAREPOINT_EXCEL_TENANT_ID" \
  --client-id "$SHAREPOINT_EXCEL_CLIENT_ID" \
  --client-secret "$SHAREPOINT_EXCEL_CLIENT_SECRET" \
  --site "contoso.sharepoint.com/sites/finance" \
  --drive "Documents"
```

Read or remove profile metadata:

```bash
sharepoint-excel config get --profile finance --json
sharepoint-excel config remove --profile finance
```

Secrets are never printed. Profile metadata lives under `~/.saptools/sharepoint-excel/profiles.json`. Plaintext secret storage is only for controlled headless environments and requires both an explicit file store and opt-in:

```bash
SAPTOOLS_SHAREPOINT_EXCEL_ALLOW_PLAINTEXT=1 \
sharepoint-excel config set --store file --allow-plaintext-secret ...
```

Runtime credentials can also come from these env vars:

- `SHAREPOINT_EXCEL_TENANT_ID`
- `SHAREPOINT_EXCEL_CLIENT_ID`
- `SHAREPOINT_EXCEL_CLIENT_SECRET`
- `SHAREPOINT_EXCEL_SITE`
- `SHAREPOINT_EXCEL_DRIVE`
- `SHAREPOINT_EXCEL_PROFILE`

Fallback names `SHAREPOINT_TENANT_ID`, `SHAREPOINT_CLIENT_ID`, `SHAREPOINT_CLIENT_SECRET`, `SHAREPOINT_SITE`, and `SHAREPOINT_DRIVE` are also accepted. Use `SAPTOOLS_SHAREPOINT_EXCEL_HOME` to isolate local state in tests or CI.

## Command Choice

Use `test` before workbook operations when credentials, site resolution, or app permissions are uncertain:

```bash
sharepoint-excel test --profile finance --json
```

Use `drives` to identify the document library name or id:

```bash
sharepoint-excel drives --profile finance --json
```

Use `create` for a new `.xlsx`. It fails if the SharePoint path already exists:

```bash
sharepoint-excel create \
  --profile finance \
  --path "Reports/orders.xlsx" \
  --sheet "Orders" \
  --headers "Name,Amount,Status" \
  --rows '[{"Name":"Coffee","Amount":3,"Status":"open"}]' \
  --table "OrdersTable" \
  --json
```

Use `read` for workbook, sheet, or A1 range inspection:

```bash
sharepoint-excel read --profile finance --path "Reports/orders.xlsx" --json
sharepoint-excel read --profile finance --path "Reports/orders.xlsx" --sheet "Orders" --range "A1:C10" --json
```

Use `append` to add one or more rows. Objects map to the first row's headers by default:

```bash
sharepoint-excel append \
  --profile finance \
  --path "Reports/orders.xlsx" \
  --sheet "Orders" \
  --record '{"Name":"Tea","Amount":8,"Status":"open"}' \
  --json
```

Add `--no-match-header` only when object values should be appended in JSON key order instead of header order.

Use `update-cell` for one A1 cell:

```bash
sharepoint-excel update-cell \
  --profile finance \
  --path "Reports/orders.xlsx" \
  --sheet "Orders" \
  --cell "C2" \
  --value '"closed"' \
  --json
```

Use `add-sheet` for a new worksheet. It fails if the sheet already exists:

```bash
sharepoint-excel add-sheet \
  --profile finance \
  --path "Reports/orders.xlsx" \
  --sheet "Audit" \
  --headers "At,Action,Actor" \
  --json
```

## Workbook Inputs

Workbook paths must end with `.xlsx`. Leading and trailing slashes are normalized.

Site refs can be copied URLs or host/path values, such as:

```bash
--site "https://contoso.sharepoint.com/sites/finance?view=1"
--site "contoso.sharepoint.com/sites/finance"
```

Rows for `--rows` and `--record` can be a JSON object, a JSON row array, or an array of objects/rows. Cell values must be strings, numbers, booleans, or `null`; nested objects are rejected.

`--headers` is comma-separated and trims empty entries. When `create` receives object rows without headers, headers are derived from the first object row.

`--value` accepts a JSON scalar such as `42`, `true`, `null`, or `"text"`. If parsing fails or the JSON is not a scalar, the raw string is used.

A1 cells and ranges are validated. Ranges such as `C3:A1` are normalized to the ordered rectangle.

## Data Handling

Mutating commands read the remote `.xlsx`, change it in memory with `exceljs`, and upload the new bytes. They do not call delegated Excel workbook mutation endpoints.

`append`, `update-cell`, and `add-sheet` require the downloaded SharePoint item to have an ETag and upload with `If-Match`. A concurrent edit should surface as a Graph precondition error instead of silently overwriting another user's change.

The package uses Microsoft Graph file APIs and upload sessions. Upload-session PUT requests intentionally omit the Graph bearer token because the upload URL is pre-authorized and may use a different origin.

Do not store generated workbook files, profile files, plaintext secrets, or test homes in git. Local plaintext secrets, when explicitly enabled, are written under `~/.saptools/sharepoint-excel/secrets.json` with `0600` permissions.

## Troubleshooting

- `Tenant ID is required`, `Client ID is required`, or `Client secret is required`: pass flags, set env vars, or run `config set`.
- `Profile "<name>" not found`: use `config set --profile <name>` or select an existing profile.
- `SharePoint site not found`: verify `--site`, app permissions, and any site-specific grant.
- `Drive "<name>" not found`: run `drives --json` and pass the exact drive name or id.
- `Refusing to overwrite existing SharePoint file`: `create` found an existing target path. Pick a new path or intentionally update the existing workbook with a mutation command.
- `Workbook path must end with .xlsx`: use an Excel workbook path, not CSV or another file type.
- `Sheet "<name>" not found` or `already exists`: inspect sheets with `read --json` and retry with the intended sheet name.
- `preconditionFailed`, `412`, or ETag mismatch: the remote workbook changed between download and upload. Reread the workbook and reapply the intended change.
- Keyring errors in CI or containers: prefer environment variables for runtime commands, or opt into `--store file --allow-plaintext-secret` only in a controlled workspace.

## Related Tools

Use `@saptools/sharepoint-check` for pre-flight Microsoft Graph and SharePoint diagnostics when permissions, site resolution, or drive discovery fail before workbook-specific logic starts.
