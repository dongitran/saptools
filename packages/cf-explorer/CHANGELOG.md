# Changelog

## Unreleased

## 0.2.10

### Maintenance

- Reorganized source modules into focused CLI, CF, discovery, broker, session,
  and core folders while preserving existing public imports and runtime
  behavior.

## 0.2.9

### Maintenance

- Split persistent SSH shell handling into a focused broker module with direct
  unit coverage, keeping persistent-session behavior unchanged.

## 0.2.8

### Maintenance

- Split CLI human-output rendering into a focused module with unit coverage,
  keeping command behavior unchanged while reducing the main CLI file size.

## 0.2.7

### Improvements

- Added root `--version` output for quick installed CLI checks.
- Added `session start --idle-timeout` and `--max-lifetime` flags to expose
  the existing broker timer controls from the CLI.

## 0.2.6

### Improvements

- Added read-only `ls` commands for one-level remote directory listings in
  one-shot and persistent-session workflows.

## 0.2.5

### Bug fixes

- Dropped incomplete trailing protocol rows from truncated one-shot remote
  output so partial paths are not reported as real discovery results.
- Parsed only the timestamp-like `since` column from detailed CF app instance
  rows instead of storing later resource columns in the same field.

### Improvements

- Added `--timeout` and `--max-bytes` to persistent-session read commands,
  matching the existing API and broker per-request limit support.

## 0.2.4

### Bug fixes

- Fixed `view` output on Cloud Foundry containers by emitting line protocol
  rows directly from `awk` instead of relying on `nl` separator behavior.
- Changed `session stop` to return structured JSON with a stopped-session
  count instead of a primitive number.
- Fixed a broker shutdown race that could leave a stale session lock after
  `session stop`.

## 0.2.3

### Bug fixes

- Classified CF command failures before redacting detail text, preserving typed
  errors when credential values overlap with CF error keywords.

### Hardening

- Added bounded IPC request/response buffering for persistent-session sockets.
- Validated broker bootstrap payloads before starting broker session work.

## 0.2.2

### Bug fixes

- Preserved explicit credential passwords exactly instead of trimming leading or
  trailing characters.
- Propagated timeout/output limits to `cf app` and lifecycle CF calls.
- Tightened malformed grep/protocol numeric parsing.

### Hardening

- Redacted generated one-shot SSH scripts from CF failure details.
- Validated CF runner timeout/output limits before spawning child processes.
- Handled persistent SSH shell spawn errors without an unhandled broker error.

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
