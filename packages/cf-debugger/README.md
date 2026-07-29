# `@saptools/cf-debugger`

Open a verified Node.js inspector tunnel to an SAP BTP Cloud Foundry app from one
command. Each concurrent session has its own local port, isolated `CF_HOME`, and
lock-guarded state entry.

## Install

```bash
npm install -g @saptools/cf-debugger
```

Node.js 20+ and the official `cf` CLI are required. CF CLI v8 is recommended.
Non-`web` process targeting uses `cf ssh --process` and requires CF CLI v7+.
On macOS, `lsof` is a soft dependency used to prove which PID owns a local
listening port. Install it if `cf-debugger` reports `TUNNEL_OWNER_UNVERIFIED`.
Without it, an explicit stop refuses to signal a state-recorded PID whose port
ownership cannot be proved; teardown still completes when the spawned child is
independently confirmed dead.

## Quick start

```bash
export SAP_EMAIL="you@company.com"
export SAP_PASSWORD="your-sap-password"

cf-debugger start \
  --region eu10 \
  --org my-org \
  --space dev \
  --app my-app \
  --verbose
```

Successful output includes the complete attachment target:

```text
Debugger ready for my-app (eu10/my-org/dev).
  Process:     web
  Instance:    0
  Local port:  20142
  Remote port: 9229
  Session id:  550e8400-e29b-41d4-a716-446655440000
  Tunnel PID:  83421
  Node PID:    4312
Press Ctrl+C to stop.
```

Attach the IDE to `127.0.0.1:20142`. Node derives the advertised
`webSocketDebuggerUrl` from the incoming request's `Host` header, so a URL
returned through the forward already names the local forwarded port and is
directly usable. `cf-debugger` validates that the URL is well formed but does
not print or follow it.

## CLI

### `start`

```bash
cf-debugger start --region eu10 --org my-org --space dev --app my-app
cf-debugger start eu10/my-org/dev/my-app --remote-port 9230
cf-debugger start my-app --process worker --instance 2 --node-pid 4312
cf-debugger start my-app --startup-timeout 300 --timeout 180 --verbose
```

When region, org, or space is omitted, the current `cf target` supplies it.

| Flag | Meaning |
| --- | --- |
| `--region <key>` | SAP region key; defaults to the current CF target |
| `--api-endpoint <url>` | Absolute HTTPS endpoint override, including private/nonstandard hosts |
| `--org <name>`, `--space <name>`, `--app <name>` | CF target and app |
| `--process <name>` | CF process, default `web` |
| `-i, --instance <index>` | Zero-based process instance, default `0` |
| `--node-pid <pid>` | Exact remote Node PID |
| `--port <number>` | Preferred local port; otherwise choose from `20000–20999` |
| `--remote-port <number>` | Port where cf-debugger looks for an existing remote inspector, default `9229` |
| `--timeout <seconds>` | Local-tunnel and inspector-readiness budget, default `180` |
| `--startup-timeout <seconds>` | Overall startup deadline, default `300`, maximum `1800` |
| `--allow-ssh-enable-restart` | Permit app-level SSH enablement and one app restart |
| `--no-ssh-enable-restart` | Explicitly forbid that mutation, overriding flag/environment |
| `--verbose` | Print status, retry, and redacted tunnel transport diagnostics |

> [!IMPORTANT]
> App restart is opt-in in 0.2.0. By default, a disabled-SSH app fails with
> `SSH_NOT_ENABLED` and no deployment mutation. Use
> `--allow-ssh-enable-restart`, or set `CF_DEBUGGER_ALLOW_RESTART=1`, only when
> restarting the named app is acceptable. `CF_DEBUGGER_ALLOW_RESTART=0` keeps
> the guard enabled for a production shell and also vetoes a programmatic
> `allowSshEnableRestart: true`. The environment value `1` can opt in the CLI,
> but never grants permission to a programmatic caller by itself.

`--api-endpoint` accepts arbitrary hostnames but requires an absolute `https:`
URL with no userinfo, query, fragment, or non-root path. Invalid values are
rejected before `cf api` or `cf auth`. Version 0.2.2 intentionally rejects
plaintext `http://` landscapes because credentials would be sent to that
endpoint.

Even with permission, a restart occurs only when all of these are true:

1. the one-shot SSH error specifically says SSH support is disabled;
2. `cf ssh-enabled <app>` proves app-level SSH is disabled;
3. this invocation runs `cf enable-ssh <app>`;
4. a second probe proves app-level SSH is now enabled.

An unknown probe result, an already-enabled app, a permission error, or a
space-level SSH policy never causes a restart. Before an allowed restart,
stderr names the app and org/space. With an explicit `--node-pid`, automatic
restart is always rejected because the container replacement invalidates that
PID.

Read-only CF commands have a 60-second per-attempt cap and retry transient
transport errors with bounded exponential delays while the single overall
startup budget still has time. Deployment-mutating commands have a separate
180-second cap and are never retried: a timed-out enable/restart reports
`CF_MUTATION_TIMEOUT` because the server-side mutation may still be completing.
`cf auth` has no outer retry loop, and rejected credentials fail after one
attempt; repeated manual failures may count toward a tenant's identity-provider
lockout policy. The one-shot SSH signal and readiness wait are also clamped to
the same overall deadline. No retry configuration multiplies startup work past
`--startup-timeout`. After a timeout, fail-closed tunnel and state cleanup still
runs; that safety teardown can briefly extend the observed command wall time
rather than abandoning an unverified child.

### `stop`

```bash
cf-debugger stop --session-id 550e8400-e29b-41d4-a716-446655440000
cf-debugger stop eu10/my-org/dev/my-app
cf-debugger stop my-app --api-endpoint https://api.cf.eu10.hana.ondemand.com
cf-debugger stop my-app --node-pid 4312
cf-debugger stop --all
cf-debugger stop --session-id 550e8400-e29b-41d4-a716-446655440000 --force
```

`stop --all` attempts every local session, reports stopped, forced, stale,
pending, and failed outcomes separately, and exits `70` if any tunnel cleanup
failed (`1` for other failures). It cannot
be combined with a positional selector, `--session-id`, or target selector
options; ambiguous scope is rejected instead of widening to every session.

`stop --force` means “forget safely,” not “kill harder.” It never signals a PID
whose tunnel ownership is unproven. It forgets the state record first, then
best-effort removes only the exact derived v2 `CF_HOME`. A deletion failure is
non-fatal and warns that the retained path may contain a live refresh token;
`doctor` then reports it as an orphan eligible for `doctor --cleanup`. The
warning also names the abandoned PID and port for manual investigation. If a
damaged record names a non-owned home path, that path is left untouched while
the record is still forgotten.

### `list` and `status`

```bash
cf-debugger list
cf-debugger status --session-id 550e8400-e29b-41d4-a716-446655440000
cf-debugger status eu10/my-org/dev/my-app --api-endpoint https://api.example
```

`list` prunes only records proven stale. PID liveness is paired with an optional
OS process-start token to detect PID reuse; older records without the additive
token retain the compatible PID-only check. A ready record is healthy only when
the complete listener-owner set contains its recorded tunnel PID. Ownership
that cannot be inspected remains explicit rather than being guessed.

`status` prints `null` only when no exact session matches. Ambiguity is a coded
`SESSION_AMBIGUOUS` failure; refine with session ID, API endpoint, or Node PID.

### `doctor`

```bash
cf-debugger doctor
cf-debugger doctor --cleanup
```

The default is read-only JSON reporting. It includes:

- every local state record with its health verdict and reason;
- v2 session homes with no state record;
- listeners in `20000–20999` that no state record claims;
- leftover state temp, lock, recovery, stop-intent, and corrupt-backup files;
- legacy v1 state/homes, home count, parseable claimed sessions, conservative
  PID liveness, and their credential-retention risk.

`--cleanup` removes only canonical orphan v2 homes and sufficiently old,
package-owned temp/lock/recovery/stop-intent artifacts. It revalidates orphan
homes against lock-guarded state immediately before deletion. It never signals
an unclaimed listener, removes corrupt evidence, or removes legacy v1 artifacts.
Corrupt backups include a manual-removal command in the report while remaining
ineligible for automatic cleanup. A symlinked v2 homes root is reported and
never traversed.

## Region resolution

Curated region keys are available from `listKnownRegionKeys()`. Keys matching
`aa00` or `aa00-000` also work before the curated table is updated:
`cf-debugger` synthesizes `https://api.cf.<key>.hana.ondemand.com`, or the
`.platform.sapcloud.cn` domain for `cn*`, and warns with the synthesized URL.
This supports new regions but makes a syntactically valid typo such as `eu99`
reach DNS; verify the warning or use `--api-endpoint`. Malformed keys fail early
with `UNKNOWN_REGION`.

## How it works

1. Resolve and validate the endpoint, deadline, target, and credentials.
2. Prune only provably stale state and register a unique session/port.
3. Run `cf api`, environment-only `cf auth`, `cf target`, and an app existence check.
4. Probe the selected instance through one-shot `cf ssh`.
5. If an inspector already owns the remote port and is Node, reuse that PID.
6. Otherwise:
   - choose the sole Node PID when exactly one exists;
   - with several Node PIDs, use the app `$PORT` listener only as a tiebreaker;
   - otherwise fail `NODE_PROCESS_AMBIGUOUS`.
7. Send `SIGUSR1` when needed and prove the selected PID owns the configured
   remote inspector port.
8. Spawn detached `cf ssh -N -L <local>:localhost:<remote>`.
9. Prove the spawned PID is among all owners of the local listener.
10. Request `GET /json/list` through the tunnel and require HTTP 200 plus a
    non-empty target array whose first entry has a well-formed
    `webSocketDebuggerUrl`.
11. Persist `ready` state and return a `DebuggerHandle`.

Node's Linux `cluster` default can leave the app `$PORT` socket owned by the
cluster primary rather than a request-handling worker. When several Node
processes exist, inspect the reported candidates and pass `--node-pid`
explicitly if a worker is the intended target.

The remote probe reads `/proc/<pid>/exe`, not argv. Its marker lines are filtered
by a strict `saptools-inspector-*` prefix, so CF SSH banners cannot impersonate
results. GNU `find -lname` is capability-probed and is normally fast; the
portable fallback walks descriptors with `readlink` and can take roughly
10–12 seconds in a descriptor-heavy non-GNU container.

`--remote-port` does not choose the port opened by `SIGUSR1`; Node always uses
its default inspector port for that signal. A non-default value is therefore
for an app already started with matching `--inspect=<port>`.

### Status sequence

The public `onStatus` sequence is:

```text
starting → logging-in → targeting → signaling
         → [ssh-enabling → ssh-restarting → signaling]
         → tunneling → ready → stopping → stopped
```

Verbose retries repeat the current phase with a message and remaining budget.
After `starting` is emitted, startup failure emits terminal `error` and never
follows it with `stopped`. Option/credential/region validation can reject before
the status stream begins, in which case no callback is emitted.
Unexpected tunnel failure after readiness likewise emits terminal `error`;
cleanup still runs without claiming a normal stop sequence.

## State and security

```text
~/.saptools/cf-debugger-state-v2.json
~/.saptools/cf-debugger-state-v2.lock
~/.saptools/cf-debugger-homes-v2/<sessionId>/
```

State is written as a `0600` temp file plus atomic rename while a token-owned
`open(..., "wx")` lock is held. The parent and session-home directories are
`0700`. Keep `~/.saptools` on a local filesystem: exclusive-create locking is
not reliably atomic on every NFS/SMB implementation. A generous age fallback
recovers foreign-host lock files, but it cannot make a network filesystem's
locking semantics safe.

Each isolated `CF_HOME` contains CF CLI credentials, including a live refresh
token. A clean stop removes it. If `TUNNEL_TERMINATION_FAILED` retains state and
the home, recover the process first, then run `stop --force`. If a record has
already disappeared but its canonical home remains, use `doctor --cleanup`.
Do not leave recovered homes indefinitely.

A damaged entry no longer erases healthy sessions. Invalid entries are dropped
individually, and the original state file is moved to a private
`.corrupt-<timestamp>-<uuid>` backup before any repair. Completely invalid JSON,
version, or root shape is likewise preserved before a fresh empty v2 file is
written.

During mixed-version use, an older cf-debugger sharing this v2 file may strip
optional fields it does not understand, including process-identity and startup
budget data. Newer code treats an absent/legacy identity as “cannot tell” and
retains the record with PID-only compatibility rather than pruning it; `doctor`
surfaces that degraded verdict. Updating every installed consumer is the only
way to restore the stronger identity check persistently.

Legacy `~/.saptools/cf-debugger-homes/` directories may still contain live
refresh and access tokens. `doctor` reports but never deletes them. After
confirming no v1 tunnel is running, remove them explicitly:

```bash
rm -rf "$HOME/.saptools/cf-debugger-homes" \
       "$HOME/.saptools/cf-debugger-state.json" \
       "$HOME/.saptools/cf-debugger-state.lock"
```

The v2 CLI never adopts or mutates v1 sessions. Prefer CLI/API operations over
editing the v2 JSON by hand.

Credentials are passed to `cf auth` as `CF_USERNAME` and `CF_PASSWORD` in the
child environment, never argv. CF command and tunnel diagnostics are bounded
and redact sensitive values before they reach errors or verbose output.
`CF_COLOR=false` is forced so ANSI escapes cannot corrupt output parsing.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `SAP_EMAIL`, `SAP_PASSWORD` | CF authentication credentials |
| `CF_DEBUGGER_ALLOW_RESTART=0\|1` | CLI default; `0` is also a hard veto for the programmatic API |
| `CF_DEBUGGER_CF_BIN` | Replace the `cf` executable; useful for wrappers and deterministic test stubs |

A caller-provided child environment cannot override the per-session `CF_HOME`.

## Errors and exit status

Documented domain failures use `Error [CODE]: ...`. An unexpected operating
system or filesystem failure can still surface as a plain `Error` without a
domain code; it is never converted into success.

| Code | Meaning |
| --- | --- |
| `UNKNOWN_REGION`, `UNSAFE_INPUT`, `MISSING_CREDENTIALS` | Invalid endpoint/key, selector, numeric input, or credentials |
| `CF_LOGIN_FAILED`, `CF_AUTH_FAILED`, `CF_TARGET_FAILED`, `CF_CLI_FAILED`, `CF_CLI_TIMEOUT` | CF command failure; rejected auth is not retried |
| `CF_MUTATION_TIMEOUT` | A deployment mutation timed out, was not retried, and may still be completing remotely |
| `STARTUP_TIMEOUT`, `ABORTED` | Overall deadline expired, or caller/stop intent cancelled startup |
| `APP_NOT_FOUND` | The targeted app does not exist in the selected org/space |
| `SSH_NOT_ENABLED`, `SSH_PERMISSION_DENIED`, `SSH_STATE_UNKNOWN` | Restart refused/not useful, permission denied, or SSH state ambiguous |
| `NODE_PID_RESTART_UNSAFE` | Explicit PID cannot survive an app restart |
| `NODE_PROCESS_NOT_FOUND`, `NODE_PROCESS_AMBIGUOUS`, `NODE_PID_INVALID` | Remote Node selection failed closed |
| `USR1_SIGNAL_FAILED`, `INSPECTOR_NOT_READY`, `INSPECTOR_OWNER_MISMATCH`, `INSPECTOR_OUTPUT_TOO_LARGE` | Remote signal/ownership protocol failed |
| `TUNNEL_NOT_READY` | The spawned local forward did not bind |
| `PORT_UNAVAILABLE`, `TUNNEL_PROCESS_MISSING` | Local port allocation failed, or the spawned tunnel exposed no PID |
| `TUNNEL_OWNER_UNVERIFIED`, `TUNNEL_OWNER_MISMATCH` | Local listener ownership could not be proved |
| `INSPECTOR_UNREACHABLE` | Local forward bound, but `/json/list` did not prove an attachable remote inspector |
| `TUNNEL_EXITED`, `TUNNEL_TERMINATION_FAILED`, `TUNNEL_OWNERSHIP_UNVERIFIED` | Tunnel died, cleanup could not terminate it, or stop could not safely signal it |
| `SESSION_ALREADY_RUNNING`, `SESSION_AMBIGUOUS`, `SESSION_NOT_FOUND` | Session selection conflict |
| `SESSION_STATE_LOST`, `SESSION_STATE_CONFLICT`, `STATE_LOCK_TIMEOUT` | Atomic state/lifecycle invariant failed |
| `CF_HOME_CLEANUP_FAILED` | Session state was removed but lifecycle cleanup could not remove its exact credential-bearing CF home |
| `PACKAGE_METADATA_INVALID` | Runtime package metadata has no usable version |
| `STOP_FAILED` | One entry in a batch stop failed with a non-coded internal error |

| Exit | Meaning |
| --- | --- |
| `0` | Clean completion |
| `1` | Coded operational/startup error, including `STARTUP_TIMEOUT` |
| `70` | Tunnel or lifecycle cleanup failed; ownership state or a credential-bearing home may remain |
| SSH child's nonzero code | An unexpected numeric SSH exit is preserved, for example `255` |
| `128 + signal` | Tunnel child died from a signal, for example `137` for `SIGKILL` |
| `130`, `143` | User interrupted with `SIGINT` or `SIGTERM` |

## Programmatic API

```ts
import {
  startDebugger,
  stopDebugger,
  stopAllDebuggers,
  listSessions,
  runDoctor,
} from "@saptools/cf-debugger";

const handle = await startDebugger({
  region: "eu10",
  org: "my-org",
  space: "dev",
  app: "my-app",
  startupTimeoutMs: 300_000,
  allowSshEnableRestart: false,
});

// Attach to handle.session.localPort.
await handle.dispose();

const summary = await stopAllDebuggers();
// Outcomes and counts distinguish stopped/forced/stale/pending/failed.
```

Persisted schema additions in 0.2.0 are optional. Absence means compatible
fallback behavior because an older mixed-version writer may strip fields it
does not know. State remains version `"2"`.

## FAQ

### Does this modify the remote app?

Not by default. Inspector activation sends `SIGUSR1` to the verified Node
process, but app-level SSH enablement and `cf restart` require explicit
`--allow-ssh-enable-restart` permission. Even with permission, restart occurs
only after this run changes app SSH from proven disabled to proven enabled; an
already-enabled, unknown, permission-denied, or space-policy result never
restarts the app.

### Is session state always removed when the CLI exits?

Only after cleanup is verified. `TUNNEL_TERMINATION_FAILED` deliberately retains
state and the isolated credential-bearing `CF_HOME`; recover it with `doctor`
and `stop --force` instead of assuming the next `start` can proceed.

## Development

```bash
pnpm --filter @saptools/cf-debugger lint
pnpm --filter @saptools/cf-debugger typecheck
pnpm --filter @saptools/cf-debugger test:unit
pnpm --filter @saptools/cf-debugger build
```

The fake-backed tests set `CF_DEBUGGER_CF_BIN`. Live E2E tests require a safe
non-production CF target and credentials; do not run them against production.
