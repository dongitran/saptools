---
name: cf-explorer
description: Use when exploring deployed SAP BTP CF app files, searching code (grep), viewing file contents, locating app roots, or inspecting runtime candidate lines through the cf-explorer CLI.
---

# CF Explorer

## Purpose

Use `cf-explorer` to safely explore the files and code of a live SAP BTP Cloud Foundry app container. Prefer it when the task requires searching for code in a running app, inspecting configurations, locating where an app is deployed in the container, or getting context around a specific line of code.

If `cf-explorer` is missing, install it: `npm install -g @saptools/cf-explorer`.

## First Steps

1. Identify what the user needs to find: the app root, a specific file, a text pattern (grep), or line context (view).
2. `--app` is always required. `--region`, `--org`, and `--space` are optional and will automatically resolve if a current `cf target` is active. If the resolution fails (no target set), you must explicitly pass the full target. Note: there are no short flags (like `-a`); always use `--app`.
3. Keep discovery read-only for remote files; `cf-explorer` automatically enables SSH and restarts the app when SSH is disabled.
4. Use single-shot commands for quick lookups. If you need to run multiple `ls`, `grep`, or `view` commands back-to-back, consider starting a persistent `session` to avoid the overhead of opening multiple SSH connections.
5. All discovery commands support `--json` for structured output and `--no-json` for human-readable output.

## Command Choice

**Discovery (Single-shot):**

Find likely application root directories:
```bash
cf-explorer roots --app app-demo
```

List files under a directory:
```bash
cf-explorer ls --app app-demo --path /home/vcap/app
```

Search for a filename:
```bash
cf-explorer find --app app-demo --root /home/vcap/app --name "*handler*.js"
```

Search for text (grep) inside files:
```bash
cf-explorer grep --app app-demo --root /home/vcap/app --text "needle"
```

Read file context around a specific line (e.g., line 42 with 5 lines of context):
```bash
cf-explorer view --app app-demo --file /home/vcap/app/src/index.js --line 42 --context 5
```

Generate reusable file/line candidates for other tools:
```bash
cf-explorer inspect-candidates --app app-demo --text "needle"
```

**Persistent Sessions (For repeated reads):**

Start a session to keep the SSH broker alive:
```bash
cf-explorer session start --app app-demo
```
This returns a response containing a `sessionId`.

Reuse the session for fast reads:
```bash
cf-explorer session grep --session-id <id> --root /home/vcap/app --text "needle"
cf-explorer session view --session-id <id> --file /home/vcap/app/src/index.js --line 42
cf-explorer session stop --session-id <id>
```

## Troubleshooting

- **Error: "No current CF target found"**: The user hasn't run `cf target` and didn't provide `--region`, `--org`, `--space`. Pass them explicitly via flags.
- **Timeouts / Output Limit Exceeded**: Use `--max-files`, `--max-bytes`, or `--timeout` to adjust limits on broad searches.
- **Empty Grep Results**: Ensure the `--root` path is correct (use `roots` command to discover it) and the `--text` is exact.
