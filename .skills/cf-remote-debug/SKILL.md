---
name: cf-remote-debug
description: Guide on how to remotely debug SAP BTP Cloud Foundry Node.js applications by combining deployed compiled JS discovery, live HTTP request/response traces, runtime inspector snapshots, and read-only HANA evidence when debugging errors or exploring runtime behavior.
---

# CF Remote Debugging Workflow

This skill defines the correct workflow for debugging a Node.js application on SAP Cloud Foundry.

**Important**: Do not guess command syntax. You MUST read the base skill files for both `cf-explorer` and `cf-inspector` to fully understand all available commands and flags. Also read `cf-live-trace` when HTTP request/response evidence is relevant, and read `cf-hana` when the investigation needs database schema or row evidence. This guide focuses strictly on tool selection, integration workflow, and avoiding common pitfalls.

## The Debugging Workflow

### Anchor On The Deployed JS Target (`cf-explorer`)
TypeScript compilation alters line numbers, and source maps on CF are often misaligned. You must find the exact `.js` file and line number directly on the server.
1. Run `cf-explorer roots` to discover where the application source is mounted.
2. Choose the appropriate `cf-explorer` command (`grep`, `find`, `ls`, `view`, etc.) to locate your target function and understand its context within the compiled files.

> **CRITICAL RULE**: Never blindly use line numbers from your local `.ts` files for breakpoints. Always target the exact compiled `.js` line number discovered via `cf-explorer`.

## Evidence Loop

After the deployed code target is understood, choose the next evidence source based on the current hypothesis. These tools are not strict sequential steps; move between HTTP traces, runtime captures, and database checks as each result narrows the problem.

### Capture HTTP Evidence When The Trigger Is Unclear (`cf-live-trace`)
Use `cf-live-trace` before, after, or alongside inspector breakpoints when the failing path depends on an incoming request, response, status code, payload shape, correlation ID, or timing. Use trace evidence to choose the next breakpoint, request reproduction, or HANA lookup.

### Capture Live Runtime State (`cf-inspector`)
Use `cf-inspector` when the investigation needs runtime state at a deployed line, exception evidence, scopes, stack frames, or expression captures. Use the deployed `.js` path and line discovered through `cf-explorer`, not local TypeScript line numbers.

### Validate Database State When Needed (`cf-hana`)
Use `cf-hana` when trace or runtime evidence points to bound HANA data, missing rows, schema mismatches, tenant-specific data, or persistence side effects. It can be used before an inspector capture if the relevant key or tenant is already known.

## Tool Choice

- Use `cf-explorer` to find the deployed compiled code and exact runtime line numbers.
- Use `cf-live-trace` to see which HTTP request actually fails or which payload/status/correlation ID matters.
- Use `cf-inspector` to pause or observe the Node.js process at the exact deployed line.
- Use `cf-hana` to confirm database facts after the failing entity, tenant, or key is known.
- Do not force all tools into every investigation. Pick the smallest evidence source that can confirm or reject the current hypothesis.
- Treat inspector captures, trace bodies, headers, HANA rows, and saved refs as sensitive; summarize findings instead of pasting raw values unless the user explicitly asks.
