# @saptools/core

Internal shared code for the `@saptools/*` CLIs. **Private and never published**: every CLI lists it
as a `devDependency` (`"@saptools/core": "workspace:*"`), `exports` points straight at
`src/index.ts`, and tsup inlines it into each `dist/cli.js` at build time. A CLI's published tarball
therefore carries no extra dependency and no reference to this package; a change here ships only when
a consuming CLI bumps its own version.

Why bundled rather than published: the repo already tried a published shared library (`cf-sync` as a
runtime dependency of cf-hana, cf-logs, cf-events) and removed it because of lockfile churn and
`^a || ^b` version ranges, and the self-updater below compares the CLI's *own* version, so a published
core fix would never trigger it anyway.

## What lives here

| module | purpose |
| --- | --- |
| `package-metadata` | `readPackageMetadata(import.meta.url, name)` reads name and version from the owning `package.json` at runtime, so `--version` and the updater can never drift from the manifest. |
| `saptools-paths` | `~/.saptools` root resolution (`SAPTOOLS_ROOT` override), private directories (0700), atomic 0600 writes, tolerant JSON reads. |
| `self-update` | Check npm for a newer release, install it with the package manager that owns the running binary, and re-run the command on the new version. |

## Self-update

Attach once per CLI, in the program factory:

```ts
import { attachSelfUpdate, readPackageMetadata, registerSelfUpdateCommand } from "@saptools/core";

const { version } = readPackageMetadata(import.meta.url, "@saptools/cf-metrics");
const selfUpdate = { packageName: "@saptools/cf-metrics", currentVersion: version, binName: "cf-metrics", envPrefix: "CF_METRICS", notice: printNotice };
attachSelfUpdate(program, selfUpdate);          // preAction hook: runs before every command
registerSelfUpdateCommand(program, selfUpdate); // `<bin> self-update [--check]`
```

What one invocation does:

1. Decide the policy (`on` by default; see below). `--help` and `--version` never reach the hook.
2. Read `~/.saptools/updates/<package>.json`. If the last check is younger than the interval
   (60 min), reuse it. Otherwise `GET {registry}/-/package/<name>/dist-tags` with a 2 s timeout
   (18 bytes; falls back to the abbreviated packument for registries without that endpoint).
3. No newer release: nothing is printed, the command runs.
4. Newer release, policy `on`: take a lock, print `updating A -> B ...` on stderr, run the exact-version
   install (`npm install -g --prefix <prefix> <name>@B --registry <url> ...` through the npm that ships
   with the running node; pnpm/yarn/bun/volta equivalents by detected location), verify the installed
   `package.json`, print `updated to B; re-running the command`, then re-run the same argv on the new
   version (`process.execve` on Node >= 22.15 POSIX, otherwise a child with inherited stdio, forwarded
   signals and mirrored exit code). The re-run carries `SAPTOOLS_SELF_UPDATE_REEXEC=1` so it can never
   update again.
5. Anything fails: one stderr line with the manual command, and the command runs on the current version.
   A failed install is not retried for 24 h; a registry failure is not retried for 15 min; a version
   already announced under `notify` is not announced again for 24 h.

Guarantees: never writes to stdout, never throws, never prompts, never escalates privileges, never
targets a prerelease, never downgrades.

### Switches

| variable | effect |
| --- | --- |
| `SAPTOOLS_AUTO_UPDATE=on\|notify\|off` | `on` installs and re-runs (default); `notify` prints the manual command once per version; `off` does nothing. |
| `<PREFIX>_AUTO_UPDATE` | Same values for one CLI only (e.g. `CF_METRICS_AUTO_UPDATE`); wins over the global variable. |
| `SAPTOOLS_UPDATE_INTERVAL_MINUTES` | Minutes between registry checks (default 60; `0` checks every run). |
| `SAPTOOLS_NPM_REGISTRY` | Registry to check and install from; otherwise `npm_config_registry`, then `~/.npmrc` (`@saptools:registry`, then `registry`), then npmjs. The project-level `.npmrc` is ignored on purpose. |
| `SAPTOOLS_ROOT` | Relocates `~/.saptools` (state lives under `<root>/updates/`). |
| `SAPTOOLS_UPDATE_DEBUG=1` | Prints why the updater did nothing. |
| `SAPTOOLS_SELF_UPDATE_REEXEC` | Internal marker on the re-executed process; do not set. |

Without an explicit policy the updater switches itself off when `CI` is truthy, `NODE_ENV=test`, or
`NO_UPDATE_NOTIFIER` is set; when the binary runs from a source checkout, an `npm link`, or an
`npx`/`dlx` cache; and after a re-exec. A read-only install directory downgrades `on` to `notify`.

### Integration checklist for a CLI

- `devDependencies["@saptools/core"] = "workspace:*"`; import from `@saptools/core`.
- Replace any hand-maintained version constant with `readPackageMetadata`.
- `attachSelfUpdate(program, ...)` before registering commands, `registerSelfUpdateCommand` after.
- Pass `skipCommands` for internal subcommands (workers, daemons) and give children of the CLI
  `SAPTOOLS_AUTO_UPDATE=off` in their environment.
- Route `notice` through the CLI's stderr helper; silence it where stderr carries a machine contract.
- Use `parseAsync`, not `parse`: the hook is asynchronous.
- Set `SAPTOOLS_AUTO_UPDATE=off` in the unit (vitest `test.env`) and e2e environments; add
  `packages/core/**` to the package's workflow `paths`.

## Tests

`pnpm --filter @saptools/core test:unit` (vitest, coverage thresholds 90/90/85/90). The registry,
installer, re-exec and clock are injectable, so every branch runs without network or a real install;
cf-metrics' `tests/e2e/self-update.e2e.ts` covers the real `npm install` against a fake registry.
