<div align="center">

# 🚢 `@saptools/gitport`

**Port GitLab merge requests from repo A to repo B with real sequential `git cherry-pick -x`, preserving original commit authors and source traceability.**

Built for teams that need to move a whole MR from one related repository to another without hand-adding remotes, copying patches, or touching the current working directory.

[![status](https://img.shields.io/badge/status-MVP%20implemented-16a34a?style=flat)](#-status)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat)](#-license)

[Status](#-status) • [Install](#-install) • [Quick Start](#-quick-start) • [CLI](#-cli) • [API](#-programmatic-usage) • [How it works](#-how-it-works)

</div>

---

## ✨ Features

- 🔁 **Whole-MR porting** — fetches every commit from a source GitLab MR and replays them into a destination repo in order
- 🧬 **Real Git history** — uses actual `git cherry-pick -x` per commit, preserving the original author while recording source traceability
- 📝 **Draft MR by default** — always opens the destination MR as Draft, whether the port is clean or had incoming auto-resolved conflicts
- ⚖️ **Incoming conflict strategy** — when a cherry-pick conflicts, captures the old destination-side code, chooses incoming, and records the conflict in the Draft MR

---

## 📌 Status

`@saptools/gitport` is published on npm and maintained in the `saptools` monorepo.

---

## 📦 Install

```bash
npm install -g @saptools/gitport

# Or use it as a library
pnpm add @saptools/gitport
```

> [!NOTE]
> Requires **Node.js ≥ 20**, Git on `PATH`, and a GitLab token that can read the source repo, push to the destination repo, and create merge requests.

---

## 🚀 Quick Start

```bash
export GITPORT_GITLAB_TOKEN="<gitlab-token>"

gitport gitlab mr \
  --source-mr 123 \
  --source-repo https://gitlab.example.com/repo-a.git \
  --dest-repo https://gitlab.example.com/repo-b.git \
  --base-branch main
```

Gitport will clone the destination repo into an isolated run folder, fetch the source MR commits, replay them one by one with `git cherry-pick -x`, push the destination branch, and create a Draft GitLab MR. If `--port-branch` is omitted, Gitport creates a branch like `gitport/repo-a-mr-123`.

If a conflict happens, Gitport captures the destination-side and incoming-side conflict hunks, resolves the file with incoming by default, continues the cherry-pick, and records the conflict details in the Draft MR description. The MR diff also keeps the overwritten destination lines visible during review.

```bash
# Only needed if incoming cannot produce a valid commit
cd ~/.saptools/gitport/runs/<run-id>/dest
gitport continue
```

---

## 🧰 CLI

### 🔁 `gitport gitlab mr --source-mr <iid>`

Port one GitLab merge request from a source repo into a destination repo.

```bash
gitport gitlab mr \
  --source-mr 123 \
  --source-repo https://gitlab.example.com/repo-a.git \
  --dest-repo https://gitlab.example.com/repo-b.git \
  --base-branch main
```

| Flag | Description |
| --- | --- |
| `--source-mr <iid>` | **Required.** Source GitLab merge request IID, such as `123` for `!123` |
| `--source-repo <url>` | **Required.** GitLab repo URL that contains the source MR |
| `--dest-repo <url>` | **Required.** GitLab repo URL that receives the ported commits |
| `--base-branch <name>` | **Required.** Destination branch to create the port branch from |
| `--port-branch <name>` | New destination branch that receives the cherry-picks. Defaults to `gitport/<source-repo-name>-mr-<iid>` |
| `--token <token>` | GitLab token. Falls back to `GITPORT_GITLAB_TOKEN` |
| `--keep-workdir` | Keep the isolated run folder after a successful port |
| `--yes` | Skip interactive confirmation after the computed plan is shown |

### ▶️ `gitport continue`

Continue the latest conflicted run if incoming could not produce a valid commit and manual resolution was required.

```bash
gitport continue
gitport continue --run-id 20260429-103000-a1b2c3
```

### ⏹️ `gitport abort`

Abort a run and restore the destination worktree to the pre-port state.

```bash
gitport abort
gitport abort --run-id 20260429-103000-a1b2c3
```

---

## 🧑‍💻 Programmatic Usage

```ts
import { portGitLabMergeRequest } from "@saptools/gitport";

const result = await portGitLabMergeRequest({
  sourceRepo: "https://gitlab.example.com/repo-a.git",
  destRepo: "https://gitlab.example.com/repo-b.git",
  sourceMergeRequestIid: 123,
  baseBranch: "main",
  portBranch: "gitport/repo-a-mr-123",
  token: process.env.GITPORT_GITLAB_TOKEN,
});

console.log(result.mergeRequestUrl);
```

The CLI and library use the same porting engine. Library consumers can build custom review flows, batch jobs, internal dashboards, or agent workflows without shelling out to the CLI.

---

## 🔭 How it works

```
┌──────────────────────────┐
│ gitport gitlab mr        │
│   --source-mr 123        │
└─────────────┬────────────┘
              │
              ▼
  1. Resolve token from --token or GITPORT_GITLAB_TOKEN
  2. Read source MR metadata and commits from GitLab
  3. Clone destination repo into ~/.saptools/gitport/runs/<run-id>/dest
  4. Fetch the source repo as a temporary remote
  5. Create the port branch from --base-branch
  6. Run git cherry-pick -x <sha> once per source MR commit
  7. On conflict, capture ours/theirs hunks, choose incoming, and continue
  8. Push the destination branch
  9. Create the destination Draft MR and print its URL
 10. Write every auto-resolved conflict into the Draft MR description
```

### Commit identity

Git cherry-pick preserves the original commit **author**. The person or automation running Gitport becomes the **committer**, which is standard Git behavior and keeps the audit trail honest.

### Duplicate detection

Gitport compares patches, not only SHAs, because related repositories often have different commit IDs for the same change. It uses `git cherry` to skip already-ported changes safely.
GitLab commit lists are read with pagination, so large MRs are not truncated at the first 100 commits.

---

## 🛡️ Safety model

- Never modifies the current working repository
- Always creates the destination MR as Draft by default
- Skips patch-equivalent commits that already exist in the destination history
- Never writes GitLab tokens to reports, config files, command previews, or errors
- Auto-resolves cherry-pick conflicts with incoming by default, after capturing the old destination-side code for review
- Keeps conflicted run folders for manual recovery when incoming cannot produce a valid commit
- Cleans successful run folders unless `--keep-workdir` is set
- Blocks publishing unless typecheck, lint, unit tests, e2e tests, and build all pass

---

## 🛠️ Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @saptools/gitport typecheck
pnpm --filter @saptools/gitport lint
pnpm --filter @saptools/gitport test:unit
pnpm --filter @saptools/gitport test:e2e
pnpm --filter @saptools/gitport build
```

The e2e suite should use local fixture Git repositories and a mocked GitLab HTTP server. CI must not call real GitLab projects.

---

## 🗺️ Roadmap

- MVP: one source GitLab MR to one destination Draft MR with sequential cherry-picks
- Conflict flow: capture conflict hunks, choose incoming by default, report conflicts in Draft MR, support `continue` and `abort` for unresolved fallbacks
- Batch mode: port one MR to multiple destination repos
- Saved conflict rules: reuse known resolutions only when explicitly configured

---

## 👨‍💻 Author

**dongtran** ✨

## 📄 License

MIT

---

Made with ❤️ to make your work life easier!
