# Service Flow 0.1.5 Resolution Notes

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
