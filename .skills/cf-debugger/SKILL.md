---
name: cf-debugger
description: Use when opening a Node.js inspector tunnel, debugging a SAP BTP CF app, or forwarding port 9229 from an app using the cf-debugger CLI.
---

# CF Debugger

## Purpose

Use `cf-debugger` to open an SSH tunnel to a Node.js inspector for a Cloud Foundry app. This is useful for attaching a debugger (like VSCode or Chrome DevTools) to a running SAP BTP Cloud Foundry app. It automatically handles `cf auth`, enabling SSH if disabled, sending `SIGUSR1` to the Node process, and setting up the port forward.

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

## Troubleshooting

- **Error: "No current CF target found"**: The user used a bare app name but hasn't run `cf target` recently. Use the full `<region>/<org>/<space>/<app>` selector.
- **Error: "SESSION_ALREADY_RUNNING"**: There is already an active debugger session for this app. Use `cf-debugger list` to see it.
- **Error: "SSH_NOT_ENABLED"**: The app or space doesn't allow SSH. Ensure that SSH is allowed at the space level and the CLI successfully restarted the app to enable it.
- **Error: "TUNNEL_NOT_READY"**: The app might not be a Node.js app, or the Node.js process didn't start the inspector when it received `SIGUSR1`. Verify the app is a Node app.
