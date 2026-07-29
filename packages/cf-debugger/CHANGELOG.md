# Changelog

## 0.2.2 — 2026-07-29

This security and correctness patch hardens endpoint validation, deployment
mutation retries, and forced-stop recovery while keeping state on additive
schema v2. **Security behavior change:** `--api-endpoint` and the corresponding
programmatic start option now reject plaintext or malformed endpoints that
older releases accepted, because authentication credentials would otherwise be
sent to that endpoint.

### P0 — mutation, recovery, and credential safety

1. **P0-1:** `cf enable-ssh` and `cf restart` are explicitly classified as
   non-retryable mutations. A timeout issues no second mutation and reports
   `CF_MUTATION_TIMEOUT`, warning that the platform operation may still be in
   flight; read-only transient failures retain bounded retries.
2. **P0-2:** `stop --force` now removes the state record before best-effort
   deletion of its exact owned `CF_HOME`. An undeletable home produces a
   token-risk warning and becomes visible to `doctor` instead of trapping the
   session in state forever.
3. **P0-3 (breaking):** API endpoint overrides must be absolute HTTPS URLs with
   no userinfo, query, fragment, or non-root path. Invalid CLI and library
   values fail as `UNSAFE_INPUT` before any `cf` invocation or authentication.

### P1 — ownership and cross-version resilience

4. **P1-4:** timed-out one-shot SSH commands can terminate a still-open child
   spawned by this process even when the OS cannot provide a birth token;
   forced escalation remains identity-gated.
5. **P1-5:** macOS process identities now force `TZ=UTC` and `LC_ALL=C` and use
   versioned tokens. Legacy, malformed, or future token formats degrade to an
   unverified/retain verdict instead of pruning a live session.
6. **P1-6:** expensive listener ownership probes run outside the global state
   lock on the normal path. A changed or stale candidate is revalidated under
   the persistence lock before any prune, closing the TOCTOU gap.
7. **P1-7:** `doctor --cleanup` refuses to traverse a symlinked or non-directory
   v2 homes root and reports non-directory entries; a symlinked parent
   `~/.saptools` remains supported.
8. **P1-8:** startup cancellation keeps the lock-free sidecar fast path and
   again treats state `stopRequestedAt` or a missing record as compatibility
   stop signals, at the existing 500 ms cadence.
9. **P1-9:** `doctor` now identifies PID-only fallback when a mixed-version
   writer stripped the optional process-identity token.

### P2 — platform and outcome correctness

10. **P2-1:** loopback inspector HTTP checks opt out of the process-wide HTTP
    agent, so environment proxy support cannot route `/json/list` away from
    `127.0.0.1`.
11. **P2-2:** inspector attempt timeouts grow from 2.5 to 5 to 10 seconds while
    preserving retry and overall-budget headroom, allowing slow healthy
    inspectors to prove readiness.
12. **P2-3:** tunnel readiness budgets local bind, both ownership checks, and
    the inspector phase inside one deadline. A slow ownership command can no
    longer consume the inspector's reserved HTTP window.
13. **P2-4:** socket error listeners are installed before timeout/connect and
    all derived TCP timeouts are clamped positive, preventing a negative-timeout
    process crash.
14. **P2-5:** lifecycle cleanup no longer treats missing `lsof` as proof that a
    confirmed-dead owned child survived; it reports the lost diagnostic without
    silently assuming termination.
15. **P2-6:** ready-session stop intents are cleared after use and the tunnel
    close handler cross-checks state, preventing stale sidecars from turning a
    later crash into exit 0.
16. **P2-7:** `stop --all` distinguishes forced outcomes and returns cleanup
    exit code `70` when any captured outcome contains
    `TUNNEL_TERMINATION_FAILED`.
17. **P2-8:** `CF_DEBUGGER_ALLOW_RESTART=0` is now a hard veto for library calls
    as well as the CLI; environment value `1` never grants a programmatic caller
    permission by itself.
18. **P2-9:** duplicate session IDs keep the first valid record and drop only
    later copies, preserving ownership evidence for a possibly live tunnel.
19. **P2-10:** stale main-lock and abandoned recovery-lock reclamation now
    compare-delete against the originally observed owner token (or a legacy
    file fingerprint), so a replacement lock is not blindly unlinked.
20. **P2-11:** corrupt-state backups remain ineligible for automatic deletion
    but now include an evidence warning and shell-quoted manual removal command.
21. **P2-12:** stop-intent inspection failures no longer turn an otherwise
    confirmed lifecycle shutdown into a false tunnel failure.
22. **P2-13:** `doctor --cleanup` reports eligible cleanup as `skipped`, rather
    than `not-requested`, when corrupt/incomplete state makes deletion unsafe.
23. **P2-14:** an unknown child signal maps to a stable nonzero fallback instead
    of producing `NaN` and a secondary range error.
24. **P2-15:** CLI and README wording now clarify that `--remote-port` selects
    where to find an inspector already opened with matching `--inspect=<port>`;
    `SIGUSR1` cannot choose a custom port.

### P3 — maintainability and diagnostics

25. **P3-1:** oversized lifecycle, startup, command-execution, process-stop, and
    CLI handlers were split into focused helpers without changing their
    fail-closed outcomes.
26. **P3-2:** one-shot SSH execution, shared bounded-output/redaction helpers,
    and persistent-tunnel diagnostics now live in separate modules, leaving
    every source file below the package limit.
27. **P3-3:** startup-age and recorded-process verdicts have one shared
    implementation for health pruning and explicit stop.
28. **P3-4:** obsolete single-PID ownership and identity helpers plus the unused
    inspector timeout constant were removed.
29. **P3-5:** readiness races dispose their losing child-close listeners instead
    of leaking two listeners per start.
30. **P3-6:** legacy-v1 doctor output now reports home counts and defensively
    parsed claimed sessions with conservative PID liveness, without adopting or
    mutating v1 state.
31. **P3-7:** missing-app failures consistently name `--app or selector`.
32. **P3-8:** `--version` reads the installed package metadata at runtime, so it
    cannot drift when packaging updates the version after compilation.
33. **P3-9:** documentation now calls out the descriptor-dependent cost of the
    non-GNU remote `/proc` fallback.
34. **P3-10:** ambiguous multi-Node selection now reports the discovered PID
    candidates so cluster users can choose a request-handling worker with
    `--node-pid`.
35. **P3-11:** automatic local-port scans start at a deterministic hash of the
    exact registration identity and wrap the full range, reducing concurrent
    first-candidate collisions while preserving preferred-port priority.

## 0.2.1 — 2026-07-27

- Re-verify the spawned one-shot SSH process identity immediately before both
  graceful termination and forced escalation. If Unix process ownership can no
  longer be proved, cf-debugger now refuses to signal the PID, releases its
  local stream handles, and preserves the existing timeout/abort result.

## 0.2.0 — 2026-07-27

This minor release intentionally changes observable safety behavior. Startup can
now reject a tunnel that 0.1.x reported as ready, app restart is opt-in, tunnel
signal death and failed cleanup use nonzero exit statuses, and new recovery
commands/flags are available. State remains additive schema v2.

1. Readiness now proves both local listener ownership and an attachable Node
   inspector response from `/json/list`. A bound forward with no working remote
   inspector fails as `INSPECTOR_UNREACHABLE`.
2. Automatic `cf enable-ssh` plus `cf restart` is now opt-in through
   `--allow-ssh-enable-restart` or `CF_DEBUGGER_ALLOW_RESTART=1`. Permission,
   already-enabled, space-policy, and unknown-probe failures never restart the
   app; an allowed restart is warned with its exact target.
3. Session recovery now detects PID reuse, bounds abandoned startup records, and
   provides `stop --force` to forget unverifiable state without signalling an
   unverified process. The public `stopAllDebuggers()` return value changes from
   a count to a `StopAllResult` containing every per-session outcome and summary
   count; CLI `stop --all` rejects any simultaneous selector instead of silently
   widening the requested scope.
4. Tunnel signal death maps to `128 + signal`; incomplete cleanup exits `70`.
   Cleanup ignores unrelated listeners that later occupy the old local port.
5. Region resolution includes all sibling-package regions and synthesizes valid
   new SAP keys with a warning. Malformed keys use `UNKNOWN_REGION`, and
   `--api-endpoint` is available for exact/nonstandard landscapes.
6. Startup has one configurable overall deadline (`--startup-timeout`, default
   five minutes). CF retries share that budget, rejected credentials are tried
   once, and verbose retry messages show the remaining time.
7. Bounded, redacted tunnel stdout/stderr tails now reach readiness and
   unexpected-exit diagnostics; verbose mode streams labelled redacted lines.
8. One corrupt session no longer erases healthy records. Invalid originals are
   preserved as private corrupt backups, and the new read-only `doctor` command
   reports orphan homes/ports/temp files and legacy credential artifacts;
   `doctor --cleanup` performs only guarded v2 cleanup.
9. Batch stop, Windows port parsing, multi-PID ownership, exact selectors,
   guarded home deletion, stream-specific truncation, macOS `lsof` diagnostics,
   configurable remote inspector ports, `--version`, color-free CF parsing, and
   immutable per-session `CF_HOME` behavior are corrected.
10. Remote listener ownership avoids one fork per file descriptor, startup stop
    polling is reduced to a proportionate cadence, port scans no longer hold the
    global lock, and no-op state writes/redundant reads are removed.
11. Dead CF table helpers are removed, bundles share split chunks, startup
    responsibilities are separated, foreign-host locks age out conservatively,
    failed status streams remain terminal at `error`, and selector/input errors
    consistently use coded failures.
