# @saptools/mgit

Manage multiple Git repositories from a single CLI — run commands, view status, and organize repos into groups. Inspired by the Python [gita](https://github.com/nosarthur/gita) package.

## Installation

```bash
npm install -g @saptools/mgit
# or
pnpm add -g @saptools/mgit
```

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
