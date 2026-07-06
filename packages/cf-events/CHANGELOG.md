# Changelog

## 0.2.1

- Fixed `--since` and `--lookback` audit-event filters to send Cloud Foundry-compatible timestamps without fractional seconds.
- Surfaced Cloud Foundry API error responses from audit-event queries instead of treating them as empty event lists.

## 0.2.0

- Added app and space selector support for `events`, `crashes`, and `watch`.
