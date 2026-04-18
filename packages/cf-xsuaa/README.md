# `@saptools/cf-xsuaa`

Fetch XSUAA credentials and OAuth2 access tokens from SAP BTP Cloud Foundry apps.

The package reads an app's `VCAP_SERVICES` via `cf env`, extracts the XSUAA binding, caches the client credentials to disk, and exchanges them for OAuth2 `client_credentials` tokens. Subsequent calls reuse cached tokens until they expire, so interactive tools and CI pipelines avoid unnecessary round-trips to the UAA.

Repository: https://github.com/dongitran/saptools/tree/main/packages/cf-xsuaa

## Install

Use it as a CLI:

```bash
npm install -g @saptools/cf-xsuaa
```

Or as a dependency:

```bash
npm install @saptools/cf-xsuaa
```

## Requirements

- `Node.js >= 20`
- `cf` CLI installed and available on `PATH`
- `SAP_EMAIL`
- `SAP_PASSWORD`
- An existing `~/.saptools/cf-structure.json` produced by [`@saptools/cf-sync`](https://www.npmjs.com/package/@saptools/cf-sync) so the package can resolve the region's API endpoint

Example:

```bash
export SAP_EMAIL="your.name@company.com"
export SAP_PASSWORD="your-password"
```

Credentials are only consulted when `cf-xsuaa` needs to refresh the VCAP-bound client secret. Once a secret is cached, token refreshes go straight to the UAA and do not require `SAP_EMAIL` / `SAP_PASSWORD`.

## CLI

Every command identifies an app with the same four flags:

- `-r, --region <key>`: CF region key (e.g. `ap10`, `eu10`)
- `-o, --org <name>`: CF org name
- `-s, --space <name>`: CF space name
- `-a, --app <name>`: CF app name

### `cf-xsuaa fetch-secret`

Fetch the XSUAA client credentials from the app's `VCAP_SERVICES` and save them to disk.

Use this once per app, or whenever the binding rotates.

```bash
cf-xsuaa fetch-secret --region ap10 --org my-org --space dev --app my-srv
```

### `cf-xsuaa get-token`

Fetch a fresh OAuth2 `client_credentials` access token. Prints the JWT to stdout.

If no secret is cached yet, the command will auto-run `fetch-secret` first.

```bash
cf-xsuaa get-token --region ap10 --org my-org --space dev --app my-srv
```

### `cf-xsuaa get-token-cached`

Return the cached token if it is still valid, otherwise fetch a new one. Best choice for interactive use and pipelines that call the UAA repeatedly.

```bash
cf-xsuaa get-token-cached --region ap10 --org my-org --space dev --app my-srv
```

The expiry buffer is 45 seconds — tokens are considered expired 45 seconds before their `exp` claim so the caller never uses a nearly-expired token.

## Output Files

The package manages one file under `~/.saptools/`:

```text
~/.saptools/xsuaa-data.json
```

Shape:

```jsonc
{
  "version": 1,
  "entries": [
    {
      "region": "ap10",
      "org": "my-org",
      "space": "dev",
      "app": "my-srv",
      "credentials": {
        "clientId": "sb-xsappname!t123",
        "clientSecret": "<redacted>",
        "url": "https://my-org.authentication.ap10.hana.ondemand.com",
        "xsappname": "my-app!t123"
      },
      "token": {
        "accessToken": "eyJhbGciOi...",
        "expiresAt": "2026-04-18T12:34:56.000Z"
      },
      "fetchedAt": "2026-04-18T12:20:00.000Z"
    }
  ]
}
```

Services should prefer the CLI commands or exported APIs over parsing this file directly.

## Programmatic Usage

```ts
import {
  fetchSecret,
  getToken,
  getTokenCached,
  readStore,
  xsuaaDataPath,
} from "@saptools/cf-xsuaa";

const ref = {
  region: "ap10",
  org: "my-org",
  space: "dev",
  app: "my-srv",
};

// One-time: cache the client credentials
await fetchSecret(ref);

// Every call: re-use a cached token when possible
const token = await getTokenCached(ref);

// Or: force a fresh token
const freshToken = await getToken(ref);

const store = await readStore();
console.log(store.entries.length, "apps cached in", xsuaaDataPath());
```

Every command accepts options for dependency injection, useful for tests:

```ts
await getToken(ref, {
  fetchCredentials: async () => ({
    clientId: "cid",
    clientSecret: "csec",
    url: "https://uaa.example.com",
  }),
  fetchToken: async () => "fake-jwt",
  now: new Date("2026-04-18T00:00:00Z"),
});
```

Useful exports include:

- `fetchSecret`
- `getToken`
- `getTokenCached`
- `readStore`
- `writeStore`
- `findEntry`
- `upsertSecret`
- `upsertToken`
- `fetchClientCredentialsToken`
- `parseXsuaaFromVcap`
- `decodeJwtPayload`
- `computeExpiryIso`
- `isExpired`
- `xsuaaDataPath`
- `saptoolsDir`

## Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/cf-xsuaa build
pnpm --filter @saptools/cf-xsuaa typecheck
pnpm --filter @saptools/cf-xsuaa test:unit
pnpm --filter @saptools/cf-xsuaa test:e2e
```

The e2e suite auto-discovers a real CF app with an `xsuaa` service binding by scoring candidates from `~/.saptools/cf-structure.json`. To pin a specific target, set:

```bash
export E2E_TARGET="ap10/my-org/my-space/my-srv"
```

## License

MIT
