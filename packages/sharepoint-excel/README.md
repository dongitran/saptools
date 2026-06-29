<div align="center">

# 📊 `@saptools/sharepoint-excel`

**Safe SharePoint Excel automation for Microsoft Graph app-only integrations.**

Create `.xlsx` files, read workbook content, append records, update cells, and add sheets from a focused CLI or typed TypeScript API without overwriting somebody else's SharePoint file by accident.

[![npm version](https://img.shields.io/npm/v/@saptools/sharepoint-excel.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/sharepoint-excel)
[![node](https://img.shields.io/node/v/@saptools/sharepoint-excel.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/sharepoint-excel)](https://packagephobia.com/result?p=@saptools/sharepoint-excel)
[![types](https://img.shields.io/npm/types/@saptools/sharepoint-excel.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [Security](#-credential-security)

</div>

---

## ✨ Features

- 🔐 **Safe local profiles**: stores profile metadata under `~/.saptools/sharepoint-excel/` and keeps `clientSecret` in the OS credential vault by default
- 🧭 **Graph app-only flow**: uses Azure AD client credentials to resolve SharePoint sites and document libraries
- 🧱 **Local workbook engine**: edits `.xlsx` bytes with `exceljs`, avoiding delegated-only Microsoft Graph workbook endpoints
- 🛡️ **No accidental overwrite on create**: refuses to create when the target path already exists
- 🔁 **ETag-protected updates**: append/update/add-sheet operations upload with `If-Match` so concurrent SharePoint edits fail fast instead of being silently overwritten
- 📖 **Workbook reads**: inspect all sheets, a single sheet, or an A1 range
- ➕ **Content mutation**: append JSON objects/rows, update a single cell, and add new sheets with headers
- 🧪 **Fake-backed e2e tests**: package tests do not call real Microsoft Graph or SharePoint
- 🧰 **CLI and typed API**: every CLI action is backed by exported TypeScript functions

## 📦 Install

```bash
npm install -g @saptools/sharepoint-excel
```

Requires **Node.js >= 20**. The CLI binary is `saptools-sharepoint-excel`.

---

## 🚀 Quick Start

```bash
# 1. Store an app-only SharePoint profile
saptools-sharepoint-excel config set \
  --tenant "11111111-1111-1111-1111-111111111111" \
  --client-id "22222222-2222-2222-2222-222222222222" \
  --client-secret "<your-client-secret>" \
  --site "contoso.sharepoint.com/sites/demo" \
  --drive "Documents"

# 2. Prove auth and target resolution
saptools-sharepoint-excel test

# 3. Create a workbook without overwriting an existing file
saptools-sharepoint-excel create \
  --path "Reports/orders.xlsx" \
  --sheet "Orders" \
  --headers "Name,Amount,Status" \
  --rows '[{"Name":"Coffee","Amount":3,"Status":"open"}]'

# 4. Append one object by matching row 1 headers
saptools-sharepoint-excel append \
  --path "Reports/orders.xlsx" \
  --sheet "Orders" \
  --record '{"Name":"Tea","Amount":8,"Status":"open"}'

# 5. Update one cell
saptools-sharepoint-excel update-cell \
  --path "Reports/orders.xlsx" \
  --sheet "Orders" \
  --cell "C2" \
  --value '"closed"'

# 6. Read workbook JSON
saptools-sharepoint-excel read --path "Reports/orders.xlsx" --json
```

For CI, every command can also read credentials from environment variables:

```bash
export SHAREPOINT_EXCEL_TENANT_ID="11111111-1111-1111-1111-111111111111"
export SHAREPOINT_EXCEL_CLIENT_ID="22222222-2222-2222-2222-222222222222"
export SHAREPOINT_EXCEL_CLIENT_SECRET="<your-client-secret>"
export SHAREPOINT_EXCEL_SITE="contoso.sharepoint.com/sites/demo"
export SHAREPOINT_EXCEL_DRIVE="Documents"
```

The CLI also accepts the shorter `SHAREPOINT_TENANT_ID`, `SHAREPOINT_CLIENT_ID`, `SHAREPOINT_CLIENT_SECRET`, `SHAREPOINT_SITE`, and `SHAREPOINT_DRIVE` fallbacks for consistency with `@saptools/sharepoint-check`.

---

## 🧰 CLI

### Common auth flags

| Flag | Env | Description |
| --- | --- | --- |
| `--profile <name>` | `SHAREPOINT_EXCEL_PROFILE` | Stored profile name; default is `default` |
| `--tenant <id>` | `SHAREPOINT_EXCEL_TENANT_ID` | Azure AD tenant id |
| `--client-id <id>` | `SHAREPOINT_EXCEL_CLIENT_ID` | App registration client id |
| `--client-secret <secret>` | `SHAREPOINT_EXCEL_CLIENT_SECRET` | App registration client secret |
| `--site <ref>` | `SHAREPOINT_EXCEL_SITE` | SharePoint site, e.g. `contoso.sharepoint.com/sites/demo` |
| `--drive <nameOrId>` | `SHAREPOINT_EXCEL_DRIVE` | Document library name or id |
| `--json` | - | Machine-readable output |

### 🔐 `config set`

Store a reusable local profile.

```bash
saptools-sharepoint-excel config set \
  --profile finance \
  --tenant "$SHAREPOINT_EXCEL_TENANT_ID" \
  --client-id "$SHAREPOINT_EXCEL_CLIENT_ID" \
  --client-secret "$SHAREPOINT_EXCEL_CLIENT_SECRET" \
  --site "contoso.sharepoint.com/sites/finance" \
  --drive "Documents"
```

By default, the secret goes to the OS credential vault:

- macOS: Keychain
- Windows: Credential Manager
- Linux: Secret Service-compatible keyring

For headless CI containers where an OS keyring is unavailable, an explicit plaintext fallback exists:

```bash
SAPTOOLS_SHAREPOINT_EXCEL_ALLOW_PLAINTEXT=1 \
saptools-sharepoint-excel config set --store file --allow-plaintext-secret ...
```

Use that only in controlled CI environments. The file is written with `0600` permissions under `~/.saptools/sharepoint-excel/secrets.json`.

### 👀 `config get`

```bash
saptools-sharepoint-excel config get --profile finance
saptools-sharepoint-excel config get --profile finance --json
```

Secrets are never printed.

### 🧹 `config remove`

```bash
saptools-sharepoint-excel config remove --profile finance
```

Removes both profile metadata and the stored secret.

### ✅ `test`

Authenticate, resolve the site, and list document libraries.

```bash
saptools-sharepoint-excel test
saptools-sharepoint-excel test --json
```

### 🗂️ `drives`

```bash
saptools-sharepoint-excel drives
saptools-sharepoint-excel drives --json
```

Use this when you are unsure whether the document library is named `Documents`, `Shared Documents`, or something custom.

### 🆕 `create`

```bash
saptools-sharepoint-excel create \
  --path "Reports/orders.xlsx" \
  --sheet "Orders" \
  --headers "Name,Amount,Status" \
  --rows '[{"Name":"Coffee","Amount":3,"Status":"open"}]' \
  --table "OrdersTable"
```

`create` fails if `Reports/orders.xlsx` already exists.

### 📖 `read`

```bash
saptools-sharepoint-excel read --path "Reports/orders.xlsx"
saptools-sharepoint-excel read --path "Reports/orders.xlsx" --sheet "Orders" --range "A1:C10" --json
```

### ➕ `append`

```bash
saptools-sharepoint-excel append \
  --path "Reports/orders.xlsx" \
  --sheet "Orders" \
  --record '{"Name":"Tea","Amount":8,"Status":"open"}'
```

Objects are mapped by the first row's headers by default. Use `--no-match-header` to append object values by their JSON key order instead.

### 🎯 `update-cell`

```bash
saptools-sharepoint-excel update-cell \
  --path "Reports/orders.xlsx" \
  --sheet "Orders" \
  --cell "B2" \
  --value "42"
```

`--value` accepts a JSON scalar (`42`, `true`, `null`, `"text"`) or a raw string.

### 📄 `add-sheet`

```bash
saptools-sharepoint-excel add-sheet \
  --path "Reports/orders.xlsx" \
  --sheet "Audit" \
  --headers "At,Action,Actor"
```

Fails if the sheet already exists.

---

## 🔐 Credential Security

`@saptools/sharepoint-excel` handles Microsoft Graph app secrets. Treat them like production credentials.

- The CLI never prints `clientSecret`.
- Default secret storage uses OS-provided credential storage via `@napi-rs/keyring`.
- Local profile metadata lives under `~/.saptools/sharepoint-excel/profiles.json` with `0600` permissions.
- Plaintext secret files require explicit opt-in and should only be used in controlled automation.
- Mutating workbook commands use SharePoint ETags so a stale local download cannot silently replace a newer SharePoint edit.

Required Graph application permissions depend on your tenant model. Typical setups use `Sites.Selected` with site-specific grant plus file read/write access, or a broader `Files.ReadWrite.All`/`Sites.ReadWrite.All` policy where your organization permits it.

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/sharepoint-excel lint
pnpm --filter @saptools/sharepoint-excel typecheck
pnpm --filter @saptools/sharepoint-excel build
pnpm --filter @saptools/sharepoint-excel test:unit
pnpm --filter @saptools/sharepoint-excel test:e2e:fake
```

The e2e suite uses a fake Microsoft Graph server and does not call real SharePoint.

---

## 🌐 Related

- 🔎 [`@saptools/sharepoint-check`](https://www.npmjs.com/package/@saptools/sharepoint-check) — pre-flight Graph and SharePoint diagnostics
- 🗂️ [saptools monorepo](https://github.com/dongitran/saptools) — the full toolbox

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
