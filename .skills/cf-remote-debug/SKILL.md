---
name: cf-remote-debug
description: Guide on how to remotely debug SAP BTP Cloud Foundry Node.js applications, search and view compiled JS code, and capture live runtime snapshots to debug errors and explore how the code works.
---

# CF Remote Debugging Workflow

This skill defines the correct workflow for debugging a Node.js application on SAP Cloud Foundry.

**Important**: Do not guess command syntax. You MUST read the base skill files for both `cf-explorer` and `cf-inspector` to fully understand all available commands and flags. This guide focuses strictly on the integration workflow and avoiding common pitfalls.

## The Debugging Workflow

### Step 1: Find the Compiled JS Target (`cf-explorer`)
TypeScript compilation alters line numbers, and source maps on CF are often misaligned. You must find the exact `.js` file and line number directly on the server.
1. Run `cf-explorer roots` to discover where the application source is mounted.
2. Choose the appropriate `cf-explorer` command (`grep`, `find`, `ls`, `view`, etc.) to locate your target function and understand its context within the compiled files.

> **CRITICAL RULE**: Never blindly use line numbers from your local `.ts` files for breakpoints. Always target the exact compiled `.js` line number discovered via `cf-explorer`.

### Step 2: Capture Live State (`cf-inspector`)
Once you have the exact compiled JS file path and line number, use `cf-inspector` to observe the runtime state.
1. Use `cf-inspector snapshot` (for one-off captures), `watch` (for multiple hits), or `exception` (to catch errors).
2. For the breakpoint path, provide a relative path matching the end of the file path (e.g., `src/handlers/MyRequestHandler.js:42`), excluding the absolute root.
3. **Background Execution**: When setting breakpoints that require an incoming API request to trigger, launch the `cf-inspector` tool in the background (using `WaitMsBeforeAsync`), then instruct the user to trigger the API.
