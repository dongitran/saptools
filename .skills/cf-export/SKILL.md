---
name: cf-export
description: Use when exporting project artifacts (package.json, lockfiles, .cdsrc.json, default-env.json, .npmrc) from a running SAP BTP CF app.
---

# CF Export

## Purpose

Use `cf-export` to pull exact CAP/CF project artifacts from a live Cloud Foundry container. This is the CLI equivalent of the "Export" feature in the SAP Tools VS Code extension. It is useful for local development setup, debugging deployment issues, or capturing the exact lockfile and config that a running app was built with.

If `cf-export` is missing, install it: `npm install -g @saptools/cf-export`

## First Steps

1. Identify what the user needs: full set of artifacts, only specific files (e.g. pnpm-lock + default-env), or a particular remote root.
2. `-a` / `--app` is always required. `--region`, `--org`, `--space` are optional. If the user only mentions the app name, try short form first. The tool checks if a target is already set in the environment. Only ask the user for region/org/space and pass explicit flags when the tool errors with "Error: --region is required" (or --org / --space).
3. Use `--remote-root` (the "root url") when the app files live in a non-standard path inside the container (common for multi-package or custom build roots).
4. Default behavior exports everything that exists. Use `--file` to be selective.

## Command Choice

Export all artifacts (short form):

```bash
cf-export -a my-cap-app --out ./exported
```

With full flags:

```bash
cf-export -r ap10 -o my-org -s dev -a my-cap-app --out ./exported
```

With custom remote root:

```bash
cf-export -a my-cap-app --remote-root /home/vcap/app/srv --out ./out
```

Selective files:

```bash
cf-export -a my-cap-app --file package.json --file pnpm-lock.yaml --file default-env.json
```

## Troubleshooting

- Error: --region is required (or --org / --space) → Ask the user for the missing target details and pass them using explicit flags.
- Files not found in expected location → use `--remote-root /path/inside/container`.
- Auth failures → ensure `SAP_EMAIL` / `SAP_PASSWORD` are set and the `cf` CLI can reach the region.
- Unknown region → pass `--region` explicitly.

Live CF commands require the app to be running and SSH enabled for file fetches.

## Related Tools

- `@saptools/cf-files` — lower-level file download and gen-env.
- `@saptools/cf-sync` — provides the region catalog.
