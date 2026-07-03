# Service Flow 0.1.8 Resolution Notes

- Imported helper bindings: TypeScript imports are resolved for relative modules. When a caller assigns `const client = await connectToService()`, the analyzer follows the imported symbol to an exported helper that returns `cds.connect.to(...)` and persists caller-variable evidence plus the helper source/export chain.
- Candidate ranking: operation-path matches start as weak candidates. A resolved operation edge requires a strong signal such as exact service path, CDS alias/destination context, or explicit dynamic variable overrides. Otherwise candidates are preserved in edge evidence as ambiguous or unresolved.
- Edge states: `REMOTE_CALL_RESOLVES_TO_OPERATION` is used only above the resolution threshold; `DYNAMIC_EDGE_CANDIDATE` preserves runtime-dependent service paths/destinations; `UNRESOLVED_EDGE` carries candidate counts and reasons when static evidence is insufficient.
- Trace cycle safety: trace queues carry repository IDs, visited scope keys are independent of depth, graph edge IDs are emitted once, and revisiting an already-seen downstream operation scope creates a cycle marker instead of recursive expansion.
- SQLite reliability: the package uses a persistent SQLite connection per opened database, bound parameters, transactions, WAL, busy timeouts, read-only openings for query commands, and connection-local foreign-key enforcement. Native driver loading failures produce an actionable startup error before output rendering.

## 0.1.4 trace-correctness additions

- Helper exports are normalized through a public-to-local export map, so `export { helper }` and `export { helper as publicHelper }` both resolve to the local declaration that contains the `cds.connect.to(...)` call.
- Two-argument CAP connections keep alias expressions distinct from `credentials.destination` and `credentials.path` / `credentials.servicePath`; dynamic placeholders from all three fields are retained for later `--var` substitution.
- Repository discovery validates `.git` markers using `HEAD`, `config`, or gitfile `gitdir:` content and keeps scanning children so outer workspaces can contain many nested repositories.
- Fresh SQLite stores now declare core parent/child foreign keys with cascading cleanup for repository-owned facts.

## 0.1.5 hardening additions

- Runtime variables are applied to alias, destination, service path, and operation path evidence. Trace/graph then perform an effective in-memory resolution requiring both operation-path compatibility and an exact service-path signal.
- Edge evidence and target operation provenance are separate: call file/line and helper chains stay on the edge, while operation nodes are loaded from CDS operation/service/repository rows.
- The linker stores explicit edge status categories and summary counts. Valid DB, event, and external terminals keep `unresolved_reason` null.
- Repository-level fingerprints include source paths/hashes, package dependencies, and analyzer schema version. Unchanged repositories are skipped unless `--force` is used.


## 0.1.8 implementation resolver model

- Facts: indexing records CDS operations, decorated handler classes/methods, package dependencies, service bindings, outbound calls, and class-level handler registration facts. Registration facts include class name, import source where known, registration file, registration line, kind, and confidence.
- Dependency evidence: helper-package linking creates repository dependency edges from package metadata. Implementation linking treats same-repository registration/handler evidence as strong without requiring a self-dependency edge, and treats registration-package or handler-package dependencies on the model package as strong cross-package evidence.
- Registration evidence: the registration parser uses the TypeScript AST for `createCombinedHandler({ handler: ... })` and resolves direct arrays, identifier arrays, spreads, imported aggregate arrays, default exports, named exports, aliases, and safe relative re-exports. Decorator-only matches are not resolved as strong implementation edges.
- Implementation edges: an operation-to-handler edge requires an exact operation path/name or method-name match plus registration evidence. One strong candidate becomes a resolved `OPERATION_IMPLEMENTED_BY_HANDLER` edge; multiple strong candidates become an ambiguous edge with candidate evidence.
- Trace traversal: trace follows remote-call graph edges to operations, applies runtime `--var` substitutions only to eligible dynamic/ambiguous/unresolved remote edges, and then prefers persisted implementation edges to enqueue the registered handler scope. Depth limits and visited-scope keys continue to bound recursion and report cycles.

## 0.1.8 operational notes

- The known Node 24 `node:sqlite` experimental warning is filtered before loading the database driver for normal service-flow database commands. This filter targets only that runtime warning and does not convert application errors into success.
- Repository indexing protects discovery, reads, hashing, parsing, and publication in one repository-level failure boundary. Failed attempts keep last-good facts and fingerprints and produce `source_read_failed` diagnostics visible in doctor.
- Doctor reports `index_run_abandoned` only for running rows older than 60 minutes, including run id and start time.
- Fresh schema version 3 stores define foreign keys for `graph_edges`, `index_runs`, and `diagnostics`. If a migrated legacy store is structurally weaker, doctor reports `legacy_schema_weaker_foreign_keys` rather than implying parity.

## 0.1.8 correctness additions

- Runtime resolution now has an explicit eligibility gate: only remote dynamic/ambiguous/unresolved graph edges with affected placeholders are re-resolved in memory. Terminal and resolved static edges are copied through unchanged, and substitutions keep original expressions, effective values, supplied variables, and missing variables separate.
- Operation candidate scores are clamped into `[0, 1]` before graph or trace rendering.
- Helper package linking uses exact `repositories.package_name` matches before normalized directory-name fallback. Ambiguous package names are represented as ambiguous graph edges with all candidates in evidence.
- Fingerprints hash normalized package facts and package bytes in addition to source file paths/content and analyzer version.
- The CLI version imports package metadata, so package metadata, `service-flow --version`, changelog, and analyzer/fingerprint version share one release source.
- Supported runtime is Node.js 24+ with `node:sqlite` validation; older runtimes should fail with a compatibility message instead of a late `DatabaseSync` error.
