# Changelog

<!-- cspell:words VARCHAR -->

## 0.7.0

### Fixed

- Pruning no longer deletes saved results it cannot read. `pruneResultSessions` runs at the head of
  every save, read and list, and it treated four distinct outcomes — file absent, I/O error, invalid
  JSON, unrecognized shape — as one "missing" answer, then `rm -rf`'d the directory. So a
  nominally read-only `result list` destroyed a valid unexpired session whose only difference was a
  newer `version`, and one that was merely unreadable at that moment (a permission error, with the
  data fully intact). Because the self-updater makes mixed versions on one machine normal, that also
  meant an older cf-hana silently wiped a store a newer one had written.

  Reads are now classified, and only an expired session or an empty ref directory is removed. A
  manifest that cannot be read or recognized is left exactly where it is and counted as retained; a
  ref directory holding files under names this version does not know is retained too.

- A saved result with a damaged `expiresAt` is no longer immortal. `Date.parse` returns `NaN` for it
  and `NaN <= now` is `false`, so such a session survived every prune for ever and still read back.
  Expiry now falls back to `createdAt` plus `ttlMinutes`, and a session whose age cannot be
  established by either route is treated as expired.

- One undeletable directory no longer takes the whole store offline. Deletion is attempted per
  session, and the housekeeping prune is best-effort, so `result show` and `result list` keep working
  on intact sessions even when the results directory cannot be listed. `result show` also enforces
  the TTL itself instead of relying on that prune having succeeded.

- `result show` now says which of the three things went wrong. An unreadable manifest and one written
  in a newer format used to report "Saved result not found or expired", which was untrue; both now
  name the file, and a newer format says it was left in place. Added the `RESULT_UNREADABLE` error
  code.

- `result list` reports the ref that actually resolves. The listed ref came from inside the manifest
  while lookup uses the directory name; when those disagreed, `list` advertised a ref that
  `result show` rejected. Expired sessions that prune could not remove are omitted rather than shown.

- Pruning no longer deletes a saved result whose expiry it cannot establish. `resolveExpiryMillis`
  previously fell back to "treat as expired", so a manifest with damaged timestamps had its rows
  deleted even though they were perfectly readable — and a version that changed only the *timestamp
  encoding* (a Temporal `ZonedDateTime`, an ISO week date, epoch millis as a string, or canonical
  ISO with surrounding whitespace, which `Date.parse` does not trim) would have had its data
  destroyed by an older binary. Such a session is now retained and reported, like any other manifest
  this version cannot fully interpret. One rule now covers every case: only an expired session with
  a resolvable date, or a ref directory verified to be empty, is ever deleted.

- A `ttlMinutes` too large to date no longer produces an immortal session. The bound is what a `Date` can hold, not what a float can hold: `Number.isSafeInteger` admits a value whose product with 60000
  reaches 5.4e20, while a `Date` holds at most ±8.64e15 ms — so `createdAt + ttlMinutes` could yield
  a *finite* expiry no clock will ever reach, which survived every prune and was not even counted.
  A derived expiry beyond the `Date` range is now treated as unresolvable, hence retained.

- `result prune` names the refs it left in place instead of only counting them. A retained session is
  omitted from `result list` and no command removes one, so the ref is the only way to find the file.

- `result prune` exits non-zero when it could not delete an expired session. It is the only
  machine-readable health signal the store has, and reporting a partial sweep as success meant
  `if cf-hana result prune; then …` could never detect a store it had failed to clean.

- `PruneOutcome` is now `{ removed, failed, retainedRefs }`. `retained` was a count the user could
  not act on; the refs replace it.

### Changed

- `pruneResultSessions` returns `{ removed, retained, failed }` instead of a bare count.
  `result prune` still prints `removed=N` as its only stdout line and reports retained and
  undeletable counts on stderr. The type is internal to the CLI: `index.ts` deliberately exports no
  part of the result store.

### Known limitations

- A leftover `<ref>.tmp-<pid>` directory from an interrupted save is invisible to `result list`,
  `result prune` and `result clear`, and no TTL reaches it. Reclaim it by hand.
- A retained session is reported by `result prune` but not listed, and there is no `result rm`;
  `result clear` is the only in-tool removal and it removes everything it can see.
- `result list` omits a session it could not read without saying so. Only `result prune` reports
  those.

## 0.6.0

- **Self-updating.** Every command now checks npm for a newer `@saptools/cf-hana` (at most once an hour)
  and, when one exists, installs that exact version and re-runs the command on it, announcing both steps
  on stderr. `SAPTOOLS_AUTO_UPDATE=on|notify|off` controls it (see the README's Updates section); it is
  off by itself in CI, in tests, from a source checkout and inside the re-run. New `cf-hana self-update
  [--check]` forces the check and install now. `--version` now reads `package.json` at runtime. Both come
  from the private, build-time-bundled `@saptools/core` package; the published tarball gains no runtime
  dependency.


## 0.5.4 - 2026-07-26

- **Security fix:** `0.5.3`'s routine/anonymous-block carve-out
  (`isRoutineDefinition`/`isAnonymousBlock`) checked only that a top-level
  `BEGIN` and `END` existed *somewhere* in the string, not that they were
  correctly paired, ordered, or preceded only by plausible header content —
  a bare keyword-existence check, not a structural one. Two independent
  exploit families reopened the exact zero-flags bypass `0.5.3` exists to
  close, in normal mode with no flags required at all:
  1. A reordered/partial body, e.g. `CREATE PROCEDURE p AS DELETE FROM t
     WHERE id=1; DROP TABLE other; END BEGIN` (and the `DO` equivalent).
  2. **(Found by independent review, after this release's first cut
     already shipped internally)** the search for a routine/block's first
     `BEGIN` applied no validation to what it skipped over on the way
     there — it would skip straight past an entire independent,
     `;`-separated statement to reach a later, genuinely well-formed
     `BEGIN ... END`, exempting the smuggled statement along with it, e.g.
     `CREATE PROCEDURE p(x INT); DROP TABLE other; SELECT 1 BEGIN END`.
  Fixed by depth-tracking `BEGIN`/`END` nesting the same way this file
  already depth-tracks parentheses, *and* requiring the region between a
  chunk's header keywords and its own first `BEGIN` to contain no top-level
  `;` and no keyword that could lead an independent, dangerous statement
  from a fixed set (`SELECT`/`CREATE`/`DROP`/`ALTER`/`TRUNCATE`/`RENAME`/
  `COMMENT`/`WITH`/`CALL`/`MERGE`/`UPSERT`/`REPLACE`, plus `INSERT`/
  `UPDATE`/`DELETE` for every header type except `TRIGGER`, since a trigger
  header legitimately references those three as its own event keywords,
  e.g. `BEFORE INSERT` — `MERGE`/`UPSERT`/`REPLACE` have no such legitimate
  role in a trigger header and stay disqualifying for every type). The
  region is also required to skip exactly the routine/trigger's own name
  first (a bare or quoted identifier, optionally schema-qualified) before
  that keyword check runs at all, since a legitimately-named routine can
  coincide with one of those keywords (e.g. an unquoted `replace`) without
  being a smuggled statement — a single identifier token can never itself
  contain a real top-level `;` or a second keyword, so this cannot be used
  to also skip real smuggled content. This closes the reordering bypass, a
  stray `END` with no preceding `BEGIN`, both keywords appearing early with
  real content trailing the close, and both exploit families above. As a
  direct consequence, `0.5.3`'s own disclosed residual limitation — content
  genuinely appended *after* a routine or anonymous block's own real `END`
  — is also closed, for both `CREATE PROCEDURE`/`FUNCTION`/`TRIGGER` and
  `DO` blocks. Chaining several independently-legitimate definitions back
  to back (e.g. two `CREATE PROCEDURE` statements in one call) remains
  allowed, since defining a routine is not itself destructive.
  **Disclosed, narrow residual limitation:** because `TRIGGER` headers are
  exempted from the `INSERT`/`UPDATE`/`DELETE` part of that keyword check
  (to avoid rejecting ordinary trigger event clauses), a chunk that
  specifically disguises itself as `CREATE TRIGGER` and references one of
  those three verbs with no `;` and no `BEFORE`/`AFTER`/`INSTEAD OF` prefix
  at all in its header (e.g. `CREATE TRIGGER t2 DELETE FROM customers
  BEGIN END`, chained after a separate legitimate definition so a real `;`
  exists for the check to matter at all — a fully standalone, semicolon-
  free instance of this shape is already unaffected by this check either
  way, since `hasMultipleStatements` never flags a string with no
  top-level `;` regardless) is not rejected. Distinguishing a legitimate
  trigger event keyword from a bare one requires validating it is actually
  preceded by a trigger-timing keyword, which edges into full
  SQLScript-header grammar parsing — out of scope for this fix, the same
  way parsing a routine body's own contents is out of scope for the
  carve-out itself. This is narrower than either exploit family above: it
  requires specifically choosing `TRIGGER` (not `PROCEDURE`/`FUNCTION`/
  `DO`) as the disguise, using specifically `INSERT`/`UPDATE`/`DELETE` (not
  any other keyword), chained with a real `;` elsewhere in the input.
- **Separately noticed while verifying the fix above, not fixed here:**
  the header-disqualifying keyword set above is a fixed list derived from
  this file's own existing DDL/DML/SELECT/WITH/CALL vocabulary, not every
  keyword that could lead an independent dangerous statement in general —
  `GRANT`/`REVOKE` are notable omissions. This is not unique to the
  routine/block carve-out: a bare, semicolon-free single statement leading
  with an unrecognized keyword (`GRANT`, `REVOKE`, or anything else
  `classifyByKeyword` does not recognize) is *already* treated as
  non-destructive by this guard's existing classifier, with or without any
  routine/trigger wrapper around it, since only a statement's own leading
  keyword and `WHERE`-scope are inspected. Extending the classifier's
  keyword vocabulary to cover `GRANT`/`REVOKE` (and auditing for other
  gaps of the same shape) is a separate, broader task than the
  routine-header validation this release adds, and is not attempted here.
- **Security fix, pre-existing since `0.5.1`/`0.5.2`, broader than
  previously disclosed:** the `WITH`-CTE-list parser (`cteListEndIndex`)
  did not fail closed once a CTE list was itself well-formed — if whatever
  followed it was neither a comma nor a recognizable keyword (e.g. stray
  punctuation), it returned a *defined* result with an empty `""` keyword
  rather than `undefined`, which slipped past the guard's
  unresolved-`WITH` fail-closed check. `0.5.3`'s changelog disclosed a
  narrower version of this gap specific to a semicolon placed mid-CTE-list;
  this follow-up review found the same defect is reachable with no
  semicolon involved at all (`WITH a AS (SELECT 1 FROM DUMMY) !!! DELETE
  FROM customers`). Fixed by requiring the character immediately after a
  completed CTE list to be keyword-shaped (alphabetic) before treating the
  resolution as successful; otherwise it now fails closed exactly like an
  already-malformed CTE list. An unrecognized-but-alphabetic continuation
  (e.g. `EXPLAIN`) is unaffected and continues to resolve and classify
  exactly as before.
- The hand-maintained zero-width/invisible-character allowlist (5 code
  points, added in `0.5.3`) is replaced with a Unicode-property match
  (`\p{Cf}`, the standard "Format" general category), closing several
  realistic gaps it missed — including left-to-right/right-to-left marks,
  soft hyphen, and several invisible math-layout characters — instead of
  only the handful of code points a prior session happened to notice.
  Verified empirically to match every previously-listed code point, match
  none of A-Z/0-9/standard SQL punctuation, and not create any way to hide
  real trailing content.

## 0.5.3 - 2026-07-26

- **Security fix:** the safety guard and pre-write backup planner only ever
  looked at a SQL string's leading statement — nothing checked whether the
  string contained a second, `;`-separated statement after it. A properly
  `WHERE`-scoped write (exactly the kind of statement the guard is designed
  to wave through) could carry an entirely separate, unscoped statement
  (`DELETE FROM t WHERE id=1; DROP TABLE other`) past the guard with **no
  flags required at all**, in both normal and `--read-only` mode. Until this
  release, the only thing preventing a smuggled second statement from
  actually running was SAP HANA's own rejection of multi-statement text —
  behavior this tool never guaranteed and must not be understood to rely on.
  `cf-hana` now refuses any SQL argument containing more than one genuine
  top-level statement, unconditionally — not overridable by
  `--allow-destructive` or `--read-only` — via a structural, quote/comment/
  paren-aware scan for a real (not string-literal, not commented-out,
  not nested) `;` separator, matching the same "cannot safely determine the
  statement's true shape, refuse rather than guess" precedent already
  established for an unresolvable `WITH` clause. The pre-write backup
  planner applies the identical check before doing anything else, since it
  runs on every CLI statement before the main guard does and would otherwise
  fold a smuggled statement straight into its derived backup `SELECT`.
- `CREATE PROCEDURE`/`FUNCTION`/`TRIGGER` definitions **that have a real
  `BEGIN`/`END` body** — and, separately, HANA SQLScript anonymous
  `DO [(...)] BEGIN ... END` blocks — are exempted from this check, since a
  genuine routine/block body legitimately contains many internal,
  top-level-looking semicolons that are not additional smuggled statements.
  An independent review caught that the first implementation of this
  exemption checked only the leading keyword pair (e.g. `CREATE PROCEDURE`)
  with no body required at all, which would have let a bare
  `CREATE PROCEDURE p; DROP TABLE other` skip the multi-statement check
  entirely with no flags required — fixed before release by requiring an
  actual top-level `BEGIN` and `END` to be present. **Disclosed, intentional
  residual limitation:** the exemption still covers the entire
  routine-creation statement once a body is confirmed present, so content
  genuinely appended *after* such a body's own `END` (e.g.
  `CREATE PROCEDURE p AS BEGIN ... END; DROP TABLE other`) is not caught by
  this check either — a full SQLScript `BEGIN`/`END`-nesting-aware parser
  would be required to find where the routine body truly ends, which is out
  of scope for this fix. This narrows a previously-universal gap down to one
  specific, harder-to-reach statement shape; it does not close it completely.
- Also caught by that same review and fixed before release: a lone
  zero-width space or similar invisible Unicode formatting character
  trailing an otherwise ordinary single statement's `;` — a realistic
  artifact of pasting SQL out of a chat app, word processor, or web page —
  was being treated as a smuggled second statement and incorrectly refused.
  An unclosed top-level parenthesis before a genuine `;` separator (itself
  already invalid SQL) also defeated detection and the existing `WHERE`-scope
  check simultaneously; it is now treated the same as an unresolvable `WITH`
  clause — refused outright, since the statement's real shape can't be
  determined.
- Separately noticed while verifying this fix, not fixed here: the `0.5.2`
  `WITH`-CTE-list parser (`cteListEndIndex`) does not fail closed for a `;`
  placed *inside* a multi-CTE list (between two CTE definitions rather than
  after the whole list) — it returns a defined result with an empty
  `keyword` instead of `undefined`. This is not a live guard bypass on its
  own (any input reaching this path also has a genuine top-level `;`, which
  this release's new check independently catches), but it is a real,
  pre-existing gap in the `0.5.2` parser worth a future, narrowly-scoped fix.

## 0.5.2 - 2026-07-25

- **Security fix:** the `0.5.1` fix for `WITH`-prefixed guard bypasses shipped
  with its own gap — a `WITH` statement whose CTE name was a double-quoted
  identifier (e.g. `WITH "x" AS (...) DELETE FROM ...`) was misclassified as
  `unknown` instead of resolving to its real trailing statement, and that
  `unknown` classification was previously treated as non-destructive and
  exempt from the automatic pre-write backup. A quoted-CTE-name write with no
  `WHERE` clause reached the database with no client-side block at all, and
  no backup was attempted for a quoted-CTE-name write of any shape. Anyone
  who upgraded to `0.5.1` believing that release fully closed the `WITH`
  guard-bypass class should know it did not, quite yet — this release does.
  The parser now correctly recognizes a quoted CTE name instead of skipping
  past it as if it were blank space; a genuinely unparseable `WITH` statement
  (for any reason, not only quoting) is now also treated as destructive by
  the safety guard and refuses the pre-write backup outright, rather than
  silently falling back to "not destructive, no backup" as it did before.

## 0.5.1 - 2026-07-25

- **Security fix:** a `WITH`-prefixed write (e.g. `WITH x AS (...) DELETE
  FROM ...`) and a bare `CALL <procedure>()` both previously slipped past
  the `--read-only` and destructive-statement guards entirely — the former
  was always classified as a harmless `SELECT` regardless of what it
  actually did, and the latter was never classified as destructive at all,
  so it ran with no `--allow-destructive` confirmation even in the default
  (non-read-only) mode. Both are now correctly classified and guarded.
  Anyone relying on `--read-only` or the destructive-statement guard as a
  hard trust boundary should treat this as the release that closes that gap.
  The automatic pre-write backup now also correctly recognizes and protects
  a `WITH`-prefixed `UPDATE`/`DELETE`/`UPSERT`/`MERGE`, matching what a
  non-`WITH` equivalent write already produced.
- Disable SAP HANA Cloud's reactive mid-auth redirect on every connection
  (direct and tunneled): on a genuine multi-node HANA Cloud instance, the
  server can redirect an already-established connection to an internal
  per-node hostname that isn't reachable outside SAP's own network, which
  previously defeated the SSH-tunnel fallback by silently abandoning the
  tunnel for a fresh, untunneled connection that failed the same way the
  original direct connection did.
- Fix the SSH-tunnel fallback's candidate discovery calling `cf apps`
  (measured at up to ~20s against a large space) before ever trying the
  already-known target app or a cached "last worked" app, which could
  starve the entire shared fallback budget before a working candidate got a
  chance. Known candidates are now always tried first; `cf apps` is only
  called if none of them work, and is bounded to whatever budget remains
  rather than retried on its own separate timeout/retry policy.
- Cap the direct-connect attempt's own timeout to the tunnel fallback's
  per-candidate ceiling whenever a fallback is available, so a silently
  hanging (rather than actively refused) direct connection can no longer
  consume its full configured timeout before the tunnel path gets a chance
  — lowering the documented worst-case latency from ~85s to ~40s.
- Fix `--refresh-tunnel` leaking the SSH process it superseded; the old
  tunnel is now terminated instead of running until its keepalive elapses.
- Surface a failed tunnel candidate's actual stderr (e.g. "SSH disabled for
  this app") via the existing connectivity status output on stderr, instead
  of discarding it silently.
- Fix a freshly-established or reused tunnel being cached as usable even
  when its own post-connect setup failed in a way that looked like a
  dropped connection rather than a genuine, actionable HANA rejection.
- Bound how long a process waits for another concurrent invocation to
  finish establishing the same host's tunnel, so the entire shared deadline
  can no longer be spent waiting on a leader whose owning process has
  already died.

## 0.5.0 - 2026-07-25

- Add an SSH-tunnel fallback for HANA Cloud hosts unreachable directly (e.g.
  IP-allowlisted landscapes): on a classified connectivity failure, discover
  a jump-host app in the same org/space via `cf apps`, open a local
  `cf ssh -L` port-forward, and retry through it. Zero behavior change when
  the direct connection succeeds.
- Add `--tunnel` to skip the direct attempt and connect via a tunnel
  immediately, and `--refresh-tunnel` to bypass a cached/live tunnel and
  force a fresh attempt. No disable switch: the fallback can only help or
  no-op, and rethrows the original connection error unchanged on total
  failure.
- Persist and reuse the live tunnel under `~/.saptools/cf-hana/tunnel/`
  across every connection this CLI's pool opens and across separate
  invocations run in a row against the same host, with a race-free
  concurrent-establishment marker and automatic reaping of dead or
  cross-org tunnels.

## 0.4.0 - 2026-07-14

- Back up `REPLACE` and matched `MERGE INTO` pre-images, cap backup size, and
  refuse those statements when their target or safe pre-image cannot be derived.
- Confirm every resolved CLI target on stderr, distinguish ambient from explicit
  selectors, and verify direct `cf env` identity against the ambient target.
- Add actionable insufficient-privilege guidance with schema, technical user,
  current binding, and sibling binding names without automatic retries.
- Auto-save exact rows only when compact CSV shortens cells, add
  `--no-auto-save`, and make implicit storage failures non-fatal.
- Add lossless `query --format table|json|json-compact|csv`, flat catalog name
  output, and exact per-command JSON schemas in help while preserving defaults.
- Scope metadata suggestions by binding identity and document the existing
  bounded CF retries and 60-second timeout defaults.

## 0.3.5 - 2026-07-06

- Normalize HANA `BOOLEAN` result columns that arrive from the driver as `1`/`0`
  into JavaScript `true`/`false` values before CLI/API formatting and saved refs.

## 0.3.4 - 2026-07-02

- Keep explicit selector region lookup map-backed so unknown technical keys fail before isolated authentication unless they are added to the maintained SAP CF region catalog.

## 0.3.3 - 2026-07-02

- Fix Cloud Foundry region resolution for indexed SAP regions such as `eu10-005`, representative `eu20`/`us10` indexed endpoints, and China `platform.sapcloud.cn` endpoints.
- Keep bare CLI selectors on the core current-session path so healthy `cf env <app>` calls do not require isolated SAP re-authentication.
- Preserve and validate the current CF API endpoint for auth fallback, reject unsafe endpoint shapes, and keep binding discovery live-only without restoring `cf-sync` cache reads.
- Update `--refresh`, README, and cf-hana skill text to describe the retained compatibility flag truthfully.

## 0.3.2 - 2026-07-01

- Remove the `cf-hana: saved result expires at...` stderr notice from `query --save` output while keeping result refs available for inspection.

## 0.3.1 - 2026-07-01

- Add actionable HANA LOB `ORDER BY`/`GROUP BY` hints that recommend removing LOB columns or wrapping them with `TO_VARCHAR(<column>)`.
- Add invalid-column typo suggestions that inspect target table columns and print close matches to stderr.
- Increase the default saved result TTL from 60 minutes to 7 days.

## 0.3.0 - 2026-07-01

- Add invalid table/view recovery suggestions for failed `query` statements, with nearby table and view names printed to stderr so stdout remains parseable.
- Add a private local metadata cache under `~/.saptools/cf-hana/metadata` with a strict 30-minute TTL and `--refresh-metadata` bypass.
- Include schema-scoped `SYS.TABLES` and `SYS.VIEWS` metadata for suggestions without caching credentials, parameters, result rows, or table data.

## 0.2.0 - 2026-06-25

- Change CLI `query` output for `SELECT`/`WITH` statements to compact CSV and
  remove `--format` from `query`.
- Default bare `SELECT` queries to at most 100 returned rows, with accurate
  N+1 truncation detection.
- Limit visible SELECT data cells to 128 characters by default, configurable
  with `--cell-limit <n>` up to 10,000.
- Add `query --save` and `cf-hana result` commands to save exact returned rows
  for 60 minutes, inspect rows/cells/JSON paths by ref, search saved values,
  export exact cells, and prune local result sessions.
- Keep programmatic query APIs and write backups full-fidelity.

## 0.1.6 - 2026-06-23

- Expand fake-backed E2E coverage for complex `UPDATE` and `DELETE` backups,
  including mixed-case keywords, comments, quoted identifiers, nested queries,
  placeholder filtering, and unscoped writes.
- Verify backup SELECT failures, write failures, filesystem failures, read-only
  mode, malformed SQL, and parameter mismatches cannot bypass backup safety.
- Add opt-in fake-driver statement tracing and deterministic failure injection
  without recording parameter values.

## 0.1.5 - 2026-06-23

- Remove the CLI `--no-backup` opt-out so `cf-hana query` always attempts a
  local backup before running `UPDATE` or `DELETE`.
- Keep backup paths on stderr and keep stdout parseable for table, JSON, and CSV
  output.

## 0.1.4 - 2026-06-23

- Add automatic local CSV backups before CLI `query` runs an `UPDATE` or
  `DELETE`.
- Derive the backup `SELECT` from the write target and top-level `WHERE`
  clause, preserving only the WHERE parameters for `UPDATE` statements.
- Save each backup in its own non-expiring folder with `statement.sql` and
  `backup.csv`.

## 0.1.3 - 2026-06-23

- Add local SQL history for successful direct `query` and `execute` calls under
  `~/.saptools/cf-hana/histories/YYYY-MM-DD.jsonl`.
- Rotate SQL history with five-day retention and keep parameter values,
  credentials, certificates, and result rows out of the history file.
- Keep helper-driven catalog SQL out of user SQL history and document the new
  local state behavior.

## 0.1.2 - 2026-06-23

- Harden connection pooling so queued callers continue after transient reconnect failures.
- Preserve query results when HANA statement cleanup fails and close partially opened clients on schema setup errors.
- Strengthen read-only and destructive-statement checks around comments, quoted identifiers, and unknown statements.
- Improve `explain()` statement isolation, cleanup, and read-only behavior.
- Validate CLI numeric options strictly and align E2E diagnostics with project defaults.

## 0.1.1 - 2026-05-22

- Patch release to publish via npm trusted publishing after the manual `0.1.0` bootstrap.

## 0.1.0 - 2026-05-22

- Initial release: run SQL directly against SAP HANA Cloud databases bound to a Cloud Foundry app, addressed by a `region/org/space/app` selector (or a bare app name).
- Credentials are resolved cache-first via `@saptools/cf-sync`, with an on-demand live Cloud Foundry fetch fallback.
- Includes a `HanaClient` with pooled connections, parameterized queries, transactions, table introspection, query-builder shorthands, a read-only/destructive-statement safety guard, and a `cf-hana` CLI.
