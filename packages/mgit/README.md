# @saptools/mgit

Manage multiple Git repositories from a single CLI — run commands, view status, and organize repos into groups. Inspired by the Python [gita](https://github.com/nosarthur/gita) package.

## Installation

```bash
npm install -g @saptools/mgit
# or
pnpm add -g @saptools/mgit
```

## Updates

Every command first checks npm for a newer `@saptools/mgit` (at most once an hour, one small request
with a 2-second timeout) and, when one exists, installs that exact version with the package manager
that owns the running binary and re-runs the command you typed on the new version. Both steps are
announced on stderr; nothing is printed when the install is already current:

```text
mgit: updating 0.2.0 -> 0.3.0 ...
mgit: updated to 0.3.0; re-running the command
```

If the install cannot complete, one stderr line gives the manual command and the command runs on the
installed version; that version is not retried for a day. `mgit self-update` forces the check and
install now; `mgit self-update --check` only reports.

| Control | Effect |
| --- | --- |
| `SAPTOOLS_AUTO_UPDATE=on\|notify\|off` | `on` (default) installs and re-runs; `notify` prints the manual command once per version; `off` never checks. Applies to every `@saptools` CLI. |
| `MGIT_AUTO_UPDATE` | same values, this CLI only; wins over the global variable |
| `SAPTOOLS_UPDATE_INTERVAL_MINUTES` | minutes between checks (default `60`; `0` checks on every run) |
| `SAPTOOLS_NPM_REGISTRY` | registry to check and install from (default: npm's configured registry, then npmjs) |
| `SAPTOOLS_UPDATE_DEBUG=1` | explain on stderr why nothing happened |

The updater switches itself off in CI (`CI` set), under `NODE_ENV=test` or `NO_UPDATE_NOTIFIER`, when
the binary runs from a source checkout, an `npm link` or an `npx` cache, and inside the re-run itself.
It never writes to stdout, never asks for input, never uses `sudo`, and never moves onto a prerelease.
Its state lives in `~/.saptools/updates/`.

## Quick Start

```bash
# Register repositories
mgit add ~/projects/api
mgit add ~/projects/frontend -n web
mgit add ~/projects/infra

# View status of all repos at a glance
mgit ll

# Fetch all repos in parallel
mgit fetch

# Organize into groups
mgit group add api web -n fullstack
mgit group add infra -n ops

# Set a context so commands target only your group
mgit context fullstack
mgit fetch   # now only fetches "api" and "web"
```

## Commands

### Repository Management

| Command | Description |
|---------|-------------|
| `mgit add <path> [-n name] [-r]` | Register a repo; `-r` discovers all repos recursively |
| `mgit rm <name>` | Remove a repo from tracking |
| `mgit rename <old> <new>` | Rename a tracked repo |
| `mgit ls [group]` | List repo names (optionally filtered by group) |
| `mgit ll [repos/groups...]` | Show status table with branch, sync state, and flags |
| `mgit freeze` | Print current repos as a JSON clone manifest |
| `mgit clone -f <config.json>` | Clone repos from a JSON manifest and register them |

### Git Operations

| Command | Description |
|---------|-------------|
| `mgit fetch [repos/groups...]` | `git fetch --all --prune` in parallel |
| `mgit pull [repos/groups...]` | `git pull --ff-only` in parallel |
| `mgit push [repos/groups...]` | `git push` for specified repos |
| `mgit branch [repos/groups...] [-a]` | Show branches; `-a` includes remotes |
| `mgit super [repos...] -- <git-args>` | Run any git command across repos |
| `mgit shell [repos...] -- <command>` | Run any shell command inside each repo |

### Groups & Context

| Command | Description |
|---------|-------------|
| `mgit group add <repos...> -n <name>` | Create or update a group |
| `mgit group rm <name>` | Remove a group |
| `mgit group ls` | List all groups and their members |
| `mgit context [group]` | Show or set the active context group |
| `mgit context auto` | Auto-detect context from current directory |
| `mgit context ""` | Clear context (revert to all repos) |

## Status Display (`mgit ll`)

```
name     branch         sync    flags
──────────────────────────────────────────
api      main           ✓
web      feat/login     ↑2      +*
infra    main           ↓1      ?
legacy   hotfix         ⇕3/1
local    my-branch      ∅
```

**Sync symbols:**

| Symbol | Meaning |
|--------|---------|
| `✓` | In sync with remote |
| `↑N` | N commits ahead of remote |
| `↓N` | N commits behind remote |
| `⇕A/B` | Diverged (A ahead, B behind) |
| `∅` | No remote tracking branch |

**File flags:**

| Flag | Meaning |
|------|---------|
| `+` | Staged changes |
| `*` | Unstaged changes |
| `?` | Untracked files |
| `$` | Stashed changes |

## Super Command

Run any git command across multiple repos, using `--` to separate repo names from git arguments:

```bash
# Check out main in all repos
mgit super -- checkout main

# Reset to origin in specific repos
mgit super api web -- reset --hard origin/main

# Tag and push for a group
mgit super mygroup -- tag v1.0.0
mgit super mygroup -- push --tags
```

## Shell Command

Run arbitrary shell commands inside each repo directory:

```bash
# Install dependencies in all frontend repos
mgit shell frontend -- npm install

# Show disk usage of all repos
mgit shell -- du -sh .
```

## Clone Manifest

Export your current setup with `mgit freeze` and restore it elsewhere with `mgit clone`:

```bash
# Export
mgit freeze > repos.json
# Edit repos.json to add real git URLs

# Restore
mgit clone -f repos.json
```

**repos.json format:**
```json
[
  { "name": "api",      "url": "https://github.com/org/api.git",      "path": "~/projects/api" },
  { "name": "frontend", "url": "https://github.com/org/frontend.git",  "path": "~/projects/frontend" }
]
```

## Configuration

Config files are stored in `~/.config/mgit/` (XDG-compliant). Override with `MGIT_CONFIG_HOME`.

| File | Purpose |
|------|---------|
| `repos.json` | Registered repositories (name → path) |
| `groups.json` | Group definitions (name → member names) |
| `context.json` | Active context group |

## License

MIT
