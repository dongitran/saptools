# Changelog

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
