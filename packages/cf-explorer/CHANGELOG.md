# Changelog

## Unreleased

## 0.2.1

### Bug fixes

- Grep parsing now treats tab-delimited output as fixed fields, so preview text
  cannot be mistaken for the path or line delimiter.
- Persistent broker command failures now return typed IPC errors instead of
  escaping from stdout event handlers.
- Persistent sessions update `lastUsedAt` on broker requests.
- Session registration rejects duplicate explicit session ids.
- CF child-process collection now settles once across abort, timeout, spawn
  error, and close races.

## 0.2.0

### Bug fixes

- IPC server now drains every newline-terminated request in a single chunk
  instead of stopping after the first one (`src/ipc.ts`).
- Broker marks the session `stale` and shuts down when the persistent SSH
  shell exits or stderr reports `closed`, so `session list/status` no longer
  reports a dead session as `ready` (`src/broker.ts`).
- `runtime.timeoutMs` and `runtime.maxBytes` now propagate to `cf ssh` for
  one-shot discovery commands, not just to `cf api/auth/target`
  (`src/runner.ts`).
- `--no-json` produces concise human-readable output for every result shape
  instead of falling back to JSON (`src/cli.ts`).
- `INSTANCE_NOT_FOUND` is raised when `--all-instances` finds no running
  instances and when `cf ssh` reports an out-of-range index. The previously
  declared but unused error codes are now actually emitted (`src/api.ts`,
  `src/cf.ts`).
- `SESSION_HANDSHAKE_FAILED` is raised when the persistent shell handshake
  produces unexpected output or times out (`src/broker.ts`).
- Crashed-broker session files (`cf-homes/<id>` and `sockets/<id>.sock`) are
  cleaned up the next time `listExplorerSessions` prunes the index, instead
  of lingering indefinitely (`src/storage.ts`).
- `session start` CLI no longer accepts `--all-instances`, matching the API
  contract that persistent sessions target one instance (`src/cli.ts`).
- Broker stop responses are flushed to the socket before the process exits,
  removing a 10 ms race that could drop the response (`src/ipc.ts`,
  `src/broker.ts`).
- Legacy grep delimiter pattern uses non-greedy path matching so a colon in
  a preview no longer truncates the path (`src/parsers.ts`).

### Hardening

- The fallback Unix socket directory is now scoped to the current user
  (`/tmp/saptools-cf-explorer-<uid>/`) and is `chmod 0700` enforced after
  every IPC server bind, even when the directory pre-existed (`src/paths.ts`,
  `src/ipc.ts`).
- Broker process clears `SAP_EMAIL`, `SAP_PASSWORD`, `CF_USERNAME` and
  `CF_PASSWORD` from `process.env` after CF auth so they do not leak through
  `/proc/<pid>/environ` for the broker's lifetime (`src/broker.ts`,
  `src/cf.ts`).
- Redaction skips values shorter than 4 characters to prevent common-word
  passwords from corrupting unrelated text (`src/redaction.ts`).
- `terminateProcess` helper avoids self-kill and tolerates process-not-found race
  conditions when stopping broker sessions (`src/session.ts`).

### Performance

- `--all-instances` discovery commands share one prepared CF session across
  parallel SSH calls instead of authenticating again per instance (`src/api.ts`,
  `src/runner.ts`).
- Root-discovery `find / -maxdepth 4` now prunes noisy directories
  (`node_modules`, `.git`, `dist`, `build`, `.cache`, `tmp`, `temp`) before
  enumerating files (`src/commands.ts`).

### Cleanups

- Dropped the unused `RemoteScript.operation` field; remote scripts only
  expose the script body now (`src/commands.ts`).
- Coverage thresholds are gated by a documented exclusion list (broker, CLI,
  index barrel, type module). Session storage and target helpers now sit
  inside the gate (`vitest.config.ts`).

## 0.1.1

- Initial release.
