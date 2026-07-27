---
name: cf-debugger
description: Use when opening a Node.js inspector tunnel, debugging a SAP BTP CF app, or forwarding port 9229 from an app using the cf-debugger CLI.
---

# CF Debugger

## Purpose

Use `cf-debugger` to open an SSH tunnel to a Node.js inspector for a Cloud Foundry app. This is useful for attaching a debugger (like VSCode or Chrome DevTools) to a running SAP BTP Cloud Foundry app. It handles `cf auth`, selects and signals a verified Node PID, opens the port forward, proves the local listener belongs to the spawned tunnel, and verifies an attachable `/json/list` response through it.

App-level SSH enablement and restart are opt-in. Never add
`--allow-ssh-enable-restart` unless the user has confirmed that restarting the
named app in the named org/space is acceptable.

If `cf-debugger` is missing, install it: `npm install -g @saptools/cf-debugger`.

## First Steps

1. Identify the app the user wants to debug. The app must be running Node.js.
2. An app selector (either `<app>` or `<region>/<org>/<space>/<app>`) can be used as a positional argument. If the bare app name is used, the CLI will try to infer the region, org, and space from the current `cf target`. If that fails, ask the user for the full target or pass them explicitly.
3. The debugger tunnel is persistent until stopped with `cf-debugger stop`.
4. Ensure the credentials (`SAP_EMAIL` and `SAP_PASSWORD`) are available in the environment to perform `cf auth` if needed.

## Command Choice

Start a debug session:
```bash
cf-debugger start app-demo
# Or using the full selector if no current target is set:
cf-debugger start eu10/my-org/dev/app-demo
```
This will output the local port (e.g., `20142`) that the debugger is forwarded to. The user can then attach their IDE to `localhost:20142`.

List active sessions:
```bash
cf-debugger list
```

Check the status of a specific session:
```bash
cf-debugger status app-demo
```

Stop a specific session:
```bash
cf-debugger stop app-demo
```

Stop all active sessions:
```bash
cf-debugger stop --all
```

Inspect state, orphan homes/ports, and legacy token-bearing artifacts without
changing anything:

```bash
cf-debugger doctor
```

If ownership cannot be verified, `stop --force --session-id <id>` may forget the
record and delete only its exact owned v2 `CF_HOME`. It never signals the
unverified PID or the process currently holding the port.

## Troubleshooting

- **Error: "No current CF target found"**: The user used a bare app name but hasn't run `cf target` recently. Use the full `<region>/<org>/<space>/<app>` selector.
- **Error: "SESSION_ALREADY_RUNNING"**: There is already an active debugger session for this app. Use `cf-debugger list` to see it.
- **Error: "SSH_NOT_ENABLED"**: No restart was performed. Check space-level SSH and roles; either enable/restart manually or, only with the user's approval, retry with `--allow-ssh-enable-restart`.
- **Error: "TUNNEL_NOT_READY"**: The spawned local forward never bound. Use the retained/redacted CF SSH stderr to diagnose transport/authentication.
- **Error: "INSPECTOR_UNREACHABLE"**: The local forward bound, but `/json/list` did not prove an attachable remote inspector. The app/container may have restarted, the inspector may not have opened, or a different Node PID may own it.
- **Error: "TUNNEL_OWNERSHIP_UNVERIFIED"**: Do not kill the PID or port owner by guess. Use `cf-debugger doctor`, then `stop --force --session-id <id>` only to clear unrecoverable state.

On macOS, local ownership verification uses `lsof`. The CLI names this soft
dependency when it is unavailable.
