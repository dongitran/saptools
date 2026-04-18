# `@saptools/cf-sync`

Sync SAP BTP Cloud Foundry structure into package-managed JSON snapshots.

The package logs into CF, walks `region -> org -> space -> app`, writes a stable snapshot to disk, and also exposes read commands and Node.js APIs so other services do not need to parse the JSON files directly.

Repository: https://github.com/dongitran/saptools/tree/main/packages/cf-sync

## Install

Use it as a CLI:

```bash
npm install -g @saptools/cf-sync
```

Or as a dependency:

```bash
npm install @saptools/cf-sync
```

## Requirements

- `Node.js >= 20`
- `cf` CLI installed and available on `PATH`
- `SAP_EMAIL`
- `SAP_PASSWORD`

Example:

```bash
export SAP_EMAIL="your.name@company.com"
export SAP_PASSWORD="your-password"
```

## CLI

### `cf-sync sync`

Run a CF sync and write the latest full snapshot.

```bash
cf-sync sync
cf-sync sync --verbose
cf-sync sync --no-interactive
cf-sync sync --only ap10,ap11,eu10
```

Options:

- `--verbose`: print progress lines
- `--no-interactive`: disable the spinner
- `--only <keys>`: sync only specific region keys

### `cf-sync read`

Print the best available package-managed structure as JSON.

Use this when you want the current best-known full snapshot right away, without caring whether it comes from an active sync or the last completed one.

- returns runtime state while a sync is running
- falls back to the last stable snapshot when no runtime state exists

```bash
cf-sync read
```

### `cf-sync regions`

Print the best available region list as JSON.

- returns the default SAP CF catalog while a sync is still running
- returns only synced regions with orgs after a successful sync is available

```bash
cf-sync regions
```

### `cf-sync region <key>`

Print one region as JSON.

- returns from runtime state immediately if that region is already available
- falls back to stable data when possible
- fetches the region on demand when it is missing and credentials are available

```bash
cf-sync region eu10
cf-sync region eu10 --no-refresh
```

Option:

- `--no-refresh`: read cached package-managed data only

## Output Files

The package manages these files under `~/.saptools/`:

```text
~/.saptools/cf-structure.json
~/.saptools/cf-sync-state.json
```

- `cf-structure.json`: last successful full sync
- `cf-sync-state.json`: active runtime state used for partial reads and sync metadata

Services should prefer the CLI read commands or exported APIs instead of opening these files directly.

## Programmatic Usage

```ts
import {
  findRegion,
  getRegionView,
  readRegionsView,
  readStructure,
  readStructureView,
  runSync,
} from "@saptools/cf-sync";

const result = await runSync({
  email: process.env["SAP_EMAIL"] ?? "",
  password: process.env["SAP_PASSWORD"] ?? "",
  onlyRegions: ["ap10", "ap11"],
  interactive: false,
});

console.log(result.accessibleRegions.length);

const structure = await readStructure();
const ap10 = structure ? findRegion(structure, "ap10") : undefined;
console.log(ap10?.orgs.length ?? 0);

const view = await readStructureView();
console.log(view?.metadata?.status);

const regions = await readRegionsView();
console.log(regions.regions.map((region) => region.key));

const eu10 = await getRegionView({
  regionKey: "eu10",
  email: process.env["SAP_EMAIL"],
  password: process.env["SAP_PASSWORD"],
});
console.log(eu10?.source);
```

Useful exports include:

- `runSync`
- `readStructure`
- `readStructureView`
- `readRegionsView`
- `readRegionView`
- `getRegionView`
- `findRegion`
- `findOrg`
- `findSpace`
- `findApp`

## Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-sync build
pnpm --filter @saptools/cf-sync typecheck
pnpm --filter @saptools/cf-sync test:unit
pnpm --filter @saptools/cf-sync test:e2e
```

## License

MIT
