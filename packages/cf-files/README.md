<div align="center">

# `@saptools/cf-files`

**Export Cloud Foundry app env to `default-env.json` and pull files from running SAP BTP Cloud Foundry containers.**

[![npm](https://img.shields.io/npm/v/@saptools/cf-files.svg?style=flat-square&color=CB3837&logo=npm&label=)](https://www.npmjs.com/package/@saptools/cf-files)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)

</div>

---

## What it does

`@saptools/cf-files` is a small CLI (and TypeScript library) for three recurring tasks when you develop against a live SAP BTP Cloud Foundry app:

- **`gen-env`** — read the app's `cf env` output and write a local `default-env.json`, including `VCAP_SERVICES`, `VCAP_APPLICATION`, and user-provided env vars such as `destinations`.
- **`list`** — list files inside the running container using `cf ssh <app> -c "ls -la ..."`.
- **`download`** — download a single file from the container using `cf ssh <app> -c "cat ..."`, preserving raw bytes.
- **`download-folder`** — download a whole folder with one compressed `tar` stream over `cf ssh`, with optional include/exclude filters.

Authentication is handled transparently via the Cloud Foundry CLI (`cf api` → `cf auth` → `cf target`), and region keys are resolved through [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync). The package passes credentials to `cf auth` through `CF_USERNAME` / `CF_PASSWORD` in the child process environment instead of command-line password arguments.

---

## Requirements

- Node.js `>= 20`
- The [`cf` CLI](https://docs.cloudfoundry.org/cf-cli/install-go-cli.html) installed and on `PATH`
- Environment variables:
  - `SAP_EMAIL` — your SAP BTP user email
  - `SAP_PASSWORD` — your SAP BTP user password

---

## Install

```bash
npm install -g @saptools/cf-files
# or use per-invocation:
npx @saptools/cf-files gen-env --help
```

---

## CLI

All commands share the following required flags:

| Flag | Description |
| --- | --- |
| `-r, --region <key>` | CF region key (e.g. `ap10`, `eu10`) |
| `-o, --org <name>` | CF org name |
| `-s, --space <name>` | CF space name |
| `-a, --app <name>` | CF app name |

### `gen-env`

Export Cloud Foundry environment values from a running app to a `default-env.json` file.

```bash
saptools-cf-files gen-env \
  --region ap10 \
  --org my-org \
  --space dev \
  --app my-app \
  --out default-env.json
```

The output format mirrors common SAP local-dev conventions for `default-env.json`:

```json
{
  "VCAP_APPLICATION": {
    "application_id": "...",
    "application_name": "my-app"
  },
  "VCAP_SERVICES": {
    "xsuaa": [{ "credentials": { "clientid": "..." } }],
    "hana":  [{ "credentials": { "host": "..." } }]
  },
  "destinations": [
    { "name": "example-api", "url": "https://..." }
  ]
}
```

`gen-env` writes what `cf env <app>` reliably exposes for local emulation:

- `VCAP_SERVICES`
- `VCAP_APPLICATION`
- user-provided env vars from the `User-Provided:` section, for example `destinations`

### `list`

List files inside the running container.

```bash
saptools-cf-files list \
  --region ap10 --org my-org --space dev --app my-app \
  --path src                  # optional; relative paths resolve under --app-path
  --app-path /home/vcap/app   # defaults to /home/vcap/app
  --json                      # optional structured output
```

If your app lives under a custom base path (for example, `/my_core` instead of `/home/vcap/app`), pass it via `--app-path`.

### `download`

Download a single file from the container.

```bash
saptools-cf-files download \
  --region ap10 --org my-org --space dev --app my-app \
  --remote package.json \
  --out ./package.json \
  --app-path /home/vcap/app
```

`--remote` may be absolute (`/etc/foo.conf`) or relative to `--app-path`. Remote paths are shell-quoted before being sent to `cf ssh`, so spaces, quotes, semicolons, and `$` characters are treated as path text rather than extra shell syntax.

### `download-folder`

Download a directory tree from the container in one compressed transfer.

```bash
saptools-cf-files download-folder \
  --region ap10 --org my-org --space dev --app my-app \
  --remote /home/vcap/app \
  --out ./app-copy \
  --exclude node_modules \
  --include node_modules/@vendor
```

`download-folder` creates a remote `tar.gz` stream and extracts it locally. This avoids one `cf ssh` round trip per file, which is much faster for large trees.

Filter paths are relative to the copied folder:

- `--exclude <path>` skips that relative subtree.
- `--include <path>` restores a subtree below an excluded parent.
- Both flags can be repeated.

Symlinks are dereferenced in the archive. For example, a linked package under `node_modules/@vendor/*` is copied as regular files under that path instead of as a local symlink that points back to the container layout.

---

## Library usage

```ts
import { genEnv, listFiles, downloadFile, downloadFolder } from "@saptools/cf-files";

await genEnv({
  target: { region: "ap10", org: "my-org", space: "dev", app: "my-app" },
  outPath: "default-env.json",
});

const entries = await listFiles({
  target: { region: "ap10", org: "my-org", space: "dev", app: "my-app" },
  remotePath: "/home/vcap/app",
});

await downloadFile({
  target: { region: "ap10", org: "my-org", space: "dev", app: "my-app" },
  remotePath: "/home/vcap/app/package.json",
  outPath: "./package.json",
});

await downloadFolder({
  target: { region: "ap10", org: "my-org", space: "dev", app: "my-app" },
  remotePath: "/home/vcap/app",
  outDir: "./app-copy",
  exclude: ["node_modules"],
  include: ["node_modules/@vendor"],
});
```

All functions accept an optional `CfExecContext` second argument to override the `cf` binary or inject environment variables — useful for tests:

```ts
await genEnv(options, { command: "/path/to/cf", env: { SAP_EMAIL: "...", SAP_PASSWORD: "..." } });
```

---

## How it works

Under the hood every command runs the same boilerplate:

1. `cf api <api-endpoint>` — resolved from the region key via `@saptools/cf-sync`'s `REGIONS` catalog.
2. `cf auth` with `CF_USERNAME` / `CF_PASSWORD` scoped to the child process environment.
3. `cf target -o <org> -s <space>`
4. Then either:
   - `cf env <app>` (for `gen-env`), parsed into a `default-env.json` payload containing `VCAP_SERVICES`, `VCAP_APPLICATION`, and user-provided env vars, or
   - `cf ssh <app> --disable-pseudo-tty -c "ls -la -- '<path>'"` / `cf ssh <app> --disable-pseudo-tty -c "cat -- '<path>'"` (for `list` / `download`), or
   - `cf ssh <app> --disable-pseudo-tty -c "tar --dereference -czf - -C '<path>' ..."` (for `download-folder`).

The container side runs standard Unix tools (`ls`, `cat`, `tar`, and `find` only when include filters need to override excludes). Normal CLI runs use an isolated temporary `CF_HOME` so they do not change your default local CF CLI target; set `CF_FILES_CF_HOME` if you intentionally want a persistent CF home for this tool.

---

## Environment variables

| Variable | Purpose |
| --- | --- |
| `SAP_EMAIL` | SAP BTP user email (required) |
| `SAP_PASSWORD` | SAP BTP user password (required) |
| `CF_FILES_CF_BIN` | Override the `cf` binary path (used by tests) |
| `CF_FILES_CF_HOME` | Optional persistent CF home for this tool; defaults to a temporary directory per command |

---

## Security note

CAP Node.js marks `default-env.json` as deprecated in favor of `cds bind`, because writing service credentials to local disk is inherently sensitive. Use `gen-env` only when you explicitly need a materialized `default-env.json` for local tooling or debugging, and keep the file out of version control. `gen-env` writes the file with owner-only permissions (`0600`) on platforms that support POSIX file modes.

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
