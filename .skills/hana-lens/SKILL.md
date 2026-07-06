---
name: hana-lens
description: Use when analyzing SAP CAP CDS/HANA model structure with hana-lens, including building a compact CSN cache, fuzzy or regex entity search, field search, incoming reference lookup, dense entity descriptions, and safe association expansion.
---

# HANA Lens

## Purpose

Use `hana-lens` to inspect SAP CAP CDS/HANA model structure from a local workspace without opening huge CSN files or repeatedly compiling a monorepo. It scans CAP packages by npm package-name prefix, links local sibling packages for CDS resolution, compiles each package in an isolated worker, writes one minified `.hana-lens-cache.json`, and then answers offline search/describe/reference questions from that cache.

Prefer `hana-lens` when the task asks:

- where a CAP entity or projection is defined
- which package owns a CDS definition
- what fields, keys, types, enums, annotations, or association `ON` conditions an entity has
- which entities point to another entity through `cds.Association` or `cds.Composition`
- whether a field name appears across cached entities
- for compact schema context suitable for terminal output or LLM prompts

If `hana-lens` is missing, install it from `@saptools/hana-lens`: `npm install -g @saptools/hana-lens`.

## First Steps

1. Identify the CAP workspace root and the npm package-name prefix to include, such as `@my-cap/` or `@customer/`.
2. Check whether `.hana-lens-cache.json` already exists in the workspace root. Use existing cache reads for offline investigation; rebuild only when CDS models or package boundaries may have changed.
3. Run `build-cache` from any directory, but run follow-up `search`, `search-field`, `references`, and `describe` from the directory containing `.hana-lens-cache.json`.
4. Treat `.hana-lens-cache.json` as generated local state. It can reveal internal entity names, package names, fields, associations, and annotations; do not commit it or paste large raw cache contents unless explicitly requested.
5. Prefer narrow commands over dumping the whole cache. Use `search` first when the exact entity name is uncertain, then `describe` or `references` on the selected entity.

## Command Choice

Build or refresh the workspace cache:

```bash
hana-lens build-cache --dir ./workspace --prefix @my-cap/
hana-lens build-cache --dir ~/code/customer-cap --prefix @customer/
```

Search cached definition names with typo-tolerant matching:

```bash
hana-lens search BusinesReq
hana-lens search businessrequest
```

Use regex mode for exact namespaces, suffixes, or naming conventions:

```bash
hana-lens search '^my\.service\..*Request$' --regex
hana-lens search 'Customer$' --regex
```

Search for fields across entities:

```bash
hana-lens search-field status
hana-lens search-field '^created' --regex
```

Find incoming association/composition references to an entity:

```bash
hana-lens references my.service.BusinessRequest
```

Describe one entity in dense terminal form:

```bash
hana-lens describe my.service.BusinessRequest
```

Include annotations when annotation values matter:

```bash
hana-lens describe my.service.BusinessRequest --with-annotations
```

Expand nearby association/composition targets with safety guards:

```bash
hana-lens describe my.service.BusinessRequest --expand
hana-lens describe my.service.BusinessRequest --expand --with-annotations
```

## Output And State

`build-cache` prints a compact status line similar to:

```text
cached=42 packages=3 file=/path/to/workspace/.hana-lens-cache.json
```

The cache file is:

```text
<workspace>/.hana-lens-cache.json
```

Important behavior:

- package discovery recursively finds `package.json` files whose `name` starts with the normalized prefix
- discovery ignores `node_modules`, `.git`, `dist`, and `gen`
- discovery stops descending once it finds a matching package root
- sibling packages are linked under each package's `node_modules/<scope>` so local CDS imports resolve
- each package compiles in a separate Node.js worker to avoid `@sap/cds` process-level compiler cache collisions
- definitions receive `@hanaLens.packageName` metadata for owner reporting
- duplicate CSN definition names fail the build instead of silently overwriting
- search output is limited to the top matches and uses dense `definition|package` lines
- `describe --expand` limits depth and reports compact `missing`, `ambiguous`, or `circular` markers instead of recursing forever

## Interpreting Results

Use fuzzy `search` when names are misspelled or incomplete. It is case-insensitive and ranks exact substring matches ahead of Levenshtein-style fuzzy matches.

Use `--regex` when the user gives a naming rule or namespace pattern. Invalid JavaScript regular expressions are surfaced as command errors; fix the pattern rather than falling back to broad cache dumps.

Use `search-field` when the user remembers a column or association name but not the owning entity. Exact field-name matches are highlighted in the formatted output; regex mode can find prefixes, suffixes, or naming conventions.

Use `references` before changing a model or deleting/renaming an entity. It reports incoming association/composition fields that target the requested entity, including targets resolved by exact or suffix name matching where possible.

Use `describe --expand` to gather compact neighborhood context. Expansion follows association/composition targets only to a bounded depth and should be treated as nearby context, not a full dependency graph.

## Development Commands

From the monorepo root, use focused checks for changes to the package:

```bash
pnpm --filter @saptools/hana-lens build
pnpm --filter @saptools/hana-lens typecheck
pnpm --filter @saptools/hana-lens lint
pnpm --filter @saptools/hana-lens test:unit
pnpm --filter @saptools/hana-lens test:e2e
```

The e2e tests build `dist/cli.js` and use temporary fake CAP workspaces. They do not require live SAP BTP, Cloud Foundry, HANA, SharePoint, or credential-dependent services.

## Data Handling

Do not commit `.hana-lens-cache.json`; it is generated state. Keep cache files, internal entity names, package names, annotations, and schema shapes out of public reports unless the user explicitly wants that detail.

`hana-lens` itself is local/offline after cache creation, but `@sap/cds` compilation may read the target workspace and linked local packages. Do not run it against unrelated workspaces or paths containing sensitive generated credentials unless the user asks.

If output includes annotations or model names that look sensitive, summarize only the relevant entity, field, package, or reference evidence. Avoid pasting the entire cache or large model excerpts.

## Troubleshooting

- `No packages starting with <prefix> found`: verify the workspace root and package prefix. Prefixes without a trailing slash are normalized, so check actual `package.json` names.
- `Unable to read .hana-lens-cache.json. Run hana-lens build-cache first.`: run `build-cache`, or change into the workspace directory containing the cache before running read commands.
- `.hana-lens-cache.json contains malformed JSON`: rebuild the cache from source models instead of editing it by hand.
- `definitions object`: the cache shape is invalid; remove the generated cache and run `build-cache` again.
- `Duplicate CSN definition <name>`: two packages compile the same definition name. Inspect the reported package owners and fix the CAP model boundary or namespace duplication.
- `Compilation failed for <package>`: run the package's own CAP build/compile checks. Verify local sibling links, missing dependencies, invalid CDS syntax, and whether `@sap/cds` is installed where full CAP fidelity is required.
- `Entity not found: <name>`: run `hana-lens search <part-of-name>` first, then retry `describe` or `references` with the fully qualified definition name.
- `missing`, `ambiguous`, or `circular` in expanded output: this is a guarded resolution result. Use `search` on the target suffix or namespace to inspect candidates manually.
