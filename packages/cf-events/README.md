# @saptools/cf-events

Inspect SAP BTP Cloud Foundry application **audit events** and detect active
**SSH / debug sessions** from the command line. Point it at a
`region/org/space/app` target and it answers questions like "what just happened
to this app?", "is anyone SSH'd into it right now?", and "why did it crash?".

`cf-events` reuses [`@saptools/cf-sync`](https://github.com/dongitran/saptools/tree/main/packages/cf-sync)
for the synced `region/org/space/app` topology, then calls the Cloud Foundry v3
API (`/v3/audit_events`, process stats, SSH status) through the `cf` CLI.

## Prerequisites

- Node.js >= 20.
- The [Cloud Foundry CLI v8+](https://github.com/cloudfoundry/cli) on `PATH`.
- A topology snapshot produced by `cf-sync`. Run `cf-sync sync` (or a targeted
  `cf-sync space <region> <org> <space>`) once so `cf-events` can resolve and
  validate selectors. The snapshot lives at `~/.saptools/cf-structure.json`.

## Install

```bash
npm install -g @saptools/cf-events
# or run it on demand
npx @saptools/cf-events --help
```

## Authentication

Credentials are read from environment variables (preferred) or flags:

```bash
export SAP_EMAIL="you@example.com"
export SAP_PASSWORD="your-password"
```

Every command also accepts `--email` and `--password`. Credentials are passed
to the `cf` CLI through the environment, never on the command line, and each
invocation runs in an isolated, ephemeral `CF_HOME`.

## Selectors

Every command takes a single positional selector:

- A full path: `ap10/my-org/dev/orders-srv`.
- A bare app name: `orders-srv` — resolved against the `cf-sync` snapshot. If
  the name is ambiguous across spaces, `cf-events` lists the candidates and
  asks for a full path.

## Commands

### `events <selector>`

List recent audit events for an app (deployments, restarts, scaling, crashes,
SSH activity, ...).

```bash
cf-events events ap10/my-org/dev/orders-srv
cf-events events orders-srv --limit 100 --since 6h
cf-events events orders-srv --type ssh --json
```

Options: `--limit <count>` (default 50), `--since <duration>` (e.g. `30m`,
`6h`, `7d`), `--type <types>` (comma-separated CF event types, or the
shorthand `ssh` / `crash`), `--json`.

### `ssh-status <selector>`

Show whether SSH is enabled for the app and surface recent SSH / debug
activity: who opened a session and when, plus any denied attempts.

```bash
cf-events ssh-status orders-srv
cf-events ssh-status orders-srv --since 7d --json
```

Options: `--since <duration>` (default `24h`), `--json`.

> Cloud Foundry exposes no live-session API and emits no event when an SSH
> session closes. `cf-events` therefore *infers* "likely active" sessions from
> recent `ssh-authorized` audit events — treat it as a strong hint, not proof.

### `crashes <selector>`

Summarize recent crash events: how many, the most recent one, and the exit
reason.

```bash
cf-events crashes orders-srv
cf-events crashes orders-srv --since 24h --json
```

Options: `--limit <count>` (default 50), `--since <duration>`, `--json`.

### `status <selector>`

A one-glance health view: requested state, per-instance state / uptime / CPU /
memory, the SSH-enabled flag, and the most recent audit event.

```bash
cf-events status orders-srv --json
```

### `watch <selector>`

Poll `/v3/audit_events` on an interval and print new events as they appear.
Press `Ctrl+C` to stop.

```bash
cf-events watch orders-srv
cf-events watch orders-srv --interval 30000 --type crash
```

Options: `--interval <ms>` (default 15000, minimum 2000), `--lookback
<duration>` (initial window on start, default `2m`), `--type <types>`,
`--json` (line-delimited JSON).

## Programmatic use

The package also ships a typed library entry:

```ts
import { CfEventsRuntime } from "@saptools/cf-events";

const runtime = new CfEventsRuntime();
const events = await runtime.fetchEvents("orders-srv", credentials, {
  limit: 50,
  since: "6h",
  types: [],
});
```

## License

MIT
