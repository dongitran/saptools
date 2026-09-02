# Changelog

## 0.3.0

- **Self-updating.** Every command now checks npm for a newer `@saptools/cf-events` (at most once an hour)
  and, when one exists, installs that exact version and re-runs the command on it, announcing both steps
  on stderr. `SAPTOOLS_AUTO_UPDATE=on|notify|off` controls it (see the README's Updates section); it is
  off by itself in CI, in tests, from a source checkout and inside the re-run. New `cf-events self-update
  [--check]` forces the check and install now. `--version` now reads `package.json` at runtime. Both come
  from the private, build-time-bundled `@saptools/core` package; the published tarball gains no runtime
  dependency.


## 0.2.1

- Fixed `--since` and `--lookback` audit-event filters to send Cloud Foundry-compatible timestamps without fractional seconds.
- Surfaced Cloud Foundry API error responses from audit-event queries instead of treating them as empty event lists.

## 0.2.0

- Added app and space selector support for `events`, `crashes`, and `watch`.
