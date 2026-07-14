---
name: service-flow
description: Use when indexing, linking, tracing, graphing, inspecting, diagnosing, cleaning, testing, or changing SAP CAP service-to-service flows with the service-flow CLI or @saptools/service-flow package, especially for multi-repository workspaces, SQLite state, handler implementation selection, runtime placeholders, dynamic targets, parser/linker evidence, and deterministic validation.
---

# Service Flow

## Purpose

Use `service-flow` to build and inspect a static, evidence-backed call graph across SAP CAP repositories. Apply this skill both when operating the CLI and when changing `packages/service-flow` itself.

Keep these boundaries explicit:

- Treat the result as static analysis, not a live runtime trace.
- Do not start CAP applications, read `.env`, contact BTP, or call remote services.
- Keep resolution fail-closed. Report ambiguity or missing evidence instead of selecting a plausible target.
- Treat persisted graph decisions as authoritative. Runtime substitutions enrich one trace in memory and never rewrite SQLite.

## First Steps

1. Confirm Node.js 24 or newer. This package uses the built-in `node:sqlite` API.
2. Identify the exact workspace root. Configuration lookup does not walk parent directories.
3. Determine whether the task is operational or a package change.
4. Read the current source and focused tests before relying on documentation for edge-case behavior.
5. Preserve existing `.service-flow` state unless cleanup or a clean rebuild is part of the request.

Install the published CLI only during explicit setup. A global install is a networked, machine-wide change; skip it during read-only investigation and prefer an already approved version that matches the workspace database:

```bash
npm install -g @saptools/service-flow
service-flow --version
```

When working in this monorepo, run the built CLI after building the package:

```bash
pnpm --filter @saptools/service-flow build
node packages/service-flow/dist/cli.js --help
```

## Investigate Existing State Read-Only

When the workspace is already initialized, begin without changing configuration or SQLite:

```bash
service-flow doctor --workspace /absolute/path/to/workspace --strict --format json
service-flow list repos --workspace /absolute/path/to/workspace
service-flow list services --workspace /absolute/path/to/workspace --repo api-service
service-flow list operations --workspace /absolute/path/to/workspace --repo api-service --service /OrderService
service-flow trace --workspace /absolute/path/to/workspace --repo api-service --service /OrderService --operation submitOrder --dynamic-mode strict --format json
```

`trace`, `graph`, `list`, `inspect`, and `doctor` open the configured database read-only. Do not run `init`, `index`, `link`, or `clean` when the request is limited to inspection or explanation.

## Initialize or Refresh State

Run the lifecycle in order:

```bash
service-flow init /absolute/path/to/workspace
service-flow index --workspace /absolute/path/to/workspace
service-flow link --workspace /absolute/path/to/workspace
service-flow doctor --workspace /absolute/path/to/workspace --strict --format json
service-flow trace --workspace /absolute/path/to/workspace --repo api-service --operation submitOrder --format json
```

Apply these lifecycle rules:

- Rerun `init` after adding repositories. Indexing only processes repositories already registered in workspace state.
- Rerun `index`, then `link`, after source, CDS, package metadata, binding, or helper changes.
- Use `index --force` after analyzer upgrades, when doctor requests it, or when fingerprint skipping must be bypassed.
- Run `link` after every fact-changing index. Linking always rebuilds the graph; `link --force` adds no stronger behavior.
- Treat `graph_stale` as a request to relink, not as permission to trust the old graph.

## Initialize and Discover Repositories

Use:

```bash
service-flow init <workspace> [--db <path>] [--ignore <directory>...]
```

Remember:

- The workspace root must be writable because `init` writes `.service-flow/config.json`, even when the database is elsewhere.
- A relative custom `--db` path resolves from the process working directory.
- Discovery recognizes nested real Git repositories and test `.git-fixture` markers, and continues into repositories to find nested ones.
- `--ignore` uses exact directory-segment matches, not glob syntax.
- Supplying `--ignore` replaces the default list. Retain exclusions for `.git`, `.service-flow`, dependencies, generated output, caches, and coverage when customizing it.
- Rerunning `init` adds or updates repositories but does not remove stale repository rows. Use a deliberate clean rebuild when removed repositories must disappear.

Default state is:

```text
<workspace>/.service-flow/config.json
<workspace>/.service-flow/service-flow.db
<workspace>/.service-flow/.service-flow-state
```

## Choose a Read Command

Use the narrowest command that answers the question:

| Goal | Command |
| --- | --- |
| Discover indexed repository identities | `service-flow list repos --workspace <root>` |
| Find service selectors | `service-flow list services --workspace <root> [--repo <repo>]` |
| Find operation selectors | `service-flow list operations --workspace <root> [--repo <repo>] [--service <path>]` |
| Review indexed calls | `service-flow list calls --workspace <root> [--repo <repo>] [--operation <name>]` |
| Inspect repository facts | `service-flow inspect repo <name> --workspace <root>` |
| Inspect operation matches | `service-flow inspect operation <selector> --workspace <root>` |
| Follow an execution path | `service-flow trace ...` |
| Render a broad graph | `service-flow graph ...` |
| Audit workspace health | `service-flow doctor ...` |

Treat `list calls` as discovery output, not authoritative resolution evidence. Its operation filter is broader than an exact graph decision.

Repository selectors match an exact discovered directory name or exact `package.json` package name. Zero or multiple matches are terminal diagnostics; never assume the first row. The CLI has no repository-ID selector, so stop when both identities still collide.

`inspect operation` can return multiple workspace-wide name/path matches and has no repository or service qualifier. Use it to inspect candidates, then use precise trace selectors for resolution.

## Select a Trace Start

Prefer a precise operation start:

```bash
service-flow trace \
  --workspace <root> \
  --repo <repo> \
  --service /OrderService \
  --operation submitOrder \
  --format json
```

Available selectors are `--repo`, `--service`, `--operation`, `--path`, and `--handler`.

- Use `--repo` to disambiguate duplicate repository or operation identities.
- Use `--service` as an operation qualifier. A service-only start intentionally queues no broad traversal.
- Use `--operation` or `--path` to resolve the indexed CDS operation first and then its implementation edge.
- Use `--handler` only for an exact executable class or method selector.
- Treat `trace_start_ambiguous`, selector-not-found, and unresolved implementation diagnostics as terminal until stronger evidence or a scoped hint is supplied.
- Omit all selectors only when a whole-workspace scan is intentional.

Trace depth defaults to 25. Supply a positive integer with `--depth`; invalid or non-positive values fall back to the default.

Trace excludes these terminal categories unless explicitly requested:

```bash
service-flow trace ... --include-db --include-external --include-async
```

`graph` uses the same repository, service, operation, path, runtime-variable, and implementation selectors, fixes depth at 100, and includes DB, external, and async edges by default.

## Resolve Runtime-Dependent Targets

Start in strict mode:

```bash
service-flow trace ... --dynamic-mode strict --format json
```

Handle runtime placeholders in this order:

1. Read `diagnostics` and the edge's `effectiveResolution` and `dynamicTargetExploration` evidence.
2. Copy the exact placeholder key reported by the tool.
3. Quote the entire assignment so shell control characters remain literal:

```bash
service-flow trace ... --var 'tenantInfo.region?.toLowerCase()=eu' --format json
```

4. Repeat `--var` for additional keys. Values may contain `=`; later duplicate keys win.
5. Use candidate mode only to inspect bounded alternatives:

```bash
service-flow trace ... --dynamic-mode candidates --max-dynamic-candidates 20 --format json
```

6. Use infer mode only when conservative automatic traversal is acceptable:

```bash
service-flow trace ... --dynamic-mode infer --format json
```

Interpret modes correctly:

- `strict` reports suggestions but never traverses an unresolved dynamic target.
- `candidates` emits explicitly unselected exploratory branches and never enters their handlers.
- `infer` traverses only a complete, conflict-free, unique candidate scoring at least `0.85` with a margin greater than `0.05` over the runner-up.
- Runtime substitution applies only to eligible non-resolved remote-operation targets. It does not reclassify static, DB, external, event, or terminal entity/query edges.
- Placeholder text is matched literally and is never evaluated as JavaScript.
- Invalid or non-positive `--max-dynamic-candidates` values silently fall back to 5. Supply an explicit positive integer.
- Never pass credentials or sensitive tenant values through `--var`; command arguments can remain in shell history and process listings.

## Resolve Implementation Ambiguity

Prefer repeatable scoped hints over the legacy global `--implementation-repo` option:

```bash
service-flow trace ... \
  --implementation-hint 'service=/OrderService,operation=/submit,package=@scope/handlers,repo=order-handler'
```

Accepted scope keys are `service`, `operation`, `package`, `repository`, and `family`; every hint must select a repository with `repo`. The long aliases shown by diagnostics are also accepted.

Use the copyable hint suggestions emitted by trace or doctor. Do not weaken registration, ownership, dependency, decorator, score, or margin rules to make an ambiguous implementation resolve.

Treat variables and implementation hints as reviewed trace-local hypotheses, not proof of the route taken in production. They do not rewrite the persisted ambiguity, and doctor may continue to report it. Hint fields are comma-delimited, so prefer emitted copyable suggestions and do not invent values containing commas.

## Read Output and Evidence

Choose output deliberately:

- Use trace table output for quick human review.
- Use trace JSON for automation and complete evidence: `{ start, nodes, edges, diagnostics }`.
- Use Mermaid for presentation only; it emits edges, not full evidence or diagnostics.
- Use graph JSON when machine-readable broad traversal is required.
- Do not rely on unsupported format fallback behavior. Supply documented formats explicitly.

Important edge types include outbound call types, `local_symbol_call`, `operation_implemented_by_handler`, `dynamic_candidate_branch`, and `cycle`.

For every questionable edge, inspect:

- source repository, file, line, and owning symbol;
- persisted status and `unresolvedReason`;
- parser and linker evidence;
- `persistedResolution` versus runtime-current `effectiveResolution`;
- candidate counts and omitted counts;
- selected-handler provenance.

Candidate-like evidence is deterministically bounded. Never treat a displayed prefix as complete when an omitted count is nonzero.

For an exhaustive audit, first ensure no index or clean writer is active. Open the configured database with a read-only SQLite connection, or inspect an access-restricted SQLite-consistent copy, and query canonical rows from `repositories`, `cds_services`, `cds_operations`, `symbols`, `symbol_calls`, `outbound_calls`, and `graph_edges`. Do not derive a final decision from capped evidence JSON, do not mutate coordination or graph rows, and verify the schema version before writing ad hoc queries.

## Diagnose Before Changing Code

Run:

```bash
service-flow doctor --workspace <root> --strict --format json
service-flow doctor --workspace <root> --strict --detail --format table
```

Use JSON for automation. Default doctor output is intentionally mixed: it emits JSON when diagnostics exist and a text success message when none exist. `--format json` always returns an array.

Doctor reports severity but does not set a failing exit code from diagnostic contents. CI must parse the JSON and enforce its own accepted codes or severity policy.

Do not require an empty strict-doctor array: healthy workspaces can still contain informational quality rows. Enforce an explicit allowlist or severity/code policy.

Investigate in this order:

1. Node and schema compatibility.
2. Missing repository discovery or failed source reads.
3. Analyzer-version warnings that require `index --force`.
4. Stale graph generations that require `link`.
5. Selector ambiguity.
6. Missing or conflicting service-binding evidence.
7. Dynamic placeholders and candidate rejection reasons.
8. Handler decorator, registration, ownership, or package-dependency ambiguity.

If multiple workspaces intentionally share one database, remember that doctor aggregates that configured database rather than isolating every diagnostic by workspace.

## Rebuild State Only as a Last Resort

Do not clean state merely for `graph_stale`, analyzer drift, or implementation ambiguity. Relink stale facts, force-index analyzer drift and then relink, and address ambiguity through stronger source evidence or a reviewed trace-local hint.

Reserve cleanup for a confirmed schema rebuild, corruption, or stale removed-repository rows. Quiesce database users, verify the configured path is the intended service-flow database, and take an access-restricted SQLite-consistent backup first. If one physical database contains multiple workspaces, cleanup deletes all of them; coordinate every owner or stop.

For a custom state path, delete only the exact database after these checks:

```bash
service-flow clean --workspace <root> --db-only
```

`--db-only` removes the configured database and its `-wal`, `-shm`, and `-journal` sidecars. Full clean recursively removes the database parent only when the `.service-flow-state` marker file exists, and refuses filesystem root, `/tmp`, the home directory, the workspace root, or an unmarked directory. The marker is a deletion guard, not proof that the directory contains no unrelated data.

Never manually broaden the deletion target. After cleanup, rerun `init` with the same absolute custom `--db` and original `--ignore` values, then run `index` and `link`. Keep the backup until integrity, doctor policy, and expected traces pass.

If a writer claim is active, wait for the live index or clean operation. Treat `index_writer_active` and `index_writer_coordination_failed` as concurrency signals, not as reasons to bypass coordination.

## Protect Workspace Data

- Never commit or publicly attach `.service-flow`, its SQLite sidecars, or exported evidence dumps.
- Treat the database as credential-sensitive. Package metadata and evidence can preserve literal values; keep secrets out of `package.json` and use environment or service-binding injection.
- Keep generated state outside source control.
- Redact destinations, URLs, source paths, service names, entity names, and repository topology before sharing diagnostics externally.
- Preserve the last-good database when an index preparation fails; inspect diagnostics before cleaning it away.

## Maintain the Package

Trace changes through this pipeline before editing:

```text
source snapshot -> typed parser facts -> SQLite publication -> graph linking -> trace selection/traversal -> output rendering
```

Route changes to the existing responsibility:

- CLI flags and actions: `src/cli.ts` and `src/cli/`
- workspace configuration and discovery: `src/config/` and `src/discovery/`
- CDS, TypeScript, binding, symbol, or outbound facts: `src/parsers/`
- schema, migrations, and persistence: `src/db/`
- fingerprinting, snapshots, writer coordination, and publication: `src/indexer/`
- dependency, operation, implementation, and call resolution: `src/linker/`
- start selection, dynamic runtime resolution, hints, and traversal: `src/trace/`
- stable table, JSON, Mermaid, doctor, and stdout behavior: `src/output/`
- neutral contracts and regressions: `tests/unit/`, `tests/e2e/`, and `tests/fixtures/`

Preserve these invariants:

- Parsers emit typed facts and bounded evidence; they do not create graph edges directly.
- Resolution requires unique, strong evidence and remains deterministic across discovery order.
- Failed preparation or publication retains the last-good facts; publication and linking remain transactional.
- Runtime trace decisions do not mutate persisted graph rows.
- Candidate display limits never constrain canonical decision queries.
- Output shapes, include flags, exit behavior, and pipeline-safe broken-pipe handling remain backward compatible unless the task explicitly changes them.
- Keep provenance and display-only detail in bounded evidence. Store resolver-required or independently queryable semantics in canonical typed columns/tables; add a migration only when the existing schema cannot represent them.
- Use neutral fixtures. Never copy private workspace paths, package names, topology, endpoints, or credentials into tests.

For parser, resolver, or graph changes:

1. Read the fact type, emitter, insert path, resolver, graph edge creation, trace traversal, renderer, and focused tests end to end.
2. Add a failing unit or SQLite integration test before changing behavior.
3. Add positive, ambiguous/dynamic, malformed, and look-alike negative cases. Assert one source call site emits exactly one intended fact and is not also classified by an overlapping parser path.
4. Persist explicit confidence, status, strategy, counts, and unresolved reasons.
5. Resolve only a unique candidate in the correct repository/module/ownership scope.
6. Decide whether the analyzer version must change so fingerprint-skipped repositories cannot retain stale parser or linker semantics.
7. Assert the resulting fact, evidence JSON, target source file, graph edge, and trace visibility.
8. Compare exact JSON keys and ordering, omitted-versus-null behavior, table labels, Mermaid edges, exit behavior, and broken-pipe behavior when output is affected.
9. Repeat force-index and relink to prove idempotent counts and deterministic edges.
10. Add strict-doctor coverage when the change introduces a new diagnosable quality condition.

## Verify Package Changes

Run focused checks from the repository root:

```bash
pnpm --filter @saptools/service-flow typecheck
pnpm --filter @saptools/service-flow lint
pnpm --filter @saptools/service-flow test:unit
pnpm --filter @saptools/service-flow build
pnpm --filter @saptools/service-flow test:e2e
```

Build before E2E because the CLI suite executes `dist/cli.js`. Fixtures are local and fake-backed; do not substitute a live SAP or credential-dependent workspace.

For a release or high-risk persistence change, also run:

```bash
cd packages/service-flow
npm pack --dry-run --json
```

Inspect a clean fixture database read-only and verify:

- `PRAGMA integrity_check` returns `ok`;
- `PRAGMA foreign_key_check` returns no rows;
- no `index_runs` row remains `running`;
- changed repositories have current fact and graph generations with no stale reason;
- expected fact, symbol-call, outbound-call, and graph-edge counts remain stable after a repeated force-index/relink cycle;
- all persisted evidence is valid bounded JSON.

Update the package version and `CHANGELOG.md` only when the requested release scope requires them. Keep technical notes synchronized when their documented correctness matrix changes.

## Troubleshooting

### Repository is missing

Rerun `init` at the exact workspace root, then index and link. Confirm the directory has a recognized Git marker and is not excluded.

### Index says unchanged after an analyzer change

Run `index --force`, then `link`. The fingerprint includes the analyzer version, package facts, and source hashes, but old state may require explicit upgrade remediation.

### Trace has no nodes or edges

Inspect diagnostics first. Precise selectors deliberately stop on ambiguity, missing implementations, non-executable handlers, or service-only starts.

### A dynamic route remains unresolved

Use the exact reported `--var` keys, inspect rejected candidates in JSON, and try candidate mode. Do not jump directly to infer mode or relax route-ownership checks.

### An operation resolves but traversal stops

Inspect the implementation edge, registration pairing, decorator evidence, package dependency, and selected-handler provenance. Apply a scoped suggested hint only when it identifies the intended indexed repository.

### Doctor is clean but CI should enforce quality

Run `doctor --strict --format json` and apply an explicit JSON policy. Diagnostic severity alone does not change the process exit code.

### Cleanup refuses the state directory

Use `--db-only` for a custom or unowned database directory. Do not add a marker by hand to force recursive deletion.
