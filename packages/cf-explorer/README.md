<div align="center">

# 🛰️ `@saptools/cf-explorer`

**Fast, safe Cloud Foundry runtime discovery for SAP BTP workflows.**

Find app roots, search deployed code, inspect line context, reuse SSH sessions,
and produce precise file/line candidates for people, scripts, and downstream
tools through a beautiful CLI and a typed Node.js API.

[![npm version](https://img.shields.io/npm/v/@saptools/cf-explorer.svg?style=for-the-badge&color=CB3837&logo=npm)](https://www.npmjs.com/package/@saptools/cf-explorer)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/types-TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![cloud foundry](https://img.shields.io/badge/Cloud%20Foundry-SSH-0C9ED5?style=for-the-badge)](https://docs.cloudfoundry.org/cf-cli/)

[Why](#-why) • [Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-typescript-api) • [Sessions](#-persistent-sessions) • [Safety](#-safety-model)

</div>

---

## ✨ Why

Cloud Foundry app exploration often starts with a slow, repetitive loop:

1. Open `cf ssh`.
2. Find where the deployed app actually lives.
3. Search filenames and content.
4. Inspect the exact runtime line.
5. Turn the match into a useful file/line location.
6. Repeat after every wrong guess.

`cf-explorer` turns that loop into a structured workflow:

- 🔎 **Discover** deployed app roots and runtime files.
- 🧭 **Map** grep results into reusable file/line candidates.
- ⚡ **Reuse** one SSH-backed session when many reads are needed.
- 🧩 **Import** the same behavior from another Node.js project.
- 🛡️ **Protect** the app by keeping file discovery read-only by default.

---

## 🚀 What It Does

| Capability | Purpose |
| --- | --- |
| `roots` | Locate likely app roots with bounded read-only probes |
| `instances` | Show app process instance indexes and status |
| `ls` | List direct children under a known remote directory |
| `find` | Search filenames under a remote root |
| `grep` | Search remote file content and return path + line |
| `view` | Print a bounded line window around a remote file location |
| `inspect-candidates` | Suggest candidate paths, line numbers, and root mappings |
| `session start` | Keep one SSH-backed broker alive for fast repeated reads |
| `ssh-status` / `enable-ssh` / `restart` | Explicit SSH lifecycle commands with confirmation |

---

## 📦 Install

```bash
npm install -g @saptools/cf-explorer
```

---

## 🔐 Credentials

`cf-explorer` uses the same environment variables as the other SAP tools
packages:

```bash
export SAP_EMAIL="user@example.com"
export SAP_PASSWORD="your-password"
```

Optional overrides:

```bash
export CF_EXPLORER_CF_BIN="/path/to/cf"
export CF_EXPLORER_HOME="$HOME/.saptools/cf-explorer"
```

Credential handling is intentionally conservative:

- credentials are resolved from env by default;
- `SAP_EMAIL` and `SAP_PASSWORD` are stripped from normal child-process env
  after resolution;
- `cf auth` should receive credentials through scoped child env variables;
- secrets, tokens, and remote file contents are not written to session state.

---

## ⚡ Quick Start

Find a root, search for code, inspect context, then reuse the location in your
next command, script, editor, or debugging tool.

```bash
cf-explorer roots \
  --region region-key \
  --org org-name \
  --space space-name \
  --app app-name
```

```bash
cf-explorer ls \
  --region region-key \
  --org org-name \
  --space space-name \
  --app app-name \
  --path /app-root
```

```bash
cf-explorer grep \
  --region region-key \
  --org org-name \
  --space space-name \
  --app app-name \
  --root /app-root \
  --text "needle"
```

```bash
cf-explorer view \
  --region region-key \
  --org org-name \
  --space space-name \
  --app app-name \
  --file /app-root/src/handler.js \
  --line 42 \
  --context 6
```

Generate reusable file/line candidates:

```bash
cf-explorer inspect-candidates \
  --region region-key \
  --org org-name \
  --space space-name \
  --app app-name \
  --text "needle"
```

---

## 🧰 CLI

All read/discovery commands accept:

| Flag | Description |
| --- | --- |
| `--region <key>` | CF region key resolved through the SAP tools region catalog |
| `--org <name>` | CF org |
| `--space <name>` | CF space |
| `--app <name>` | CF app |
| `--process <name>` | CF process name, default `web` |
| `--instance <index>` | One app process instance |
| `--all-instances` | Run supported read-only commands across running instances |
| `--timeout <seconds>` | Command timeout |
| `--max-files <count>` | Result limit for path-like outputs |
| `--max-bytes <bytes>` | Output byte limit |
| `--json` / `--no-json` | Structured JSON (default) or compact human-readable output |

### 🪄 Discovery

```bash
cf-explorer roots --region region-key --org org-name --space space-name --app app-name
cf-explorer instances --region region-key --org org-name --space space-name --app app-name
cf-explorer ls --region region-key --org org-name --space space-name --app app-name --path /app-root
cf-explorer find --region region-key --org org-name --space space-name --app app-name --root /app-root --name "*handler*.js"
cf-explorer grep --region region-key --org org-name --space space-name --app app-name --root /app-root --text "needle"
cf-explorer view --region region-key --org org-name --space space-name --app app-name --file /app-root/src/handler.js --line 42 --context 8
```

### 🎯 File/Line Candidates

```bash
cf-explorer inspect-candidates \
  --region region-key \
  --org org-name \
  --space space-name \
  --app app-name \
  --text "needle"
```

Suggested candidate shape:

```json
{
  "instance": 0,
  "bp": "/app-root/src/handler.js",
  "remoteRoot": "/app-root",
  "line": 42,
  "confidence": "high",
  "reason": "content match"
}
```

### 🔁 SSH Lifecycle

Lifecycle commands can change app state, so they are never run implicitly by
read-only discovery commands.

```bash
cf-explorer ssh-status --region region-key --org org-name --space space-name --app app-name
cf-explorer enable-ssh --region region-key --org org-name --space space-name --app app-name
cf-explorer restart --region region-key --org org-name --space space-name --app app-name
cf-explorer prepare-ssh --region region-key --org org-name --space space-name --app app-name
```

Use `--yes` only when you intentionally want non-interactive lifecycle changes:

```bash
cf-explorer prepare-ssh \
  --region region-key \
  --org org-name \
  --space space-name \
  --app app-name \
  --yes
```

---

## 🧵 Persistent Sessions

One-shot mode is simple: each CLI invocation opens a fresh `cf ssh`, runs one
bounded command, and exits. Persistent mode is for deeper exploration where that
round trip becomes the bottleneck.

```bash
cf-explorer session start \
  --region region-key \
  --org org-name \
  --space space-name \
  --app app-name \
  --instance 0

cf-explorer session list
cf-explorer session status --session-id <id>

cf-explorer session ls --session-id <id> --path /app-root
cf-explorer session grep --session-id <id> --root /app-root --text "needle"
cf-explorer session view --session-id <id> --file /app-root/src/handler.js --line 42

cf-explorer session stop --session-id <id>
```

### 🛰️ How Session Reuse Works

Persistent sessions use a local broker process:

```text
CLI command
  -> local IPC socket
    -> cf-explorer broker
      -> live cf ssh child process
        -> remote sh
```

The broker is the only process that owns the live SSH stdin/stdout streams.
`sessions.json` is only an index; it is not the command channel.

The broker:

- opens one `cf ssh --disable-pseudo-tty --process <process> -i <index> -c sh`;
- performs a startup handshake;
- accepts newline-delimited JSON requests over local IPC;
- validates each request against known explorer commands;
- queues one remote command at a time;
- wraps remote output in sentinel markers;
- enforces timeouts, output limits, and stale-session cleanup.

---

## 🧑‍💻 TypeScript API

```ts
import {
  attachExplorerSession,
  createExplorer,
  listExplorerSessions,
  startExplorerSession,
  stopExplorerSession,
} from "@saptools/cf-explorer";

const explorer = await createExplorer({
  target: {
    region: "region-key",
    org: "org-name",
    space: "space-name",
    app: "app-name",
  },
});

const rootsResult = await explorer.roots();
const root = rootsResult.roots[0] ?? "/app-root";
const entries = await explorer.ls({ path: root, instance: 0 });

const matches = await explorer.grep({
  root,
  text: "needle",
  instance: 0,
});

await explorer.dispose();
```

Broker-backed session:

```ts
const session = await startExplorerSession({
  target: {
    region: "region-key",
    org: "org-name",
    space: "space-name",
    app: "app-name",
  },
  instance: 0,
});

const attached = await attachExplorerSession(session.sessionId);
const entries = await attached.ls({ path: "/app-root" });
const result = await attached.grep({ root: "/app-root", text: "needle" });

await stopExplorerSession({ sessionId: session.sessionId });
```

Lifecycle APIs require explicit confirmation:

```ts
await explorer.prepareSsh({ confirmImpact: true });
await explorer.restartApp({ confirmImpact: true });
```

---

## 🛡️ Safety Model

`cf-explorer` is designed around a narrow safety boundary.

Read-only discovery commands:

- generate remote commands from templates;
- reject arbitrary shell text;
- quote user-provided values;
- reject NUL bytes, newlines, unsafe roots, and invalid instance selectors;
- enforce output, file, context, depth, and timeout limits;
- prune noisy folders such as `node_modules`, `.git`, `dist`, `build`, and
  `.cache`;
- omit grep previews unless explicitly requested. Preview and `view` output can
  contain remote file content, so it is returned only to the caller and is not
  stored in session state.

Explicit lifecycle commands:

- may run `cf enable-ssh` or `cf restart`;
- prompt for confirmation unless `--yes` is provided;
- are app-level operations, not per-instance operations;
- stop or mark related persistent sessions stale after restart.

No command uploads, edits, deletes, installs packages, changes permissions, or
opens an unrestricted interactive shell.

---

## 🗂️ Local State

All package-owned files live under:

```text
~/.saptools/cf-explorer/
  sessions.json
  sessions.lock
  sockets/
    <session-id>.sock
  cf-homes/
    <session-id>/
  tmp/
    <run-id>/
  logs/
```

Rules:

- `sessions.json` stores only non-secret session metadata.
- Persistent `CF_HOME` folders are treated as sensitive and removed on session
  stop.
- Temp files are deleted after one-shot workflows.
- Logs must not contain credentials or remote file contents.
- Stale sessions are pruned by hostname, broker PID, SSH PID, and socket health.

---

## 📤 JSON Output

Every JSON response includes metadata:

```ts
interface ExplorerMeta {
  target: {
    region: string;
    org: string;
    space: string;
    app: string;
  };
  instance?: number;
  durationMs: number;
  truncated: boolean;
}
```

Examples:

```json
{
  "meta": {
    "target": {
      "region": "region-key",
      "org": "org-name",
      "space": "space-name",
      "app": "app-name"
    },
    "instance": 0,
    "durationMs": 214,
    "truncated": false
  },
  "matches": [
    {
      "instance": 0,
      "path": "/app-root/src/handler.js",
      "line": 42
    }
  ]
}
```

---

## 🧯 Error Codes

| Code | Meaning |
| --- | --- |
| `MISSING_CREDENTIALS` | `SAP_EMAIL` or `SAP_PASSWORD` is missing |
| `UNKNOWN_REGION` | Region key is not known |
| `CF_LOGIN_FAILED` | `cf api` or `cf auth` failed |
| `CF_TARGET_FAILED` | `cf target` failed |
| `APP_NOT_FOUND` | Target app was not found |
| `SSH_DISABLED` | App SSH is not currently enabled |
| `INSTANCE_NOT_FOUND` | Requested app process instance is unavailable |
| `UNSAFE_INPUT` | Input failed validation |
| `OUTPUT_LIMIT_EXCEEDED` | Remote output exceeded configured limits |
| `REMOTE_COMMAND_FAILED` | A bounded remote command failed |
| `LIFECYCLE_CONFIRMATION_REQUIRED` | A state-changing command needs confirmation |
| `SESSION_NOT_FOUND` | The requested persistent session does not exist |
| `SESSION_STALE` | The persistent session is no longer usable |
| `SESSION_BUSY` | Persistent broker queue is full |
| `BROKER_UNAVAILABLE` | The broker process is not reachable |
| `IPC_FAILED` | Local IPC request failed |
| `SESSION_PROTOCOL_ERROR` | Persistent shell marker parsing failed |
| `SESSION_HANDSHAKE_FAILED` | Persistent shell startup handshake failed |
| `SESSION_RECOVERY_FAILED` | Broker could not recover the remote shell |
| `ABORTED` | The caller aborted the operation |

---

## 🤝 Related Packages

- [`@saptools/cf-debugger`](https://www.npmjs.com/package/@saptools/cf-debugger): opens Node debugging tunnels through CF SSH.
- [`@saptools/cf-files`](https://www.npmjs.com/package/@saptools/cf-files): reads CF env and pulls individual remote files.

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
