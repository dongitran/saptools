# `@saptools/cf-logs` Compact Output And Drill-Down Plan

## cf-sync Removal and Self-Contained CF Targeting (2026-06)

**Review note (post-CI):** Initial push had transient lockfile/hana drift from workspace dirty state during dev; follow-up ensured consistent pnpm-lock + package.jsons. Final run on corrected tree must pass all jobs (install, build, lint, type, unit, e2e, tarball). See GH run history for the cf-logs workflow.

### Research Summary (via direct file reads + rg/grep)

- **cf-sync usage in cf-logs was limited to exactly two call sites** (confirmed via grep across packages/cf-logs):
  - `src/cf.ts:3`: `import { getAllRegions } from "@saptools/cf-sync";` — used **only** inside `resolveApiEndpoint` to map `--region ap10` → full API endpoint when no `--api-endpoint` override.
  - `src/cli.ts:6`: `import { readCurrentCfTarget, type CfExecContext } from "@saptools/cf-sync";` — used **only** in `readCurrentTargetIfNeeded` + `buildSession`/`buildAppRef` to populate missing `--region`/`--org`/`--space` (and api) when the user passes bare `--app my-app` (or for `apps` command).
- **No topology/cache usage at all**: exhaustive grep for "structure", "cf-structure", "cf-sync" (except the two), "readStructure", "sync" showed zero references to `~/.saptools/cf-structure.json` or any cf-sync snapshot data. cf-logs' own "snapshot" is log content + its `cf-logs-store.json`. It never walks a pre-synced app catalog.
- **User's observation is exactly correct**: when only app name is given, region/org/space MUST come from the live `cf target` output (the user's current CF CLI context), plus region derivation by matching the API endpoint against the known SAP region catalog. No pre-sync is required (unlike cf-events which documents needing `cf-sync sync` for ambiguous bare names).
- **cf-sync provided**:
  - Authoritative full `REGIONS` map (30+ keys incl. scale-outs like eu10-00X, cn*, etc.).
  - `readCurrentCfTarget` + `parseCfTargetOutput` that execs `cf target` and parses "API endpoint: ...", "org: ...", "space: ..." lines (case-insensitive key matching after ":").
  - `regionKeyForApiEndpoint` using the catalog.
- **Alternatives already proven in-tree**:
  - `packages/cf-debugger` has **zero** cf-sync dep. It owns `src/regions.ts` (REGION_API_ENDPOINTS map) + `src/cloud-foundry/commands.ts` (`readCurrentCfTarget`, `parseCurrentCfTarget`, `regionKeyForApiEndpoint` using direct `execFile` on `cf target`).
  - cf-logs' own `src/cf.ts` already implements the full login dance (`api` + `auth` + `target`) + retry + `cf apps` + `cf logs --recent` + streaming. Only the lookup + current-target pieces were outsourced.
- **Benefits of removal**:
  - cf-logs becomes fully independent (no forced cf-sync install or `cf-sync sync` prerequisite).
  - Smaller dep graph for a focused log tool.
  - Same UX: `--app foo` (no other flags) still works via current `cf target`.
  - Region coverage stays 100% identical by embedding the catalog.

### Decision and Scope

- Remove `"@saptools/cf-sync": "^0.4.13"` from dependencies.
- Embed minimal self-contained equivalents (full regions list + target reader/parser) inside cf-logs.
- Do **not** depend on cf-debugger (would be sideways dep).
- Rule of three not met for cross-package shared util yet — keep private inside cf-logs.
- Preserve **exact public surface**: `resolveApiEndpoint({ region?, apiEndpoint? })`, CLI flags/behavior, exports.
- Improve while touching:
  - New focused modules for clarity.
  - New unit tests for parser + current-target fallback paths.
  - Update cf.test expectations if any drift (they must not).
  - Clean README of any incidental cf-sync references.
  - Keep strict TS, explicit async returns, ESM .js extensions, no `any`.

### Files To Change / Create

- `packages/cf-logs/src/regions.ts` (new) — full REGIONS + `getAllRegions()`, `resolveApiEndpointForRegion(key)`, `regionKeyForApiEndpoint(api)`.
- `packages/cf-logs/src/target.ts` (new) — `CfExecContext`, `readCurrentCfTarget(context?)`, `parseCfTargetOutput(stdout)` returning shape `{ apiEndpoint, regionKey?, orgName, spaceName }` to match prior cf-sync contract used by cli.ts.
- `packages/cf-logs/src/cf.ts` — rewrite `resolveApiEndpoint` to use local regions (remove import); keep signature + error text identical ("Unknown CF region: xx99").
- `packages/cf-logs/src/cli.ts` — replace cf-sync import with local `from "./target.js"` (or re-export); `currentCfContext()` stays compatible.
- `packages/cf-logs/src/index.ts` — no change (resolveApiEndpoint stays re-exported via cf.js).
- `packages/cf-logs/package.json` — delete cf-sync dep line.
- `packages/cf-logs/tests/unit/target.test.ts` (new) — parse coverage (with/without region, partial targets, unknown apis), readCurrent via mocked exec.
- `packages/cf-logs/tests/unit/cf.test.ts` — may add a resolve test using the embedded list; existing ap10 tests must pass unchanged.
- `packages/cf-logs/tests/e2e/*.e2e.ts` — no logic change (they already drive via CF_LOGS_CF_BIN + fake-cf and `targetFakeCf`); coverage for bare-app/current-target remains.
- `packages/cf-logs/README.md` — audit and remove cf-sync mentions if present in usage notes.
- `packages/cf-logs/implementation_plan.md` — this section.
- (transitive) pnpm-lock will update on install.

### Implementation Order (small layers)

1. Add regions.ts + target.ts + update cf.ts (unit-testable).
2. Update cli.ts.
3. Update package.json + tests.
4. Run typecheck/lint/unit before e2e.
5. Full `pnpm --filter @saptools/cf-logs check`.
6. Bump version (see below).

### Error / Behavior Compatibility

- `resolveApiEndpoint({region:"xx99"})` → throws "Unknown CF region: xx99" (exact).
- Bare target fallback error message kept verbatim.
- `cf target` parse tolerant of the exact output shape emitted by real `cf` and by fake-cf.mjs (including the "API endpoint:   ..." formatting with spaces).
- When `cf target` returns an api not in catalog → regionKey omitted, but apiEndpoint passed through (existing behavior preserved; api takes precedence).
- CfExecContext narrowed to `{command?}` (env/timeout not needed here).

### Verification Steps (must all pass)

```bash
cd /Users/dongtran/Documents/brain/01-projects/01-saptools
pnpm install   # to drop cf-sync from this package's node_modules
pnpm --filter @saptools/cf-logs typecheck
pnpm --filter @saptools/cf-logs lint
pnpm --filter @saptools/cf-logs test:unit
pnpm --filter @saptools/cf-logs build
pnpm --filter @saptools/cf-logs test:e2e
pnpm --filter @saptools/cf-logs check   # cspell + all above
node -e 'console.log(require("@saptools/cf-logs").resolveApiEndpoint({region:"ap10"}))'
```

Manual:
- `cf-logs apps` (with current target via fake) still works.
- `cf-logs snapshot -a demo-app` (no region/org) succeeds when target is set in the test env.
- `cf-logs --help` and sub-command help unchanged.

After green checks: bump minor or patch? Removal of dep + internal refactor that preserves UX → patch (0.5.1 → 0.5.2) or minor if we consider cleaner surface. Decision: 0.6.0 because we are declaring independence from cf-sync (breaking for anyone who pinned weirdly, and signals architectural change). Update plan + version in one step after checks.

### Post-Change Deep Review Checklist (to be executed)

- Re-grep entire tree for any remaining @saptools/cf-sync in cf-logs sources.
- Re-read changed source files + new files.
- Run full check again after any fixes.
- Inspect git diff: only cf-logs package touched.
- Confirm no `console.*` added, strict types, async return annotations.
- Confirm e2e still exercises current-target path (apps-current-target test).
- Update this plan with "Review complete" + any findings.

### Version / Release

- After all checks + review: set version to `0.6.0` in package.json.
- Commit message: concise, e.g. "feat(cf-logs): remove cf-sync dep; self-contained cf target + regions".
- Do NOT use --no-verify.
- Push, monitor GH Actions via tools, fix forward if red.

## Active Goal

Add a professional `--compact` mode to `packages/cf-logs` so the CLI can stream or print log context that is much smaller for AI-model usage, while still allowing users to retrieve the full saved row through a stable reference.

Latest product decisions:

- The package must not redact log content.
- `CfLogsRuntime` must preserve full log fidelity for snapshots, streams, emitted events, and persisted stores.
- `--compact` reduces token volume only. It is not a privacy or data-loss-prevention feature.
- `--compact --save` creates a short-lived full-fidelity drill-down session and prints row refs.
- `cf-logs show <ref>` retrieves a full saved row.
- Temporary drill-down sessions expire after 60 minutes by default and are pruned automatically.

This plan supersedes earlier redaction-oriented notes in this file.

## Current Code Findings

Relevant files read:

- `src/cli.ts`
  - Owns all command flags and output routing.
  - Existing commands: `snapshot`, `stream`, `parse`, `apps`, `store path/list/clear`.
  - Existing `--save` enables the persistent store for non-compact snapshot and stream commands.
  - Existing `--no-redact` and runtime redaction wiring must be removed or converted to a compatibility no-op during implementation.
  - File is already above 500 lines, so compact/session work must stay scoped and push reusable logic into new modules.

- `src/runtime.ts`
  - Fetches snapshots, manages streams, parses rows, bounds raw text and row state, emits events, and optionally persists.
  - Currently redacts in `fetchSnapshot()` and `handleStreamChunk()` before parsing. This must be removed.
  - Existing stream append events contain raw line batches and parsed state. Compact stream output should use parsed state rows, not raw line batches.

- `src/parser.ts`
  - Already extracts the fields needed for compact mode: level, logger, message, router request/status/latency/tenant/client IP/request id, timestamp, source, stream, and continuations.
  - This should remain the semantic source of truth.

- `src/store.ts`
  - Existing persistent store is bounded and atomic.
  - After redaction removal, it stores full-fidelity bounded raw text when non-compact `--save` is used.
  - It should remain separate from temporary compact sessions.

- `src/paths.ts`
  - Currently exposes only the persistent store path and lock path.
  - Needs a new session directory path under `~/.saptools`.

- `src/redact.ts`
  - Existing helper is no longer package behavior.
  - Remove internal usage. Prefer deleting the module and tests; if a compatibility decision is made during implementation, it must not be used by runtime or CLI.

## Sample-Log Findings

Private sample logs were reviewed statistically without copying real identifiers into code, tests, docs, commit text, or final notes.

Observed shape:

- 6 log files.
- About 1.8 MB raw text.
- 918 split lines.
- 891 Cloud Foundry-formatted lines.
- 505 application-family rows.
- 386 router-family rows.
- 502 application JSON bodies.
- 888 CF bodies are at least 500 characters.
- 847 CF bodies are at least 1,000 characters.

Implications:

- Raw truncation alone is a weak compact strategy because verbose headers and repeated metadata can crowd out useful later rows.
- Full parsed JSON is much larger than raw because every row repeats `rawBody`, `jsonPayload`, and `searchableText`.
- A compact row projection with message/body capped at 500 characters keeps the useful fields while dropping high-token structural data.
- Router rows should prefer parsed request/status/latency/request id over the verbose raw router line.

Approximate sizing from local analysis:

- Compact text with a 500-character message cap was about one fifth of raw sample size.
- Compact JSON was about seven percent of full parsed-row JSON.

## User-Facing Semantics

### Snapshot

Existing behavior remains:

```bash
cf-logs snapshot --region <key> --org <org> --space <space> --app <app>
cf-logs snapshot --region <key> --org <org> --space <space> --app <app> --json
cf-logs snapshot --region <key> --org <org> --space <space> --app <app> --save
```

New compact behavior:

```bash
cf-logs snapshot --region <key> --org <org> --space <space> --app <app> --compact
cf-logs snapshot --region <key> --org <org> --space <space> --app <app> --compact --json
cf-logs snapshot --region <key> --org <org> --space <space> --app <app> --compact --save
```

Rules:

- `--compact` emits compact text.
- `--compact --json` emits a compact JSON document.
- `--compact --save` creates a temporary drill-down session and includes `ref` on each compact row.
- In compact mode, `--save` does not write to `cf-logs-store.json`; it writes the temporary session store.
- Outside compact mode, `--save` keeps writing the existing persistent store.

### Stream

Existing behavior remains:

```bash
cf-logs stream --region <key> --org <org> --space <space> --app <app>
cf-logs stream --region <key> --org <org> --space <space> --app <app> --json
cf-logs stream --region <key> --org <org> --space <space> --app <app> --save
```

New compact behavior:

```bash
cf-logs stream --region <key> --org <org> --space <space> --app <app> --compact
cf-logs stream --region <key> --org <org> --space <space> --app <app> --compact --json
cf-logs stream --region <key> --org <org> --space <space> --app <app> --compact --save
```

Rules:

- `--compact` emits compact parsed rows, not raw CF lines.
- `--compact --json` emits line-delimited compact events.
- Text mode keeps stream state messages on stderr.
- `--max-lines` counts compact rows emitted, not raw CF lines.
- `--compact --save` creates a temporary drill-down session and includes refs.
- Outside compact mode, `--save` keeps writing the existing persistent store.

### Parse

New compact behavior:

```bash
cf-logs parse --input ./sample.log --compact
cf-logs parse --input ./sample.log --compact --json
```

Rules:

- `parse --compact` emits compact text.
- `parse --compact --json` emits a compact JSON document.
- `parse --compact --raw` is invalid because compact and raw contradict each other.
- `parse --compact --save` is out of scope for this pass because drill-down refs are intended for CF snapshot/stream sessions.

### Show

New command:

```bash
cf-logs show <ref>
cf-logs show <ref> --json
```

Rules:

- `ref` format is `<session-id>:<row-id>`.
- Text output prints a readable full row, including full message/body and key metadata.
- JSON output prints the full saved `ParsedLogRow` plus session metadata.
- Missing, pruned, or expired rows return: `Saved log row not found or expired.`

### Session Commands

New commands:

```bash
cf-logs session list
cf-logs session list --json
cf-logs session prune
cf-logs session clear
```

Rules:

- `session list` shows active temporary drill-down sessions.
- `session prune` removes expired sessions.
- `session clear` removes every temporary drill-down session.
- These commands are separate from `cf-logs store`, which manages the existing persistent store.

### Compact Options

Add to `snapshot`, `stream`, and `parse`:

```bash
--compact
--compact-message-limit <count>
```

Add to `snapshot --compact --save` and `stream --compact --save`:

```bash
--compact-ttl-minutes <count>
```

Defaults:

- `DEFAULT_COMPACT_MESSAGE_LIMIT = 500`
- `DEFAULT_COMPACT_SESSION_TTL_MINUTES = 60`

## Compact Output Shape

Compact row fields:

- required: `id`, `time`, `level`, `source`
- optional: `stream`, `logger`, `message`, `request`, `status`, `latency`, `tenant`, `clientIp`, `requestId`, `ref`

Compact row must not include:

- `rawBody`
- `jsonPayload`
- `searchableText`
- full `rawText`

Compact document fields:

- `appName?`
- `generatedAt?`
- `truncated`
- `rowCount`
- `summary`
- `rows`

Summary fields:

- `firstTimestamp`
- `lastTimestamp`
- `levels`
- `sources`
- `formats`

Text format:

- First line: `summary rows=<n> truncated=<bool> levels=<...> sources=<...>`
- One row per line.
- Multiline messages are escaped as `\n`.
- Message/body is capped to `--compact-message-limit`.
- Router rows prioritize `request`, `status`, `latency`, and `requestId`.

## Temporary Session Store

Directory:

```text
~/.saptools/cf-logs-sessions/
```

File name:

```text
<session-id>.json
```

Session id:

- random lowercase hex string
- short enough for terminal use
- collision-resistant enough for local temporary files

Ref:

```text
<session-id>:<row-id>
```

Session JSON:

```json
{
  "version": 1,
  "sessionId": "7f3a9c2b",
  "createdAt": "2026-06-25T00:00:00.000Z",
  "updatedAt": "2026-06-25T00:00:00.000Z",
  "expiresAt": "2026-06-25T01:00:00.000Z",
  "ttlMinutes": 60,
  "target": {
    "apiEndpoint": "https://api.example.test",
    "org": "neutral-org",
    "space": "dev",
    "app": "neutral-app"
  },
  "rows": []
}
```

Storage rules:

- Store full parsed rows only, not full raw snapshot text.
- Store rows without package-level redaction.
- Use atomic writes through temp file and rename.
- Prune expired sessions before creating, listing, showing, pruning, or clearing sessions.
- For stream sessions, keep saved rows bounded by the configured log limit. Old refs can expire early when row bounds prune them.

## Runtime Changes

Remove package-level redaction:

- Remove `sanitizeText()` from `CfLogsRuntime`.
- Remove runtime redaction rule construction.
- Remove `redactionRules` and `skipRedaction` from runtime options.
- Snapshot flow should parse and store bounded raw logs directly.
- Stream flow should parse and emit chunk text directly.
- Existing persistent store writes bounded full-fidelity text.

Keep command-error hygiene:

- Do not add SAP password values to package-authored error messages.
- Continue avoiding unnecessary credential exposure in CF command environment handling.
- Do not transform user log content for privacy.

## Stream Compact Algorithm

For compact stream output:

1. Track `lastEmittedRowId` per app.
2. On append events, inspect `event.state.rows`.
3. Select rows with `row.id > lastEmittedRowId`.
4. If compact save is enabled, append those full rows to the temporary session first.
5. Build compact rows and attach refs for saved rows.
6. Print text rows or JSON compact events.
7. Increment emitted count by compact row count.
8. Honor `--max-lines` using compact row count.

## Files To Change

- `packages/cf-logs/src/types.ts`
  - add compact row/document/session types
  - remove runtime redaction options and redaction-only types if no longer exported

- `packages/cf-logs/src/compact.ts` (new)
  - compact row projection
  - compact document summary
  - text formatting

- `packages/cf-logs/src/session-store.ts` (new)
  - create and append temporary sessions
  - parse and format refs
  - show full rows by ref
  - list/prune/clear sessions

- `packages/cf-logs/src/paths.ts`
  - expose `cfLogsSessionsDir()`

- `packages/cf-logs/src/runtime.ts`
  - remove redaction
  - preserve full-fidelity snapshot and stream data

- `packages/cf-logs/src/store.ts`
  - keep bounded persistent writes
  - update naming/docs/tests that imply redaction

- `packages/cf-logs/src/redact.ts`
  - remove if no compatibility shim is needed
  - if retained temporarily, it must not be used by runtime or CLI

- `packages/cf-logs/src/index.ts`
  - export compact/session helpers
  - stop exporting redaction helpers if `redact.ts` is removed

- `packages/cf-logs/src/cli.ts`
  - add compact flags
  - add show/session commands
  - route compact output
  - remove user-facing redaction flags
  - keep file under the 700-line guardrail by pushing reusable logic into modules

- `packages/cf-logs/tests/unit/compact.test.ts`
  - compact projection and text formatting

- `packages/cf-logs/tests/unit/session-store.test.ts`
  - refs, full-row lookup, TTL prune, atomic session behavior

- `packages/cf-logs/tests/unit/runtime.test.ts`
  - update redaction expectations to full-fidelity behavior

- `packages/cf-logs/tests/unit/redact.test.ts`
  - remove if `redact.ts` is removed

- `packages/cf-logs/tests/e2e/parse.e2e.ts`
  - add compact parse coverage

- `packages/cf-logs/tests/e2e/snapshot.e2e.ts`
  - add compact snapshot save/show coverage
  - update save tests to expect full-fidelity persistent store content

- `packages/cf-logs/tests/e2e/stream.e2e.ts`
  - add compact stream save/show coverage
  - update no-redaction behavior

- `packages/cf-logs/README.md`
  - document compact mode, show/session commands, TTL, full-fidelity saves, and no package-level redaction

- `packages/cf-logs/package.json`
  - bump version after verification
  - prefer `0.2.0` because redaction removal changes public CLI/API behavior

## Test-First Plan

1. Compact unit tests:
   - app JSON rows keep id/time/level/source/logger/message.
   - router rows keep request/status/latency/request id and omit verbose raw router body.
   - default message cap is 500 characters.
   - custom message cap works.
   - summary counts levels, sources, and formats.
   - formatted text is stable and single-line per row.

2. Session-store unit tests:
   - saved rows receive refs in `<session-id>:<row-id>` shape.
   - `show` returns the full saved row.
   - expired sessions are pruned after the configured TTL.
   - malformed refs and missing rows return deterministic errors.
   - session writes stay bounded by log limit.

3. Runtime/store unit tests:
   - snapshot output keeps credential-like log text unchanged.
   - stream append state keeps credential-like log text unchanged.
   - persistent store writes full-fidelity bounded text.
   - runtime options no longer include redaction controls.

4. E2E tests:
   - `parse --compact` emits compact text and omits full parsed-row fields.
   - `parse --compact --json` emits a compact document.
   - `snapshot --compact --json --save` emits refs and `show <ref> --json` returns the full saved row.
   - `stream --compact --json --save --max-lines` emits compact row events with refs and supports `show`.
   - `session prune` removes expired sessions.
   - non-compact `snapshot --save` persists full-fidelity text.

5. Run compact/no-redaction tests before implementation where practical and confirm they fail for the expected missing behavior.

6. Implement in small layers: types, compact module, session store, runtime redaction removal, CLI, docs.

## Data Handling Notes

- The package does not redact log content.
- Compact mode reduces token volume only.
- `--save` writes full-fidelity log data.
- Temporary session data is local and TTL-bound but still sensitive.
- Generated store/session files must not be committed or shared blindly.
- Tests and docs must use synthetic neutral names only.

## Verification Plan

Run from the monorepo root:

```bash
pnpm --filter @saptools/cf-logs test:unit
pnpm --filter @saptools/cf-logs typecheck
pnpm --filter @saptools/cf-logs lint
pnpm --filter @saptools/cf-logs cspell
pnpm --filter @saptools/cf-logs build
pnpm --filter @saptools/cf-logs test:e2e
```

After checks pass:

- Review compact output against the private sample set using size/count measurements only.
- Do not copy private sample identifiers into source, tests, docs, commit message, or final notes.
- Confirm `src/cli.ts` remains under 700 lines.
- Confirm no function added exceeds 50 lines.

## Version, Commit, Push

After implementation and verification:

1. Bump `packages/cf-logs/package.json` to `0.2.0`.
2. Inspect the git diff and ensure unrelated user changes remain untouched.
3. Commit without `--no-verify` or `-n`.
4. Push the current branch.

## Review Follow-Up Plan

The post-implementation review found a few improvements worth making before the next release:

- `src/cli.ts`
  - Move the `parse --compact --raw` validation before reading input so contradictory flags fail immediately, even when stdin or an invalid input path is used.

- `src/cli-compact.ts`
  - Only emit a `ref` for rows that remain in the full-fidelity compact session after session bounding.
  - This prevents stale refs if compact session bounds are tighter than a batch of rows.

- `src/session-store.ts`
  - Reuse the existing file-lock helper for session writes and append mutations.
  - Remove the remaining filesystem error cast in `listSessionFiles()` and use the existing error-code guard.
  - Keep session JSON full-fidelity and unredacted.

- `tests/unit/compact.test.ts`
  - Add explicit coverage for the default 500-character compact message cap.

- `tests/unit/session-store.test.ts`
  - Add coverage for malformed session files being pruned deterministically.

- `tests/e2e/parse.e2e.ts`
  - Add coverage that `parse --compact --raw` returns the intended conflict error without trying to read the missing input file first.

- `tests/e2e/snapshot.e2e.ts`
  - Extend compact save coverage to verify `session list`, `session clear`, and invalid `show` behavior.

- `tests/e2e/stream.e2e.ts`
  - Extend compact save coverage to verify compact `--max-lines` counts compact rows and still supports full drill-down.

- `tests/**` and `README.md`
  - Replace credential-looking synthetic markers in touched test/docs content with neutral placeholders while preserving the full-fidelity behavior assertions.

Verification for the follow-up:

```bash
pnpm --filter @saptools/cf-logs test:unit
pnpm --filter @saptools/cf-logs typecheck
pnpm --filter @saptools/cf-logs lint
pnpm --filter @saptools/cf-logs cspell
pnpm --filter @saptools/cf-logs build
pnpm --filter @saptools/cf-logs test:e2e
pnpm --filter @saptools/cf-logs check
```

If checks pass, bump `packages/cf-logs/package.json` from `0.2.0` to `0.2.1`, commit only `packages/cf-logs` files, and push.

## Compact Newline Follow-Up

Observed behavior:

- Compact text rows currently render multiline messages as a visible `\n` marker.
- This comes from `src/compact.ts` converting real line breaks into the literal two-character sequence `\n`.
- For AI-oriented compact output, visible newline markers are noisy and consume tokens without adding much value.
- Full multiline data is still available through `cf-logs show <ref>` when compact output is saved, so compact output can safely normalize whitespace.

Implementation plan:

- `src/compact.ts`
  - Change inline text normalization from "line break to literal `\n`" to "line break and repeated whitespace to a single space".
  - Keep compact rows one physical terminal line each.
  - Keep the existing 500-character cap behavior after whitespace normalization.

- `tests/unit/compact.test.ts`
  - Update the compact formatting expectation so continuation lines become `first line second line`.
  - Assert compact output does not include literal `\n`.

- `package.json`
  - Bump patch version after verification.

Verification:

```bash
pnpm --filter @saptools/cf-logs check
pnpm --filter @saptools/cf-logs build
```

## Remove Parse Command Follow-Up

User decision:

- Remove the `parse` command from `cf-logs`.
- Remove `parse` usage from the README.
- The skill should focus on live snapshot/stream collection with `--compact --save`, not local log parsing.
- Keep `.skills/cf-logs/SKILL.md` concise: remove the extra first-step about `--json` and describe structured refs with a short one-line note instead of another full command block.

Implementation plan:

- `src/cli.ts`
  - Remove `parse` command registration.
  - Remove `ParseFlags`, stdin/file input helpers, and parse-only imports.
  - Keep runtime/parser exports intact for programmatic API users unless a separate request removes those APIs.

- `tests/e2e/parse.e2e.ts`
  - Delete parse command E2E coverage because the command no longer exists.
  - Keep parser unit tests because the parser remains part of the package internals and exports.

- `README.md`
  - Remove CLI `parse` section and quick references.
  - Keep programmatic parser docs only if they describe the Node API rather than the removed CLI command.

- `.skills/cf-logs/SKILL.md`
  - Remove item 5 from First Steps.
  - Replace the full `--compact --save --json` command example with a short note.

- `package.json`
  - Bump version from `0.2.2` to `0.3.0` because removing a CLI command is a breaking change.

Verification:

```bash
pnpm --filter @saptools/cf-logs check
pnpm --filter @saptools/cf-logs build
```

## Snapshot Time Filter Follow-Up

User request:

- Add a professional time filter for recent snapshots, using values such as `15m`, `45m`, and `1h`.
- The filter should run after `cf logs <app> --recent`, because CF controls the recent-log window.
- Keep tests and docs neutral and do not copy product, tenant, or route names from private log samples.
- Update the cf-logs skill briefly, update README, bump version, commit, and push.

Research notes:

- `snapshot` calls `CfLogsRuntime.fetchSnapshot()`, which prepares the CF target and calls `cf logs <app> --recent`.
- The package cannot ask CF for a specific relative time window; it can only filter rows after receiving recent logs.
- Private log samples show APP and RTR rows with an outer CF timestamp in ISO-like form with an offset, e.g. local `+0700`, and JSON payloads may also include a UTC timestamp. The outer CF timestamp should be the filter source because it exists across APP/RTR/text rows.
- `stream` uses live `cf logs <app>` output, not `--recent`, so a relative recent-window flag belongs on `snapshot` only for this change.

Implementation plan:

- `src/time-window.ts`
  - Add a focused internal helper module for parsing compact duration values and filtering parsed rows by timestamp.
  - Accept positive values with units `s`, `m`, `h`, and `d`; examples include `15m`, `45m`, and `1h`.
  - Filter out rows with timestamps older than `now - duration`, and omit rows with unparseable timestamps when a time filter is active.
  - Re-number filtered rows so compact IDs and refs match displayed rows.
  - Rebuild filtered raw text from filtered rows so non-JSON snapshot output is filtered too.

- `src/types.ts`
  - Add an optional `sinceMs` runtime option for snapshot filtering.

- `src/runtime.ts`
  - Apply `sinceMs` only in `fetchSnapshot()` because stream output is live, not recent backlog.
  - Keep `truncated` tied to raw CF output bounding, not to time filtering.
  - Persist and emit the filtered snapshot when `--save` is used.

- `src/cli.ts`
  - Add `--since <duration>` to `snapshot`.
  - Parse invalid values early with a clear CLI error.
  - Do not add `--since` to `stream` in this iteration because stream has no recent backlog.

- `tests/unit/time-window.test.ts`
  - Cover duration parsing, invalid values, row filtering, row re-numbering, and raw text reconstruction.

- `tests/e2e/snapshot.e2e.ts`
  - Add coverage that `snapshot --since 1h --json` filters recent rows relative to the runtime clock supplied by the fake-backed CLI.
  - Add coverage that invalid duration values fail before CF commands run.

- `README.md`
  - Document `--since <duration>` under `cf-logs snapshot` and explain it filters after CF returns `--recent`.

- `.skills/cf-logs/SKILL.md`
  - Add one short line advising `--since <duration>` for snapshot time windows.

- `package.json`
  - Bump from `0.3.0` to `0.4.0` because this adds a new CLI feature.

Verification:

```bash
pnpm --filter @saptools/cf-logs test:unit
pnpm --filter @saptools/cf-logs test:e2e
pnpm --filter @saptools/cf-logs check
pnpm --filter @saptools/cf-logs build
python3 /Users/dongtran/.codex/skills/.system/skill-creator/scripts/quick_validate.py .skills/cf-logs
```

## Search And Min-Level Filter Follow-Up

User request:

- Add smart search/filter capability for `cf-logs`, but keep the CLI simple.
- Research the real sample logs and implement professionally with focused tests, docs, skill update, version bump, commit, and push.
- Final scoped decision: add only `--search <text>` and `--min-level <level>` in this iteration.
- `--search` must be case-insensitive.

Research notes:

- Existing parser already builds normalized row fields and `searchableText`, and exports `filterRows()` with basic `level` + `searchTerm` support.
- Private log samples are dominated by APP JSON rows and RTR router access rows. High-value filter fields are level, free-text content, source family (`APP` / `RTR`), logger, router status, and request/correlation id.
- Filtering should happen after parsing and before output/persistence, so raw, JSON, compact output, compact refs, and store entries stay consistent.
- `snapshot` should combine existing `--since` with row filters.
- `stream` should filter matching live rows and count `--max-lines` by emitted matching rows, while compact `--save` should only create refs for emitted matching rows.
- Avoid a custom query language and avoid field-specific flags in this iteration. `--search` can cover logger/source/status/request ids through the parsed searchable row text, and `--min-level` covers severity.

Implementation plan:

- `src/types.ts`
  - Extend `FilterRowsOptions` with `minLevel`.
  - Add optional `rowFilter` to `CfLogsRuntimeOptions`.

- `src/parser.ts`
  - Keep `filterRows()` as the single row-filter helper for now because the simplified scope fits the parser module.
  - Keep existing `level` support for programmatic compatibility, but do not expose `--level` in the CLI.
  - Add minimum severity filtering for `trace < debug < info < warn < error < fatal`.
  - Keep `--search` matching case-insensitive by normalizing user input and using the parser's lowercase `searchableText`.
  - Re-number filtered rows so compact row ids and refs align with displayed rows.
  - Keep `newestFirst` default behavior for programmatic `filterRows()` compatibility, but allow runtime to preserve chronological order.

- `src/runtime.ts`
  - Apply `rowFilter` after parsing snapshot rows and after `--since`.
  - Fix snapshot state raw text to match the filtered snapshot raw text.
  - Apply row filters to stream append events so `--max-lines` counts emitted matching rows.
  - Keep the public runtime state filtered when a filter is configured; do not persist or emit filtered-out stream rows.

- `src/cli.ts`
  - Add `--search <text>` to both `snapshot` and `stream`.
  - Add `--min-level <level>` to both `snapshot` and `stream`.
  - Validate level and status values before CF commands run.

- `tests/unit/parser.test.ts`
  - Cover case-insensitive full-text search, min level, chronological order, newest-first compatibility, and row id re-numbering.

- `tests/unit/runtime.test.ts`
  - Cover snapshot row filtering before persistence.
  - Cover stream filtering before append events/persistence.

- `tests/e2e/snapshot.e2e.ts`
  - Cover CLI snapshot search returning only matching rows with mixed-case input.
  - Cover invalid min-level values failing before fake CF commands run.

- `tests/e2e/stream.e2e.ts`
  - Cover stream compact search filtering with refs and `--max-lines` counting matching rows.

- `README.md`
  - Document `--search <text>` and `--min-level <level>` for snapshot and stream.

- `.skills/cf-logs/SKILL.md`
  - Add one short line for search/min-level usage.

- `package.json`
  - Bump from `0.4.0` to `0.5.0`.

Verification:

```bash
pnpm --filter @saptools/cf-logs check
pnpm --filter @saptools/cf-logs build
python3 /Users/dongtran/.codex/skills/.system/skill-creator/scripts/quick_validate.py .skills/cf-logs
```

## CLI Help Copy Follow-Up

User request:

- Review every `cf-logs --help` surface for completeness, brevity, and clarity.
- Improve help wording if needed.

Research notes:

- Root help currently prints the full local store path in the description. That path is discoverable through `cf-logs store path` and makes root help noisy.
- Boolean options show `(default: false)` because Commander options were registered with explicit `false` defaults. The runtime already checks `flags.<name> === true`, so removing explicit false defaults keeps behavior while shortening help.
- `--save` is ambiguous because it has different storage behavior in compact mode. Help should mention compact refs in one short phrase.
- `--min-level` should show valid levels directly in help.
- `snapshot`, `stream`, `show`, `session`, `apps`, and `store` commands are present and conceptually complete; improvements should be copy-level only.

Implementation plan:

- `src/cli.ts`
  - Shorten root and command descriptions.
  - Remove explicit boolean `false` defaults from help registrations.
  - Tighten option descriptions for `--search`, `--min-level`, `--compact`, `--save`, `--json`, `--log-limit`, `--max-lines`, and compact ref TTL.
  - Keep command behavior unchanged.

- `tests/e2e/store.e2e.ts`
  - Add help coverage that root help stays concise, snapshot/stream help mention the key compact/filter flags, valid levels appear, compact refs are discoverable, and `(default: false)` is absent.

Verification:

```bash
pnpm --filter @saptools/cf-logs exec playwright test tests/e2e/store.e2e.ts
pnpm --filter @saptools/cf-logs check
pnpm --filter @saptools/cf-logs build
cf-logs --help
cf-logs snapshot --help
cf-logs stream --help
```
