<div align="center">

# 📁 `@saptools/sharepoint-check`

**Pre-flight SharePoint diagnostics for Microsoft Graph app-only access.**

Verify auth, resolve the target site, inspect document libraries, walk folder trees, validate required paths, and dry-run write access before a pipeline or migration goes live.

[![npm version](https://img.shields.io/npm/v/@saptools/sharepoint-check.svg?style=flat&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/sharepoint-check)
[![node](https://img.shields.io/node/v/@saptools/sharepoint-check.svg?style=flat&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@saptools/sharepoint-check)](https://packagephobia.com/result?p=@saptools/sharepoint-check)
[![types](https://img.shields.io/npm/types/@saptools/sharepoint-check.svg?style=flat&color=3178C6&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [FAQ](#-faq)

</div>

---

## ✨ Features

- 🔐 **App-only auth check**: requests a client-credentials token, decodes the JWT locally, and shows the app id, tenant, roles, and scopes carried by the token
- 🧭 **Site resolution**: proves the target `host/sites/...` reference really maps to a SharePoint site before later steps fail more vaguely
- 🗂️ **Drive discovery**: lists every visible document library on the target site so you can confirm which drive the integration should use
- 🌲 **Folder tree walk**: traverses a folder and summarizes file counts, subfolder counts, and aggregate size per node
- ✅ **Layout validation**: checks that a required root path and expected subdirectories exist, with exit code `2` when validation fails
- ✍️ **Write probe**: creates and deletes a uniquely named folder to prove the app can actually write, not just read metadata
- 🧰 **CLI and typed API**: everything used by the CLI is exported for scripts and Node.js automation
- 🪶 **Tiny runtime surface**: one runtime dependency (`commander`), no MSAL SDK, no Graph SDK

---

## 📦 Install

```bash
# Global CLI
npm install -g @saptools/sharepoint-check

# Or as a dependency
npm install @saptools/sharepoint-check
# pnpm add @saptools/sharepoint-check
# yarn add @saptools/sharepoint-check
```

> [!NOTE]
> Requires **Node.js >= 20**. The CLI binary is `saptools-sharepoint-check`.

---

## 🚀 Quick Start

```bash
# 1. Export the required credentials and target site
export SHAREPOINT_TENANT_ID="11111111-1111-1111-1111-111111111111"
export SHAREPOINT_CLIENT_ID="22222222-2222-2222-2222-222222222222"
export SHAREPOINT_CLIENT_SECRET="<your-client-secret>"
export SHAREPOINT_SITE="contoso.sharepoint.com/sites/demo"

# 2. Optional defaults for validation / write checks
export SHAREPOINT_ROOT_DIR="Apps"
export SHAREPOINT_SUBDIRS="sample-app,demo-app"

# 3. Prove auth + site resolution
saptools-sharepoint-check test

# 4. See available document libraries
saptools-sharepoint-check drives

# 5. Run the full pre-flight check
saptools-sharepoint-check check --drive Documents --root Apps --subdirs "sample-app,demo-app"
```

Typical output:

```text
✔ Authenticated: App: Demo Connector | AppId: 22222222-... | Tenant: 11111111-... | Roles: Sites.Selected
✔ Site: Demo Site — 2 drive(s) available
✔ Using drive: Documents
✔ root: Apps
✔ Apps/sample-app
✔ Apps/demo-app
All expected folders present.
✔ Write probe passed at Apps/sharepoint-check-probe-ms4k2-ae12...
```

---

## 🧰 CLI

Every subcommand reads auth from flags or environment variables:

| Flag | Env | Description |
| --- | --- | --- |
| `--tenant <id>` | `SHAREPOINT_TENANT_ID` | Azure AD tenant id |
| `--client-id <id>` | `SHAREPOINT_CLIENT_ID` | App registration client id |
| `--client-secret <secret>` | `SHAREPOINT_CLIENT_SECRET` | App registration client secret |
| `--site <ref>` | `SHAREPOINT_SITE` | SharePoint site reference such as `contoso.sharepoint.com/sites/demo` |
| `--json` | - | Machine-readable JSON output for `test`, `drives`, `tree`, `validate`, and `write-test` |

### 🔎 `test`

Acquire an app-only token and resolve the target site.

```bash
saptools-sharepoint-check test
saptools-sharepoint-check test --json | jq '.claims.roles'
```

Returns exit code `1` on auth, configuration, or site-resolution errors.

### 🗂️ `drives`

List document libraries visible on the site.

```bash
saptools-sharepoint-check drives
saptools-sharepoint-check drives --json
```

Use this first if you are unsure whether the right drive is named `Documents`, `Shared Documents`, or something custom.

### 🌲 `tree`

Walk a folder and print a summary tree.

```bash
saptools-sharepoint-check tree --drive Documents --root Apps
saptools-sharepoint-check tree --drive Documents --root Apps --depth 5 --json
```

| Flag | Env | Default |
| --- | --- | --- |
| `--drive <nameOrId>` | - | First drive on the site |
| `--root <path>` | `SHAREPOINT_ROOT_DIR` | Drive root |
| `--depth <n>` | - | `3` |

### ✅ `validate`

Check that a root folder and its expected subdirectories exist.

```bash
saptools-sharepoint-check validate --drive Documents --root Apps --subdirs "sample-app,demo-app"
```

| Flag | Env | Description |
| --- | --- | --- |
| `--drive <nameOrId>` | - | Drive name or id |
| `--root <path>` | `SHAREPOINT_ROOT_DIR` | Root folder to validate |
| `--subdirs <list>` | `SHAREPOINT_SUBDIRS` | Comma- or newline-separated expected subdirectories |

Returns exit code `2` when any expected folder is missing or is not a folder.

### ✍️ `write-test`

Create and delete a uniquely named probe folder under the chosen root.

```bash
saptools-sharepoint-check write-test --drive Documents --root Apps
saptools-sharepoint-check write-test --drive Documents --root Apps --json
```

The probe folder uses the prefix `sharepoint-check-probe-` plus a timestamp/random suffix, so concurrent runs do not collide.

Returns exit code `2` when create or cleanup fails.

### 🧪 `check`

Run the full diagnostic sequence in one pass:

1. authenticate
2. resolve site
3. list drives
4. validate required layout
5. run the write probe

```bash
saptools-sharepoint-check check --drive Documents --root Apps --subdirs "sample-app,demo-app"
```

`check` emits human-readable output only. It returns exit code `2` for layout/write failures and exit code `1` for fatal errors such as missing config or Graph failures.

---

## 🧑‍💻 Programmatic Usage

```ts
import {
  listDrives,
  openSession,
  resolveConfig,
  runWriteTest,
  validateLayout,
  walkFolderTree,
} from "@saptools/sharepoint-check";

const config = resolveConfig({ requireRoot: true });
const session = await openSession(config.target);

const drives = await listDrives(session.client, session.site.id);
const drive = drives.find((entry) => entry.name === "Documents") ?? drives[0];

if (!drive) {
  throw new Error("No document libraries found");
}

const tree = await walkFolderTree(session.client, {
  driveId: drive.id,
  rootPath: config.rootPath,
  limits: { maxDepth: 2 },
});

const layout = await validateLayout(session.client, drive.id, {
  rootPath: config.rootPath,
  subdirectories: config.subdirectories,
});

const probe = await runWriteTest(session.client, {
  driveId: drive.id,
  rootPath: config.rootPath,
});

console.log({
  site: session.site.displayName,
  foldersOk: layout.allPresent,
  probeOk: probe.created && probe.deleted,
  treeRoot: tree.path,
});
```

<details>
<summary><b>📚 Main exports</b></summary>

| Export | Description |
| --- | --- |
| `acquireAppToken(credentials, options)` | Request an app-only token |
| `decodeAccessToken(token)` | Decode JWT claims locally |
| `createGraphClient(options)` | Create a minimal Graph client wrapper |
| `parseSiteRef(value)` | Parse `host/sites/...` or full site URL |
| `resolveSite(client, ref)` | Resolve a SharePoint site via Graph |
| `listDrives(client, siteId)` | List document libraries |
| `listDriveRoot(client, driveId)` | List root children |
| `listDriveChildren(client, driveId, path)` | List children under a relative path |
| `getDriveItemByPath(client, driveId, path)` | Resolve one file/folder by path |
| `createFolder(client, driveId, parentPath, folderName)` | Create a folder |
| `deleteItem(client, driveId, itemId)` | Delete a drive item |
| `walkFolderTree(client, options)` | Build a summarized folder tree |
| `validateLayout(client, driveId, expectation)` | Validate required directories |
| `runWriteTest(client, options)` | Create/delete probe folder |
| `resolveConfig(options)` | Read flags/env into typed config |
| `openSession(target, options)` | Acquire token, decode claims, create client, resolve site |
| `renderFolderTree(tree)` | Render the text tree used by the CLI |
| `renderValidateResult(result)` | Render validation output |
| `summarizeToken(claims)` | Format auth claims for CLI output |

</details>

> [!TIP]
> The API accepts fetch overrides where appropriate, which is how the package's fake-backed tests run without calling the real Microsoft Graph.

---

## 🌐 Environment Variables

| Variable | Purpose |
| --- | --- |
| `SHAREPOINT_TENANT_ID` | Azure AD tenant id |
| `SHAREPOINT_CLIENT_ID` | App registration client id |
| `SHAREPOINT_CLIENT_SECRET` | Client secret |
| `SHAREPOINT_SITE` | Site reference such as `contoso.sharepoint.com/sites/demo` |
| `SHAREPOINT_ROOT_DIR` | Default root for `tree`, `validate`, `write-test`, and `check` |
| `SHAREPOINT_SUBDIRS` | Expected subdirectories, comma- or newline-separated |
| `SHAREPOINT_AUTH_BASE` | Override the Azure AD auth host, mainly for tests |
| `SHAREPOINT_GRAPH_BASE` | Override the Graph base URL, mainly for tests |

---

## 🚦 Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Fatal error such as missing config, auth failure, invalid input, or Graph error |
| `2` | Validation failure or write probe failure |

---

## ❓ FAQ

<details>
<summary><b>What should <code>SHAREPOINT_SITE</code> look like?</b></summary>

Use the site root, not a deep page URL. Good examples:

- `contoso.sharepoint.com/sites/demo`
- `https://contoso.sharepoint.com/sites/demo`
- `contoso.sharepoint.com/teams/finance`

Avoid values like `.../SitePages/Home.aspx`.

</details>

<details>
<summary><b>Does this test delegated auth or interactive login?</b></summary>

No. The package is specifically for app-only client-credentials access. It validates what a service principal can do through Microsoft Graph.

</details>

<details>
<summary><b>Is <code>Sites.Selected</code> enough?</b></summary>

Yes, if the app also has the required site-level grant on the target site. `sharepoint-check` helps confirm that the token resolves, the site is reachable, the expected drive is visible, and the write probe actually succeeds.

</details>

<details>
<summary><b>Why not use the Microsoft Graph SDK?</b></summary>

This package deliberately stays small and predictable. It talks to the Graph `v1.0` REST endpoints directly with native `fetch`, which keeps startup fast and dependency surface minimal for CI and utility scripts.

</details>

---

## License

MIT © Dong Tran
